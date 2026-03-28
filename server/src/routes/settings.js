const express = require('express');
const { db } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/settings - return all settings for user
router.get('/', authenticate, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(req.user.id);
  const settings = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  res.json({ settings });
});

// PUT /api/settings - upsert single setting
router.put('/', authenticate, (req, res) => {
  const { key, value } = req.body;

  if (!key) return res.status(400).json({ error: 'Key is required' });

  const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value !== undefined ? value : '');

  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(req.user.id, key, serialized);

  res.json({ success: true, key, value });
});

// POST /api/settings/bulk - upsert multiple settings
router.post('/bulk', authenticate, (req, res) => {
  const { settings } = req.body;

  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Settings object is required' });
  }

  const upsert = db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);

  try {
    db.exec('BEGIN');
    for (const [key, value] of Object.entries(settings)) {
      const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value !== undefined ? value : '');
      upsert.run(req.user.id, key, serialized);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Error saving settings:', err);
    return res.status(500).json({ error: 'An internal error occurred' });
  }

  res.json({ success: true, updated: Object.keys(settings).length });
});

module.exports = router;
