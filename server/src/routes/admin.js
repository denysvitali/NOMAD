const express = require('express');
const bcrypt = require('bcryptjs');
const { execFileSync } = require('child_process');
const path = require('path');
const { db } = require('../db/database');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

// All admin routes require authentication and admin role
router.use(authenticate, adminOnly);

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at, last_login FROM users ORDER BY created_at DESC'
  ).all();
  // Add online status from WebSocket connections
  let onlineUserIds = new Set();
  try {
    const { getOnlineUserIds } = require('../websocket');
    onlineUserIds = getOnlineUserIds();
  } catch { /* */ }
  const usersWithStatus = users.map(u => ({ ...u, online: onlineUserIds.has(u.id) }));
  res.json({ users: usersWithStatus });
});

// POST /api/admin/users
router.post('/users', (req, res) => {
  const { username, email, password, role } = req.body;

  if (!username?.trim() || !email?.trim() || !password?.trim()) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existingUsername) return res.status(409).json({ error: 'Username already taken' });

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim());
  if (existingEmail) return res.status(409).json({ error: 'Email already taken' });

  const passwordHash = bcrypt.hashSync(password.trim(), 10);

  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(username.trim(), email.trim(), passwordHash, role || 'user');

  const user = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ user });
});

// PUT /api/admin/users/:id
router.put('/users/:id', (req, res) => {
  const { username, email, role, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);

  if (!user) return res.status(404).json({ error: 'User not found' });

  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (username && username !== user.username) {
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
    if (conflict) return res.status(409).json({ error: 'Username already taken' });
  }
  if (email && email !== user.email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.params.id);
    if (conflict) return res.status(409).json({ error: 'Email already taken' });
  }

  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;

  db.prepare(`
    UPDATE users SET
      username = COALESCE(?, username),
      email = COALESCE(?, email),
      role = COALESCE(?, role),
      password_hash = COALESCE(?, password_hash),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(username || null, email || null, role || null, passwordHash, req.params.id);

  const updated = db.prepare(
    'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(req.params.id);

  res.json({ user: updated });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete own account' });
  }

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const totalTrips = db.prepare('SELECT COUNT(*) as count FROM trips').get().count;
  const totalPlaces = db.prepare('SELECT COUNT(*) as count FROM places').get().count;
  const totalFiles = db.prepare('SELECT COUNT(*) as count FROM trip_files').get().count;

  res.json({ totalUsers, totalTrips, totalPlaces, totalFiles });
});

// GET /api/admin/oidc — get OIDC config
router.get('/oidc', (req, res) => {
  const get = (key) => db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value || '';
  res.json({
    issuer: get('oidc_issuer'),
    client_id: get('oidc_client_id'),
    client_secret: get('oidc_client_secret'),
    display_name: get('oidc_display_name'),
  });
});

// PUT /api/admin/oidc — update OIDC config
router.put('/oidc', (req, res) => {
  const { issuer, client_id, client_secret, display_name } = req.body;
  const set = (key, val) => db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val || '');
  set('oidc_issuer', issuer);
  set('oidc_client_id', client_id);
  set('oidc_client_secret', client_secret);
  set('oidc_display_name', display_name);
  res.json({ success: true });
});

// POST /api/admin/save-demo-baseline (demo mode only)
router.post('/save-demo-baseline', (req, res) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const { saveBaseline } = require('../demo/demo-reset');
    saveBaseline();
    res.json({ success: true, message: 'Demo baseline saved. Hourly resets will restore to this state.' });
  } catch (err) {
    console.error('Failed to save baseline:', err);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ── Version check ──────────────────────────────────────────

// Detect if running inside Docker
const isDocker = (() => {
  try {
    const fs = require('fs');
    return fs.existsSync('/.dockerenv') || (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));
  } catch { return false }
})();

router.get('/version-check', async (req, res) => {
  const { version: currentVersion } = require('../../package.json');
  try {
    const resp = await fetch(
      'https://api.github.com/repos/mauriceboe/NOMAD/releases/latest',
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'NOMAD-Server' } }
    );
    if (!resp.ok) return res.json({ current: currentVersion, latest: currentVersion, update_available: false });
    const data = await resp.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    const update_available = latest && latest !== currentVersion && compareVersions(latest, currentVersion) > 0;
    res.json({ current: currentVersion, latest, update_available, release_url: data.html_url || '', is_docker: isDocker });
  } catch {
    res.json({ current: currentVersion, latest: currentVersion, update_available: false, is_docker: isDocker });
  }
});

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// POST /api/admin/update — pull latest code, install deps, restart
router.post('/update', async (req, res) => {
  const rootDir = path.resolve(__dirname, '../../..');
  const serverDir = path.resolve(__dirname, '../..');
  const clientDir = path.join(rootDir, 'client');
  const steps = [];

  try {
    // 1. git pull
    execFileSync('git', ['pull', 'origin', 'main'], { cwd: rootDir, timeout: 60000, encoding: 'utf8' });
    steps.push({ step: 'git pull', success: true });

    // 2. npm install server
    execFileSync('npm', ['install', '--production'], { cwd: serverDir, timeout: 120000, encoding: 'utf8' });
    steps.push({ step: 'npm install (server)', success: true });

    // 3. npm install + build client (production only)
    if (process.env.NODE_ENV === 'production') {
      execFileSync('npm', ['install'], { cwd: clientDir, timeout: 120000, encoding: 'utf8' });
      execFileSync('npm', ['run', 'build'], { cwd: clientDir, timeout: 120000, encoding: 'utf8' });
      steps.push({ step: 'npm install + build (client)', success: true });
    }

    // Read new version
    delete require.cache[require.resolve('../../package.json')];
    const { version: newVersion } = require('../../package.json');
    steps.push({ step: 'version', version: newVersion });

    // 4. Send response before restart
    res.json({ success: true, steps, restarting: true });

    // 5. Graceful restart — exit and let process manager (Docker/systemd/pm2) restart
    setTimeout(() => {
      console.log('[Update] Restarting after update...');
      process.exit(0);
    }, 1000);
  } catch (err) {
    console.error('Update failed:', err);
    steps.push({ step: 'error', success: false });
    res.status(500).json({ success: false, steps });
  }
});

// ── Addons ─────────────────────────────────────────────────

router.get('/addons', (req, res) => {
  const addons = db.prepare('SELECT * FROM addons ORDER BY sort_order, id').all();
  res.json({ addons: addons.map(a => ({ ...a, enabled: !!a.enabled, config: JSON.parse(a.config || '{}') })) });
});

router.put('/addons/:id', (req, res) => {
  const addon = db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.id);
  if (!addon) return res.status(404).json({ error: 'Addon not found' });
  const { enabled, config } = req.body;
  if (enabled !== undefined) db.prepare('UPDATE addons SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  if (config !== undefined) db.prepare('UPDATE addons SET config = ? WHERE id = ?').run(JSON.stringify(config), req.params.id);
  const updated = db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.id);
  res.json({ addon: { ...updated, enabled: !!updated.enabled, config: JSON.parse(updated.config || '{}') } });
});

module.exports = router;
