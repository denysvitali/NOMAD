const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { authenticate, demoUploadBlock } = require('../middleware/auth');

const router = express.Router();
const { JWT_SECRET } = require('../config');

const BCRYPT_ROUNDS = 12;

const avatarDir = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const ALLOWED_AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!file.mimetype.startsWith('image/') || !ALLOWED_AVATAR_EXTS.includes(ext)) {
    return cb(new Error('Only .jpg, .jpeg, .png, .gif, .webp images are allowed'));
  }
  cb(null, true);
}});

const SAFE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip', '.mp4', '.mp3', '.wav', '.ogg', '.mov', '.avi'];

// Simple rate limiter
const loginAttempts = new Map();
function rateLimiter(maxAttempts, windowMs) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const record = loginAttempts.get(key);
    if (record && record.count >= maxAttempts && now - record.first < windowMs) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    if (!record || now - record.first >= windowMs) {
      loginAttempts.set(key, { count: 1, first: now });
    } else {
      record.count++;
    }
    next();
  };
}
const authLimiter = rateLimiter(10, 15 * 60 * 1000); // 10 attempts per 15 minutes

function avatarUrl(user) {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

function maskApiKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role, jti: uuidv4() },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// GET /api/auth/app-config (public — no auth needed)
router.get('/app-config', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get();
  const allowRegistration = userCount === 0 || (setting?.value ?? 'true') === 'true';
  const isDemo = process.env.DEMO_MODE === 'true';
  const { version } = require('../../package.json');
  const hasGoogleKey = !!db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get();
  const oidcDisplayName = db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_display_name'").get()?.value || null;
  const oidcConfigured = !!(
    db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_issuer'").get()?.value &&
    db.prepare("SELECT value FROM app_settings WHERE key = 'oidc_client_id'").get()?.value
  );
  res.json({
    allow_registration: isDemo ? false : allowRegistration,
    has_users: userCount > 0,
    version,
    has_maps_key: hasGoogleKey,
    oidc_configured: oidcConfigured,
    oidc_display_name: oidcConfigured ? (oidcDisplayName || 'SSO') : undefined,
    allowed_file_types: db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get()?.value || 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv',
    demo_mode: isDemo,
  });
});

// POST /api/auth/demo-login (demo mode only)
router.post('/demo-login', (req, res) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@nomad.app');
  if (!user) return res.status(500).json({ error: 'Demo user not found' });
  const token = generateToken(user);
  const { password_hash, maps_api_key, openweather_api_key, unsplash_api_key, aviation_api_key, ...safe } = user;
  res.json({ token, user: { ...safe, avatar_url: avatarUrl(user) } });
});

// POST /api/auth/register
router.post('/register', authLimiter, (req, res) => {
  const { username, email, password } = req.body;

  // Check if registration is allowed
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount > 0) {
    const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get();
    if (setting?.value === 'false') {
      return res.status(403).json({ error: 'Registration is disabled. Contact your administrator.' });
    }
  }

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)').get(email, username);
  if (existingUser) {
    return res.status(409).json({ error: 'A user with this email or username already exists' });
  }

  const password_hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  // First user becomes admin
  const isFirstUser = userCount === 0;
  const role = isFirstUser ? 'admin' : 'user';

  try {
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(username, email, password_hash, role);

    const user = { id: result.lastInsertRowid, username, email, role, avatar: null };
    const token = generateToken(user);

    res.status(201).json({ token, user: { ...user, avatar_url: null } });
  } catch (err) {
    console.error('Operation failed:', err);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const validPassword = bcrypt.compareSync(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = generateToken(user);
  const { password_hash, maps_api_key, openweather_api_key, unsplash_api_key, aviation_api_key, ...userWithoutSensitive } = user;

  res.json({ token, user: { ...userWithoutSensitive, avatar_url: avatarUrl(user) } });
});

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.decode(token);
    if (decoded?.jti && decoded?.exp) {
      const expiresAt = new Date(decoded.exp * 1000).toISOString();
      db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)').run(decoded.jti, expiresAt);
    }
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const user = db.prepare(
    'SELECT id, username, email, role, avatar, oidc_issuer, created_at FROM users WHERE id = ?'
  ).get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ user: { ...user, avatar_url: avatarUrl(user) } });
});

// PUT /api/auth/me/password
router.put('/me/password', authenticate, (req, res) => {
  if (process.env.DEMO_MODE === 'true' && req.user?.is_demo === 1) {
    return res.status(403).json({ error: 'Password change is disabled in demo mode.' });
  }
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, BCRYPT_ROUNDS);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);
  res.json({ success: true });
});

// DELETE /api/auth/me — delete own account
router.delete('/me', authenticate, (req, res) => {
  // Block demo user
  if (process.env.DEMO_MODE === 'true' && req.user?.is_demo === 1) {
    return res.status(403).json({ error: 'Account deletion is disabled in demo mode.' });
  }
  // Prevent deleting last admin
  if (req.user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin account' });
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  res.json({ success: true });
});

// PUT /api/auth/me/maps-key
router.put('/me/maps-key', authenticate, (req, res) => {
  const { maps_api_key } = req.body;

  db.prepare(
    'UPDATE users SET maps_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(maps_api_key || null, req.user.id);

  res.json({ success: true, maps_api_key: maskApiKey(maps_api_key || null) });
});

// PUT /api/auth/me/api-keys
router.put('/me/api-keys', authenticate, (req, res) => {
  const { maps_api_key, openweather_api_key, aviation_api_key } = req.body;

  const userKeys = db.prepare('SELECT maps_api_key, openweather_api_key, aviation_api_key FROM users WHERE id = ?').get(req.user.id);

  db.prepare(
    'UPDATE users SET maps_api_key = ?, openweather_api_key = ?, aviation_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(
    maps_api_key !== undefined ? (maps_api_key || null) : userKeys.maps_api_key,
    openweather_api_key !== undefined ? (openweather_api_key || null) : userKeys.openweather_api_key,
    aviation_api_key !== undefined ? (aviation_api_key || null) : userKeys.aviation_api_key,
    req.user.id
  );

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, aviation_api_key, avatar FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({ success: true, user: { ...updated, maps_api_key: maskApiKey(updated.maps_api_key), openweather_api_key: maskApiKey(updated.openweather_api_key), aviation_api_key: maskApiKey(updated.aviation_api_key), avatar_url: avatarUrl(updated) } });
});

// PUT /api/auth/me/settings
router.put('/me/settings', authenticate, (req, res) => {
  const { maps_api_key, openweather_api_key, aviation_api_key, username, email } = req.body;

  const updates = [];
  const params = [];

  if (maps_api_key !== undefined) { updates.push('maps_api_key = ?'); params.push(maps_api_key || null); }
  if (openweather_api_key !== undefined) { updates.push('openweather_api_key = ?'); params.push(openweather_api_key || null); }
  if (aviation_api_key !== undefined) { updates.push('aviation_api_key = ?'); params.push(aviation_api_key || null); }
  if (username !== undefined) { updates.push('username = ?'); params.push(username); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare(
    'SELECT id, username, email, role, maps_api_key, openweather_api_key, aviation_api_key, avatar FROM users WHERE id = ?'
  ).get(req.user.id);

  res.json({ success: true, user: { ...updated, maps_api_key: maskApiKey(updated.maps_api_key), openweather_api_key: maskApiKey(updated.openweather_api_key), aviation_api_key: maskApiKey(updated.aviation_api_key), avatar_url: avatarUrl(updated) } });
});

// GET /api/auth/me/settings (admin only — returns API keys)
router.get('/me/settings', authenticate, (req, res) => {
  const user = db.prepare(
    'SELECT role FROM users WHERE id = ?'
  ).get(req.user.id);
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const userKeys = db.prepare('SELECT maps_api_key, openweather_api_key, unsplash_api_key, aviation_api_key FROM users WHERE id = ?').get(req.user.id);
  res.json({ settings: { maps_api_key: maskApiKey(userKeys.maps_api_key), openweather_api_key: maskApiKey(userKeys.openweather_api_key), unsplash_api_key: maskApiKey(userKeys.unsplash_api_key), aviation_api_key: maskApiKey(userKeys.aviation_api_key) } });
});

// POST /api/auth/avatar — upload avatar
router.post('/avatar', authenticate, demoUploadBlock, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
  if (current && current.avatar) {
    const oldPath = path.join(avatarDir, current.avatar);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const filename = req.file.filename;
  db.prepare('UPDATE users SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(filename, req.user.id);

  const updated = db.prepare('SELECT id, username, email, role, avatar FROM users WHERE id = ?').get(req.user.id);
  res.json({ success: true, avatar_url: avatarUrl(updated) });
});

// DELETE /api/auth/avatar — remove avatar
router.delete('/avatar', authenticate, (req, res) => {
  const current = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
  if (current && current.avatar) {
    const filePath = path.join(avatarDir, current.avatar);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('UPDATE users SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.user.id);
  res.json({ success: true });
});

// GET /api/auth/users — list all users (for sharing/inviting)
router.get('/users', authenticate, (req, res) => {
  const users = db.prepare(
    'SELECT id, username, avatar FROM users WHERE id != ? ORDER BY username ASC'
  ).all(req.user.id);
  res.json({ users: users.map(u => ({ ...u, avatar_url: avatarUrl(u) })) });
});

// GET /api/auth/validate-keys (admin only)
router.get('/validate-keys', authenticate, async (req, res) => {
  const user = db.prepare('SELECT role, maps_api_key, openweather_api_key, aviation_api_key FROM users WHERE id = ?').get(req.user.id);
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const result = { maps: false, weather: false, aviation: false };

  // Test Google Maps Places API
  if (user.maps_api_key) {
    try {
      const mapsRes = await fetch(
        `https://places.googleapis.com/v1/places:searchText`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': user.maps_api_key,
            'X-Goog-FieldMask': 'places.displayName',
          },
          body: JSON.stringify({ textQuery: 'test' }),
        }
      );
      result.maps = mapsRes.status === 200;
    } catch (err) {
      result.maps = false;
    }
  }

  // Test OpenWeatherMap API
  if (user.openweather_api_key) {
    try {
      const weatherRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=London&appid=${user.openweather_api_key}`
      );
      result.weather = weatherRes.status === 200;
    } catch (err) {
      result.weather = false;
    }
  }

  // Test AeroDataBox API (flight data)
  if (user.aviation_api_key) {
    try {
      const aviationRes = await fetch(
        'https://aerodatabox.p.rapidapi.com/health/services/feeds',
        {
          headers: {
            'x-rapidapi-key': user.aviation_api_key,
            'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
          },
        }
      );
      result.aviation = aviationRes.status === 200;
    } catch (err) {
      result.aviation = false;
    }
  }

  res.json(result);
});

// PUT /api/auth/app-settings (admin only)
router.put('/app-settings', authenticate, (req, res) => {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const { allow_registration, allowed_file_types } = req.body;
  if (allow_registration !== undefined) {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('allow_registration', ?)").run(String(allow_registration));
  }
  if (allowed_file_types !== undefined) {
    const types = allowed_file_types.split(',').map(t => t.trim().toLowerCase());
    if (types.includes('*')) {
      return res.status(400).json({ error: 'Wildcard (*) is not allowed for file types' });
    }
    const invalid = types.filter(t => !SAFE_EXTENSIONS.includes(t.startsWith('.') ? t : '.' + t));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid file types: ${invalid.join(', ')}` });
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('allowed_file_types', ?)").run(String(allowed_file_types));
  }
  res.json({ success: true });
});

// GET /api/auth/travel-stats — aggregated travel statistics for current user
router.get('/travel-stats', authenticate, (req, res) => {
  const userId = req.user.id;

  // Get all places from user's trips (owned + shared)
  const places = db.prepare(`
    SELECT DISTINCT p.address, p.lat, p.lng
    FROM places p
    JOIN trips t ON p.trip_id = t.id
    LEFT JOIN trip_members tm ON t.id = tm.trip_id
    WHERE t.user_id = ? OR tm.user_id = ?
  `).all(userId, userId);

  // Get trip count + total days
  const tripStats = db.prepare(`
    SELECT COUNT(DISTINCT t.id) as trips,
           COUNT(DISTINCT d.id) as days
    FROM trips t
    LEFT JOIN days d ON d.trip_id = t.id
    LEFT JOIN trip_members tm ON t.id = tm.trip_id
    WHERE (t.user_id = ? OR tm.user_id = ?) AND t.is_archived = 0
  `).get(userId, userId);

  // Known country names (EN + DE)
  const KNOWN_COUNTRIES = new Set([
    'Japan', 'Germany', 'Deutschland', 'France', 'Frankreich', 'Italy', 'Italien', 'Spain', 'Spanien',
    'United States', 'USA', 'United Kingdom', 'UK', 'Thailand', 'Australia', 'Australien',
    'Canada', 'Kanada', 'Mexico', 'Mexiko', 'Brazil', 'Brasilien', 'China', 'India', 'Indien',
    'South Korea', 'Südkorea', 'Indonesia', 'Indonesien', 'Turkey', 'Türkei', 'Türkiye',
    'Greece', 'Griechenland', 'Portugal', 'Netherlands', 'Niederlande', 'Belgium', 'Belgien',
    'Switzerland', 'Schweiz', 'Austria', 'Österreich', 'Sweden', 'Schweden', 'Norway', 'Norwegen',
    'Denmark', 'Dänemark', 'Finland', 'Finnland', 'Poland', 'Polen', 'Czech Republic', 'Tschechien',
    'Czechia', 'Hungary', 'Ungarn', 'Croatia', 'Kroatien', 'Romania', 'Rumänien',
    'Ireland', 'Irland', 'Iceland', 'Island', 'New Zealand', 'Neuseeland',
    'Singapore', 'Singapur', 'Malaysia', 'Vietnam', 'Philippines', 'Philippinen',
    'Egypt', 'Ägypten', 'Morocco', 'Marokko', 'South Africa', 'Südafrika', 'Kenya', 'Kenia',
    'Argentina', 'Argentinien', 'Chile', 'Colombia', 'Kolumbien', 'Peru',
    'Russia', 'Russland', 'United Arab Emirates', 'UAE', 'Vereinigte Arabische Emirate',
    'Israel', 'Jordan', 'Jordanien', 'Taiwan', 'Hong Kong', 'Hongkong',
    'Cuba', 'Kuba', 'Costa Rica', 'Panama', 'Ecuador', 'Bolivia', 'Bolivien', 'Uruguay', 'Paraguay',
    'Luxembourg', 'Luxemburg', 'Malta', 'Cyprus', 'Zypern', 'Estonia', 'Estland',
    'Latvia', 'Lettland', 'Lithuania', 'Litauen', 'Slovakia', 'Slowakei', 'Slovenia', 'Slowenien',
    'Bulgaria', 'Bulgarien', 'Serbia', 'Serbien', 'Montenegro', 'Albania', 'Albanien',
    'Sri Lanka', 'Nepal', 'Cambodia', 'Kambodscha', 'Laos', 'Myanmar', 'Mongolia', 'Mongolei',
    'Saudi Arabia', 'Saudi-Arabien', 'Qatar', 'Katar', 'Oman', 'Bahrain', 'Kuwait',
    'Tanzania', 'Tansania', 'Ethiopia', 'Äthiopien', 'Nigeria', 'Ghana', 'Tunisia', 'Tunesien',
    'Dominican Republic', 'Dominikanische Republik', 'Jamaica', 'Jamaika',
    'Ukraine', 'Georgia', 'Georgien', 'Armenia', 'Armenien', 'Pakistan', 'Bangladesh', 'Bangladesch',
    'Senegal', 'Mozambique', 'Mosambik', 'Moldova', 'Moldawien', 'Belarus', 'Weißrussland',
  ]);

  // Extract countries from addresses — only accept known country names
  const countries = new Set();
  const cities = new Set();
  const coords = [];

  places.forEach(p => {
    if (p.lat && p.lng) coords.push({ lat: p.lat, lng: p.lng });
    if (p.address) {
      const parts = p.address.split(',').map(s => s.trim().replace(/\d{3,}/g, '').trim());
      for (const part of parts) {
        if (KNOWN_COUNTRIES.has(part)) { countries.add(part); break; }
      }
      // City: first part that's not the country and looks like a name (Latin chars, > 2 chars)
      const cityPart = parts.find(s => !KNOWN_COUNTRIES.has(s) && /^[A-Za-zÀ-ÿ\s-]{2,}$/.test(s));
      if (cityPart) cities.add(cityPart);
    }
  });

  res.json({
    countries: [...countries],
    cities: [...cities],
    coords,
    totalTrips: tripStats?.trips || 0,
    totalDays: tripStats?.days || 0,
    totalPlaces: places.length,
  });
});

module.exports = router;
