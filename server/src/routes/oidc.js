const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { db } = require('../db/database');
const { JWT_SECRET } = require('../config');

const router = express.Router();

// ---------------------------------------------------------------------------
// oidc_states table — created lazily on first use so that the DB proxy is
// already pointing at a live connection when this code runs.
// ---------------------------------------------------------------------------
let oidcTableReady = false;
function ensureOidcTable() {
  if (oidcTableReady) return;
  db.prepare(`CREATE TABLE IF NOT EXISTS oidc_states (
    state TEXT PRIMARY KEY,
    redirect_uri TEXT NOT NULL,
    nonce TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  oidcTableReady = true;
}

// ---------------------------------------------------------------------------
// State store helpers (SQLite-backed, replaces in-memory pendingStates Map)
// ---------------------------------------------------------------------------
function storeOidcState(state, redirectUri, nonce) {
  ensureOidcTable();
  // Clean up expired states first (older than 10 minutes)
  db.prepare("DELETE FROM oidc_states WHERE created_at < datetime('now', '-10 minutes')").run();
  db.prepare("INSERT INTO oidc_states (state, redirect_uri, nonce, created_at) VALUES (?, ?, ?, datetime('now'))").run(state, redirectUri, nonce);
}

function getAndDeleteOidcState(state) {
  ensureOidcTable();
  const row = db.prepare('SELECT * FROM oidc_states WHERE state = ?').get(state);
  if (row) {
    db.prepare('DELETE FROM oidc_states WHERE state = ?').run(state);
  }
  return row;
}

// ---------------------------------------------------------------------------
// In-memory one-time code store for safe token handoff (code → { token, createdAt })
// Avoids embedding JWTs in URL fragments (browser history / server log exposure).
// ---------------------------------------------------------------------------
const pendingTokens = new Map();
const TOKEN_CODE_TTL = 2 * 60 * 1000; // 2 minutes

// Clean up expired tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pendingTokens.entries()) {
    if (now > data.expires) pendingTokens.delete(code);
  }
}, 60000);

// ---------------------------------------------------------------------------
// Read OIDC config from app_settings
// ---------------------------------------------------------------------------
function getOidcConfig() {
  const get = (key) => db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value || null;
  const issuer = get('oidc_issuer');
  const clientId = get('oidc_client_id');
  const clientSecret = get('oidc_client_secret');
  const displayName = get('oidc_display_name') || 'SSO';
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer: issuer.replace(/\/+$/, ''), clientId, clientSecret, displayName };
}

// ---------------------------------------------------------------------------
// Cache discovery document
// ---------------------------------------------------------------------------
let discoveryCache = null;
let discoveryCacheTime = 0;
const DISCOVERY_TTL = 60 * 60 * 1000; // 1 hour

async function discover(issuer) {
  if (discoveryCache && Date.now() - discoveryCacheTime < DISCOVERY_TTL && discoveryCache._issuer === issuer) {
    return discoveryCache;
  }
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error('Failed to fetch OIDC discovery document');
  const doc = await res.json();

  // Validate required fields and enforce HTTPS in production
  const requiredFields = ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint'];
  for (const field of requiredFields) {
    if (!doc[field]) throw new Error(`OIDC discovery missing required field: ${field}`);
    if (process.env.NODE_ENV === 'production' && !doc[field].startsWith('https://')) {
      throw new Error(`OIDC discovery field ${field} must use HTTPS in production`);
    }
  }

  doc._issuer = issuer;
  discoveryCache = doc;
  discoveryCacheTime = Date.now();
  return doc;
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function frontendUrl(path) {
  const base = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173';
  return base + path;
}

// ---------------------------------------------------------------------------
// GET /api/auth/oidc/login — redirect to OIDC provider
// ---------------------------------------------------------------------------
router.get('/login', async (req, res) => {
  const config = getOidcConfig();
  if (!config) return res.status(400).json({ error: 'OIDC not configured' });

  try {
    const doc = await discover(config.issuer);
    const state = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');

    const baseUrl = process.env.NOMAD_BASE_URL || `${req.protocol}://${req.headers.host}`;
    const redirectUri = `${baseUrl}/api/auth/oidc/callback`;

    storeOidcState(state, redirectUri, nonce);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
    });

    res.redirect(`${doc.authorization_endpoint}?${params}`);
  } catch (err) {
    console.error('[OIDC] Login error:', err.message);
    res.status(500).json({ error: 'OIDC login failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/oidc/callback — handle provider callback
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const { code, state, error: oidcError } = req.query;

  if (oidcError) {
    console.error('[OIDC] Provider error:', oidcError);
    return res.redirect(frontendUrl('/login?oidc_error=' + encodeURIComponent(oidcError)));
  }

  if (!code || !state) {
    return res.redirect(frontendUrl('/login?oidc_error=missing_params'));
  }

  const pending = getAndDeleteOidcState(state);
  if (!pending) {
    return res.redirect(frontendUrl('/login?oidc_error=invalid_state'));
  }

  const config = getOidcConfig();
  if (!config) return res.redirect(frontendUrl('/login?oidc_error=not_configured'));

  try {
    const doc = await discover(config.issuer);

    const baseUrl = process.env.NOMAD_BASE_URL || `${req.protocol}://${req.headers.host}`;
    const redirectUri = `${baseUrl}/api/auth/oidc/callback`;

    // Exchange code for tokens
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[OIDC] Token exchange failed:', tokenData);
      return res.redirect(frontendUrl('/login?oidc_error=token_failed'));
    }

    // Get user info
    const userInfoRes = await fetch(doc.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    // Verify email is confirmed at the provider
    if (userInfo.email_verified === false) {
      return res.redirect(frontendUrl('/login?oidc_error=email_not_verified'));
    }

    if (!userInfo.email) {
      return res.redirect(frontendUrl('/login?oidc_error=no_email'));
    }

    // Verify nonce if an id_token was returned
    if (tokenData.id_token && pending.nonce) {
      try {
        const idTokenPayload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64url').toString('utf8'));
        if (idTokenPayload.nonce !== pending.nonce) {
          console.error('[OIDC] Nonce mismatch');
          return res.redirect(frontendUrl('/login?oidc_error=nonce_mismatch'));
        }
      } catch (nonceErr) {
        console.error('[OIDC] Failed to verify nonce:', nonceErr.message);
        return res.redirect(frontendUrl('/login?oidc_error=nonce_verification_failed'));
      }
    }

    const email = userInfo.email.toLowerCase();
    const name = userInfo.name || userInfo.preferred_username || email.split('@')[0];
    const sub = userInfo.sub;

    // Find existing user by OIDC sub or email
    let user = db.prepare('SELECT * FROM users WHERE oidc_sub = ? AND oidc_issuer = ?').get(sub, config.issuer);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
    }

    if (user) {
      // Existing user — link OIDC if not already linked
      if (!user.oidc_sub) {
        db.prepare('UPDATE users SET oidc_sub = ?, oidc_issuer = ? WHERE id = ?').run(sub, config.issuer, user.id);
      }
    } else {
      // New user — check if registration is allowed
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const isFirstUser = userCount === 0;

      if (!isFirstUser) {
        const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get();
        if (setting?.value === 'false') {
          return res.redirect(frontendUrl('/login?oidc_error=registration_disabled'));
        }
      }

      // Create user (first user = admin)
      const role = isFirstUser ? 'admin' : 'user';
      // Generate a random password hash (user won't use password login)
      const randomPass = crypto.randomBytes(32).toString('hex');
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(randomPass, 10);

      // Ensure unique username
      let username = name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 30) || 'user';
      const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
      if (existing) username = `${username}_${Date.now() % 10000}`;

      const result = db.prepare(
        'INSERT INTO users (username, email, password_hash, role, oidc_sub, oidc_issuer) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(username, email, hash, role, sub, config.issuer);

      user = { id: Number(result.lastInsertRowid), username, email, role };
    }

    // Update last login
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    // Issue a short-lived one-time code instead of embedding the JWT in the URL fragment.
    // This prevents the token from appearing in browser history or server access logs.
    const jwtToken = generateToken(user);
    const handoffCode = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + TOKEN_CODE_TTL;
    pendingTokens.set(handoffCode, { token: jwtToken, expires });

    res.redirect(frontendUrl(`/login?oidc_code=${handoffCode}`));
  } catch (err) {
    console.error('[OIDC] Callback error:', err);
    res.redirect(frontendUrl('/login?oidc_error=server_error'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/oidc/token — exchange one-time code for JWT
// The frontend calls this immediately after receiving the oidc_code query param.
// ---------------------------------------------------------------------------
router.post('/token', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  const entry = pendingTokens.get(code);
  if (!entry) return res.status(400).json({ error: 'Invalid or expired code' });

  // Enforce TTL and single-use
  if (Date.now() > entry.expires) {
    pendingTokens.delete(code);
    return res.status(400).json({ error: 'Code has expired' });
  }

  pendingTokens.delete(code);
  res.json({ token: entry.token });
});

module.exports = router;
