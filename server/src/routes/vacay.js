const express = require('express');
const { db } = require('../db/database');
const { authenticate } = require('../middleware/auth');

// In-memory cache for holiday API results (key: "year-country", ttl: 24h)
const holidayCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

const router = express.Router();
router.use(authenticate);

// Broadcast vacay updates to all users in the same plan (exclude only the triggering socket, not the whole user)
function notifyPlanUsers(planId, excludeSid, event = 'vacay:update') {
  try {
    const { broadcastToUser } = require('../websocket');
    const plan = db.prepare('SELECT owner_id FROM vacay_plans WHERE id = ?').get(planId);
    if (!plan) return;
    const userIds = [plan.owner_id];
    const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(planId);
    members.forEach(m => userIds.push(m.user_id));
    userIds.forEach(id => broadcastToUser(id, { type: event }, excludeSid));
  } catch { /* */ }
}

// ── Helpers ────────────────────────────────────────────────

// Get or create the user's own plan
function getOwnPlan(userId) {
  let plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?').get(userId);
  if (!plan) {
    db.prepare('INSERT INTO vacay_plans (owner_id) VALUES (?)').run(userId);
    plan = db.prepare('SELECT * FROM vacay_plans WHERE owner_id = ?').get(userId);
    const yr = new Date().getFullYear();
    db.prepare('INSERT OR IGNORE INTO vacay_years (plan_id, year) VALUES (?, ?)').run(plan.id, yr);
    // Create user config for current year
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(userId, plan.id, yr);
  }
  return plan;
}

// Get the plan the user is currently part of (own or fused)
function getActivePlan(userId) {
  // Check if user has accepted a fusion
  const membership = db.prepare(`
    SELECT plan_id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'
  `).get(userId);
  if (membership) {
    return db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(membership.plan_id);
  }
  return getOwnPlan(userId);
}

function getActivePlanId(userId) {
  return getActivePlan(userId).id;
}

// Get all users in a plan (owner + accepted members)
function getPlanUsers(planId) {
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId);
  if (!plan) return [];
  const owner = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(plan.owner_id);
  const members = db.prepare(`
    SELECT u.id, u.username, u.email FROM vacay_plan_members m
    JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'accepted'
  `).all(planId);
  return [owner, ...members];
}

// ── Plan ───────────────────────────────────────────────────

router.get('/plan', (req, res) => {
  const plan = getActivePlan(req.user.id);
  const activePlanId = plan.id;

  // Get user colors
  const users = getPlanUsers(activePlanId).map(u => {
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, activePlanId);
    return { ...u, color: colorRow?.color || '#6366f1' };
  });

  // Pending invites (sent from this plan)
  const pendingInvites = db.prepare(`
    SELECT m.id, m.user_id, u.username, u.email, m.created_at
    FROM vacay_plan_members m JOIN users u ON m.user_id = u.id
    WHERE m.plan_id = ? AND m.status = 'pending'
  `).all(activePlanId);

  // Pending invites FOR this user (from others)
  const incomingInvites = db.prepare(`
    SELECT m.id, m.plan_id, u.username, u.email, m.created_at
    FROM vacay_plan_members m
    JOIN vacay_plans p ON m.plan_id = p.id
    JOIN users u ON p.owner_id = u.id
    WHERE m.user_id = ? AND m.status = 'pending'
  `).all(req.user.id);

  res.json({
    plan: {
      ...plan,
      block_weekends: !!plan.block_weekends,
      holidays_enabled: !!plan.holidays_enabled,
      company_holidays_enabled: !!plan.company_holidays_enabled,
      carry_over_enabled: !!plan.carry_over_enabled,
    },
    users,
    pendingInvites,
    incomingInvites,
    isOwner: plan.owner_id === req.user.id,
    isFused: users.length > 1,
  });
});

router.put('/plan', async (req, res) => {
  const planId = getActivePlanId(req.user.id);
  const { block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled } = req.body;

  const updates = [];
  const params = [];
  if (block_weekends !== undefined) { updates.push('block_weekends = ?'); params.push(block_weekends ? 1 : 0); }
  if (holidays_enabled !== undefined) { updates.push('holidays_enabled = ?'); params.push(holidays_enabled ? 1 : 0); }
  if (holidays_region !== undefined) { updates.push('holidays_region = ?'); params.push(holidays_region); }
  if (company_holidays_enabled !== undefined) { updates.push('company_holidays_enabled = ?'); params.push(company_holidays_enabled ? 1 : 0); }

  if (carry_over_enabled !== undefined) { updates.push('carry_over_enabled = ?'); params.push(carry_over_enabled ? 1 : 0); }

  if (updates.length > 0) {
    params.push(planId);
    db.prepare(`UPDATE vacay_plans SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  // If company holidays re-enabled, remove vacation entries that overlap with company holidays
  if (company_holidays_enabled === true) {
    const companyDates = db.prepare('SELECT date FROM vacay_company_holidays WHERE plan_id = ?').all(planId);
    for (const { date } of companyDates) {
      db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, date);
    }
  }

  // If public holidays enabled (or region changed), remove vacation entries that land on holidays
  // Only if a full region is selected (for countries that require it)
  const updatedPlan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId);
  if (updatedPlan.holidays_enabled && updatedPlan.holidays_region) {
    const country = updatedPlan.holidays_region.split('-')[0];
    const region = updatedPlan.holidays_region.includes('-') ? updatedPlan.holidays_region : null;
    const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(planId);
    for (const { year } of years) {
      try {
        if (!/^\d{4}$/.test(String(year))) continue;
        if (!/^[A-Z]{2}$/i.test(country)) continue;
        const cacheKey = `${year}-${country}`;
        let holidays = holidayCache.get(cacheKey)?.data;
        if (!holidays) {
          const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
          holidays = await resp.json();
          holidayCache.set(cacheKey, { data: holidays, time: Date.now() });
        }
        const hasRegions = holidays.some(h => h.counties && h.counties.length > 0);
        // If country has regions but no region selected, skip cleanup
        if (hasRegions && !region) continue;
        for (const h of holidays) {
          if (h.global || !h.counties || (region && h.counties.includes(region))) {
            db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, h.date);
            db.prepare('DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').run(planId, h.date);
          }
        }
      } catch { /* API error, skip */ }
    }
  }

  // If carry-over was just disabled, reset all carried_over values to 0
  if (carry_over_enabled === false) {
    db.prepare('UPDATE vacay_user_years SET carried_over = 0 WHERE plan_id = ?').run(planId);
  }

  // If carry-over was just enabled, recalculate all years
  if (carry_over_enabled === true) {
    const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId);
    const users = getPlanUsers(planId);
    for (let i = 0; i < years.length - 1; i++) {
      const yr = years[i].year;
      const nextYr = years[i + 1].year;
      for (const u of users) {
        const used = db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, planId, `${yr}-%`).count;
        const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, yr);
        const total = (config ? config.vacation_days : 30) + (config ? config.carried_over : 0);
        const carry = Math.max(0, total - used);
        db.prepare(`
          INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
          ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
        `).run(u.id, planId, nextYr, carry, carry);
      }
    }
  }

  notifyPlanUsers(planId, req.headers['x-socket-id'], 'vacay:settings');

  const updated = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId);
  res.json({
    plan: { ...updated, block_weekends: !!updated.block_weekends, holidays_enabled: !!updated.holidays_enabled, company_holidays_enabled: !!updated.company_holidays_enabled, carry_over_enabled: !!updated.carry_over_enabled }
  });
});

// ── User color ─────────────────────────────────────────────

router.put('/color', (req, res) => {
  const { color, target_user_id } = req.body;
  const planId = getActivePlanId(req.user.id);
  const userId = target_user_id ? parseInt(target_user_id) : req.user.id;
  const planUsers = getPlanUsers(planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  db.prepare(`
    INSERT INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)
    ON CONFLICT(user_id, plan_id) DO UPDATE SET color = excluded.color
  `).run(userId, planId, color || '#6366f1');
  notifyPlanUsers(planId, req.headers['x-socket-id'], 'vacay:update');
  res.json({ success: true });
});

// ── Invite / Accept / Decline / Dissolve ───────────────────

// Invite a user
router.post('/invite', (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (user_id === req.user.id) return res.status(400).json({ error: 'Cannot invite yourself' });

  const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(user_id);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const plan = getActivePlan(req.user.id);

  // Check if already invited or member
  const existing = db.prepare('SELECT id, status FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?').get(plan.id, user_id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Already fused' });
    if (existing.status === 'pending') return res.status(400).json({ error: 'Invite already pending' });
  }

  // Check if target user is already fused with someone else
  const targetFusion = db.prepare("SELECT id FROM vacay_plan_members WHERE user_id = ? AND status = 'accepted'").get(user_id);
  if (targetFusion) return res.status(400).json({ error: 'User is already fused with another plan' });

  db.prepare('INSERT INTO vacay_plan_members (plan_id, user_id, status) VALUES (?, ?, ?)').run(plan.id, user_id, 'pending');

  // Broadcast via WebSocket if available
  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(user_id, {
      type: 'vacay:invite',
      from: { id: req.user.id, username: req.user.username },
      planId: plan.id,
    });
  } catch { /* websocket not available */ }

  res.json({ success: true });
});

// Accept invite
router.post('/invite/accept', (req, res) => {
  const { plan_id } = req.body;
  const invite = db.prepare("SELECT * FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").get(plan_id, req.user.id);
  if (!invite) return res.status(404).json({ error: 'No pending invite' });

  // Accept
  db.prepare("UPDATE vacay_plan_members SET status = 'accepted' WHERE id = ?").run(invite.id);

  // Migrate user's own entries into the fused plan
  const ownPlan = db.prepare('SELECT id FROM vacay_plans WHERE owner_id = ?').get(req.user.id);
  if (ownPlan && ownPlan.id !== plan_id) {
    // Move entries
    db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(plan_id, ownPlan.id, req.user.id);
    // Copy year configs
    const ownYears = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ?').all(req.user.id, ownPlan.id);
    for (const y of ownYears) {
      db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, ?)').run(req.user.id, plan_id, y.year, y.vacation_days, y.carried_over);
    }
    // Copy color
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(req.user.id, ownPlan.id);
    if (colorRow) {
      db.prepare('INSERT OR IGNORE INTO vacay_user_colors (user_id, plan_id, color) VALUES (?, ?, ?)').run(req.user.id, plan_id, colorRow.color);
    }
  }

  // Auto-change color if it collides with existing plan users
  const COLORS = ['#6366f1','#ec4899','#14b8a6','#8b5cf6','#ef4444','#3b82f6','#22c55e','#06b6d4','#f43f5e','#a855f7','#10b981','#0ea5e9','#64748b','#be185d','#0d9488'];
  const existingColors = db.prepare('SELECT color FROM vacay_user_colors WHERE plan_id = ? AND user_id != ?').all(plan_id, req.user.id).map(r => r.color);
  const myColor = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(req.user.id, plan_id);
  if (myColor && existingColors.includes(myColor.color)) {
    const available = COLORS.find(c => !existingColors.includes(c));
    if (available) {
      db.prepare('UPDATE vacay_user_colors SET color = ? WHERE user_id = ? AND plan_id = ?').run(available, req.user.id, plan_id);
    }
  }

  // Ensure years exist in target plan
  const targetYears = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ?').all(plan_id);
  for (const y of targetYears) {
    db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, 0)').run(req.user.id, plan_id, y.year);
  }

  // Notify all plan users (not just owner)
  notifyPlanUsers(plan_id, req.headers['x-socket-id'], 'vacay:accepted');

  res.json({ success: true });
});

// Decline invite
router.post('/invite/decline', (req, res) => {
  const { plan_id } = req.body;
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(plan_id, req.user.id);

  notifyPlanUsers(plan_id, req.headers['x-socket-id'], 'vacay:declined');

  res.json({ success: true });
});

// Cancel pending invite (by inviter)
router.post('/invite/cancel', (req, res) => {
  const { user_id } = req.body;
  const plan = getActivePlan(req.user.id);
  db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ? AND status = 'pending'").run(plan.id, user_id);

  try {
    const { broadcastToUser } = require('../websocket');
    broadcastToUser(user_id, { type: 'vacay:cancelled' });
  } catch { /* */ }

  res.json({ success: true });
});

// Dissolve fusion
router.post('/dissolve', (req, res) => {
  const plan = getActivePlan(req.user.id);
  const isOwner = plan.owner_id === req.user.id;

  // Collect all user IDs and company holidays before dissolving
  const allUserIds = getPlanUsers(plan.id).map(u => u.id);
  const companyHolidays = db.prepare('SELECT date, note FROM vacay_company_holidays WHERE plan_id = ?').all(plan.id);

  if (isOwner) {
    const members = db.prepare("SELECT user_id FROM vacay_plan_members WHERE plan_id = ? AND status = 'accepted'").all(plan.id);
    for (const m of members) {
      const memberPlan = getOwnPlan(m.user_id);
      db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(memberPlan.id, plan.id, m.user_id);
      // Copy company holidays to member's own plan
      for (const ch of companyHolidays) {
        db.prepare('INSERT OR IGNORE INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(memberPlan.id, ch.date, ch.note);
      }
    }
    db.prepare('DELETE FROM vacay_plan_members WHERE plan_id = ?').run(plan.id);
  } else {
    const ownPlan = getOwnPlan(req.user.id);
    db.prepare('UPDATE vacay_entries SET plan_id = ? WHERE plan_id = ? AND user_id = ?').run(ownPlan.id, plan.id, req.user.id);
    // Copy company holidays to own plan
    for (const ch of companyHolidays) {
      db.prepare('INSERT OR IGNORE INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(ownPlan.id, ch.date, ch.note);
    }
    db.prepare("DELETE FROM vacay_plan_members WHERE plan_id = ? AND user_id = ?").run(plan.id, req.user.id);
  }

  // Notify all former plan members
  try {
    const { broadcastToUser } = require('../websocket');
    allUserIds.filter(id => id !== req.user.id).forEach(id => broadcastToUser(id, { type: 'vacay:dissolved' }));
  } catch { /* */ }

  res.json({ success: true });
});

// ── Available users to invite ──────────────────────────────

router.get('/available-users', (req, res) => {
  const planId = getActivePlanId(req.user.id);
  // All users except: self, already in this plan, already fused elsewhere
  const users = db.prepare(`
    SELECT u.id, u.username, u.email FROM users u
    WHERE u.id != ?
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE plan_id = ?)
    AND u.id NOT IN (SELECT user_id FROM vacay_plan_members WHERE status = 'accepted')
    AND u.id NOT IN (SELECT owner_id FROM vacay_plans WHERE id IN (
      SELECT plan_id FROM vacay_plan_members WHERE status = 'accepted'
    ))
    ORDER BY u.username
  `).all(req.user.id, planId);
  res.json({ users });
});

// ── Years ──────────────────────────────────────────────────

router.get('/years', (req, res) => {
  const planId = getActivePlanId(req.user.id);
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId);
  res.json({ years: years.map(y => y.year) });
});

router.post('/years', (req, res) => {
  const { year } = req.body;
  if (!year) return res.status(400).json({ error: 'Year required' });
  const planId = getActivePlanId(req.user.id);
  try {
    db.prepare('INSERT INTO vacay_years (plan_id, year) VALUES (?, ?)').run(planId, year);
    const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId);
    const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
    const users = getPlanUsers(planId);
    for (const u of users) {
      // Calculate carry-over from previous year if enabled
      let carriedOver = 0;
      if (carryOverEnabled) {
        const prevConfig = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year - 1);
        if (prevConfig) {
          const used = db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, planId, `${year - 1}-%`).count;
          const total = prevConfig.vacation_days + prevConfig.carried_over;
          carriedOver = Math.max(0, total - used);
        }
      }
      db.prepare('INSERT OR IGNORE INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)').run(u.id, planId, year, carriedOver);
    }
  } catch { /* exists */ }
  notifyPlanUsers(planId, req.headers['x-socket-id'], 'vacay:settings');
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId);
  res.json({ years: years.map(y => y.year) });
});

router.delete('/years/:year', (req, res) => {
  const year = parseInt(req.params.year);
  const planId = getActivePlanId(req.user.id);
  db.prepare('DELETE FROM vacay_years WHERE plan_id = ? AND year = ?').run(planId, year);
  db.prepare("DELETE FROM vacay_entries WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  db.prepare("DELETE FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").run(planId, `${year}-%`);
  notifyPlanUsers(planId, req.headers['x-socket-id'], 'vacay:settings');
  const years = db.prepare('SELECT year FROM vacay_years WHERE plan_id = ? ORDER BY year').all(planId);
  res.json({ years: years.map(y => y.year) });
});

// ── Entries ────────────────────────────────────────────────

router.get('/entries/:year', (req, res) => {
  const year = req.params.year;
  const planId = getActivePlanId(req.user.id);
  const entries = db.prepare(`
    SELECT e.*, u.username as person_name, COALESCE(c.color, '#6366f1') as person_color
    FROM vacay_entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN vacay_user_colors c ON c.user_id = e.user_id AND c.plan_id = e.plan_id
    WHERE e.plan_id = ? AND e.date LIKE ?
  `).all(planId, `${year}-%`);
  const companyHolidays = db.prepare("SELECT * FROM vacay_company_holidays WHERE plan_id = ? AND date LIKE ?").all(planId, `${year}-%`);
  res.json({ entries, companyHolidays });
});

router.post('/entries/toggle', (req, res) => {
  const { date, target_user_id } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const planId = getActivePlanId(req.user.id);
  // Allow toggling for another user if they are in the same plan
  let userId = req.user.id;
  if (target_user_id && parseInt(target_user_id) !== req.user.id) {
    const planUsers = getPlanUsers(planId);
    const tid = parseInt(target_user_id);
    if (!planUsers.find(u => u.id === tid)) {
      return res.status(403).json({ error: 'User not in plan' });
    }
    userId = tid;
  }
  const existing = db.prepare('SELECT id FROM vacay_entries WHERE user_id = ? AND date = ? AND plan_id = ?').get(userId, date, planId);
  if (existing) {
    db.prepare('DELETE FROM vacay_entries WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, req.headers['x-socket-id']);
    res.json({ action: 'removed' });
  } else {
    db.prepare('INSERT INTO vacay_entries (plan_id, user_id, date, note) VALUES (?, ?, ?, ?)').run(planId, userId, date, '');
    notifyPlanUsers(planId, req.headers['x-socket-id']);
    res.json({ action: 'added' });
  }
});

router.post('/entries/company-holiday', (req, res) => {
  const { date, note } = req.body;
  const planId = getActivePlanId(req.user.id);
  const existing = db.prepare('SELECT id FROM vacay_company_holidays WHERE plan_id = ? AND date = ?').get(planId, date);
  if (existing) {
    db.prepare('DELETE FROM vacay_company_holidays WHERE id = ?').run(existing.id);
    notifyPlanUsers(planId, req.headers['x-socket-id']);
    res.json({ action: 'removed' });
  } else {
    db.prepare('INSERT INTO vacay_company_holidays (plan_id, date, note) VALUES (?, ?, ?)').run(planId, date, note || '');
    // Remove any vacation entries on this date
    db.prepare('DELETE FROM vacay_entries WHERE plan_id = ? AND date = ?').run(planId, date);
    notifyPlanUsers(planId, req.headers['x-socket-id']);
    res.json({ action: 'added' });
  }
});

// ── Stats ──────────────────────────────────────────────────

router.get('/stats/:year', (req, res) => {
  const year = parseInt(req.params.year);
  const planId = getActivePlanId(req.user.id);
  const plan = db.prepare('SELECT * FROM vacay_plans WHERE id = ?').get(planId);
  const carryOverEnabled = plan ? !!plan.carry_over_enabled : true;
  const users = getPlanUsers(planId);

  const stats = users.map(u => {
    const used = db.prepare("SELECT COUNT(*) as count FROM vacay_entries WHERE user_id = ? AND plan_id = ? AND date LIKE ?").get(u.id, planId, `${year}-%`).count;
    const config = db.prepare('SELECT * FROM vacay_user_years WHERE user_id = ? AND plan_id = ? AND year = ?').get(u.id, planId, year);
    const vacationDays = config ? config.vacation_days : 30;
    const carriedOver = carryOverEnabled ? (config ? config.carried_over : 0) : 0;
    const total = vacationDays + carriedOver;
    const remaining = total - used;
    const colorRow = db.prepare('SELECT color FROM vacay_user_colors WHERE user_id = ? AND plan_id = ?').get(u.id, planId);

    // Auto-update carry-over into next year (only if enabled)
    const nextYearExists = db.prepare('SELECT id FROM vacay_years WHERE plan_id = ? AND year = ?').get(planId, year + 1);
    if (nextYearExists && carryOverEnabled) {
      const carry = Math.max(0, remaining);
      db.prepare(`
        INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, 30, ?)
        ON CONFLICT(user_id, plan_id, year) DO UPDATE SET carried_over = ?
      `).run(u.id, planId, year + 1, carry, carry);
    }

    return {
      user_id: u.id, person_name: u.username, person_color: colorRow?.color || '#6366f1',
      year, vacation_days: vacationDays, carried_over: carriedOver,
      total_available: total, used, remaining,
    };
  });

  res.json({ stats });
});

// Update vacation days for a year (own or fused partner)
router.put('/stats/:year', (req, res) => {
  const year = parseInt(req.params.year);
  const { vacation_days, target_user_id } = req.body;
  const planId = getActivePlanId(req.user.id);
  const userId = target_user_id ? parseInt(target_user_id) : req.user.id;
  const planUsers = getPlanUsers(planId);
  if (!planUsers.find(u => u.id === userId)) {
    return res.status(403).json({ error: 'User not in plan' });
  }
  db.prepare(`
    INSERT INTO vacay_user_years (user_id, plan_id, year, vacation_days, carried_over) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_id, plan_id, year) DO UPDATE SET vacation_days = excluded.vacation_days
  `).run(userId, planId, year, vacation_days);
  notifyPlanUsers(planId, req.headers['x-socket-id']);
  res.json({ success: true });
});

// ── Public Holidays API (proxy to Nager.Date) ─────────────

router.get('/holidays/countries', async (req, res) => {
  const cacheKey = 'countries';
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return res.json(cached.data);
  try {
    const resp = await fetch('https://date.nager.at/api/v3/AvailableCountries');
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Failed to fetch countries' });
  }
});

router.get('/holidays/:year/:country', async (req, res) => {
  const { year, country } = req.params;
  if (!/^\d{4}$/.test(String(year))) return res.status(400).json({ error: 'Invalid year' });
  if (!/^[A-Z]{2}$/i.test(country)) return res.status(400).json({ error: 'Invalid country code' });
  const cacheKey = `${year}-${country}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return res.json(cached.data);
  try {
    const resp = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    const data = await resp.json();
    holidayCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch {
    res.status(502).json({ error: 'Failed to fetch holidays' });
  }
});

module.exports = router;
