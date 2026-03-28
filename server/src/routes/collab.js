const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const dns = require('dns');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const { db, canAccessTrip } = require('../db/database');
const { authenticate, demoUploadBlock } = require('../middleware/auth');
const { broadcast } = require('../websocket');

const dnsLookup = promisify(dns.lookup);

const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.dll', '.com', '.scr', '.pif', '.vbs', '.js', '.wsh', '.wsf', '.html', '.htm', '.svg', '.xml', '.xhtml'];

const filesDir = path.join(__dirname, '../../uploads/files');
const uploadsDir = path.resolve(__dirname, '../../uploads');

const noteUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true }); cb(null, filesDir) },
    filename: (req, file, cb) => { cb(null, `${uuidv4()}${path.extname(file.originalname)}`) },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      cb(new Error('File type not allowed'));
      return;
    }
    cb(null, true);
  },
});

const router = express.Router({ mergeParams: true });

async function isUrlSafe(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  try {
    const { address } = await dnsLookup(parsed.hostname);
    const parts = address.split('.').map(Number);
    // Block private, loopback, and link-local
    if (parts[0] === 127) return false;
    if (parts[0] === 10) return false;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
    if (parts[0] === 169 && parts[1] === 254) return false;
    if (address === '0.0.0.0') return false;
  } catch { return false; }
  return true;
}

function verifyTripAccess(tripId, userId) {
  return canAccessTrip(tripId, userId);
}

function avatarUrl(user) {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

function formatNote(note) {
  const attachments = db.prepare('SELECT id, filename, original_name, file_size, mime_type FROM trip_files WHERE note_id = ?').all(note.id);
  return {
    ...note,
    avatar_url: avatarUrl(note),
    attachments: attachments.map(a => ({ ...a, url: `/uploads/${a.filename}` })),
  };
}

function loadReactions(messageId) {
  return db.prepare(`
    SELECT r.emoji, r.user_id, u.username
    FROM collab_message_reactions r
    JOIN users u ON r.user_id = u.id
    WHERE r.message_id = ?
  `).all(messageId);
}

function groupReactions(reactions) {
  const map = {};
  for (const r of reactions) {
    if (!map[r.emoji]) map[r.emoji] = [];
    map[r.emoji].push({ user_id: r.user_id, username: r.username });
  }
  return Object.entries(map).map(([emoji, users]) => ({ emoji, users, count: users.length }));
}

function formatMessage(msg, reactions) {
  return { ...msg, user_avatar: avatarUrl(msg), avatar_url: avatarUrl(msg), reactions: reactions || [] };
}

// ─── NOTES ───────────────────────────────────────────────────────────────────

// GET /notes
router.get('/notes', authenticate, (req, res) => {
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const notes = db.prepare(`
    SELECT n.*, u.username, u.avatar
    FROM collab_notes n
    JOIN users u ON n.user_id = u.id
    WHERE n.trip_id = ?
    ORDER BY n.pinned DESC, n.updated_at DESC
  `).all(tripId);

  res.json({ notes: notes.map(formatNote) });
});

// POST /notes
router.post('/notes', authenticate, (req, res) => {
  const { tripId } = req.params;
  const { title, content, category, color, website } = req.body;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const result = db.prepare(`
    INSERT INTO collab_notes (trip_id, user_id, title, content, category, color, website)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, req.user.id, title, content || null, category || 'General', color || '#6366f1', website || null);

  const note = db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(result.lastInsertRowid);

  const formatted = formatNote(note);
  res.status(201).json({ note: formatted });
  broadcast(tripId, 'collab:note:created', { note: formatted }, req.headers['x-socket-id']);
});

// PUT /notes/:id
router.put('/notes/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  const { title, content, category, color, pinned, website } = req.body;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const existing = db.prepare('SELECT * FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Note not found' });

  db.prepare(`
    UPDATE collab_notes SET
      title = COALESCE(?, title),
      content = CASE WHEN ? THEN ? ELSE content END,
      category = COALESCE(?, category),
      color = COALESCE(?, color),
      pinned = CASE WHEN ? IS NOT NULL THEN ? ELSE pinned END,
      website = CASE WHEN ? THEN ? ELSE website END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    title || null,
    content !== undefined ? 1 : 0, content !== undefined ? content : null,
    category || null,
    color || null,
    pinned !== undefined ? 1 : null, pinned ? 1 : 0,
    website !== undefined ? 1 : 0, website !== undefined ? website : null,
    id
  );

  const note = db.prepare(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `).get(id);

  const formatted = formatNote(note);
  res.json({ note: formatted });
  broadcast(tripId, 'collab:note:updated', { note: formatted }, req.headers['x-socket-id']);
});

// DELETE /notes/:id
router.delete('/notes/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const existing = db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Note not found' });

  // Delete attached files (physical + DB)
  const noteFiles = db.prepare('SELECT id, filename FROM trip_files WHERE note_id = ?').all(id);
  for (const f of noteFiles) {
    const filePath = path.join(__dirname, '../../uploads', f.filename);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(uploadsDir + path.sep) && resolvedPath !== uploadsDir) {
      continue; // path traversal attempt, skip
    }
    try { if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath); } catch {}
  }
  db.prepare('DELETE FROM trip_files WHERE note_id = ?').run(id);

  db.prepare('DELETE FROM collab_notes WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'collab:note:deleted', { noteId: Number(id) }, req.headers['x-socket-id']);
});

// POST /notes/:id/files — upload attachment to note
router.post('/notes/:id/files', authenticate, demoUploadBlock, noteUpload.single('file'), (req, res) => {
  const { tripId, id } = req.params;
  if (!verifyTripAccess(Number(tripId), req.user.id)) return res.status(404).json({ error: 'Trip not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const note = db.prepare('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const originalName = path.basename(req.file.originalname);
  const result = db.prepare(
    'INSERT INTO trip_files (trip_id, note_id, filename, original_name, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(tripId, id, `files/${req.file.filename}`, originalName, req.file.size, req.file.mimetype);

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ file: { ...file, url: `/uploads/${file.filename}` } });
  broadcast(Number(tripId), 'collab:note:updated', { note: formatNote(db.prepare('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(id)) }, req.headers['x-socket-id']);
});

// DELETE /notes/:id/files/:fileId — remove attachment
router.delete('/notes/:id/files/:fileId', authenticate, (req, res) => {
  const { tripId, id, fileId } = req.params;
  if (!verifyTripAccess(Number(tripId), req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND note_id = ?').get(fileId, id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  // Delete physical file with path traversal check
  const filePath = path.join(__dirname, '../../uploads', file.filename);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath.startsWith(uploadsDir + path.sep) || resolvedPath === uploadsDir) {
    try { if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath); } catch {}
  }

  db.prepare('DELETE FROM trip_files WHERE id = ?').run(fileId);
  res.json({ success: true });
  broadcast(Number(tripId), 'collab:note:updated', { note: formatNote(db.prepare('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(id)) }, req.headers['x-socket-id']);
});

// ─── POLLS ───────────────────────────────────────────────────────────────────

function getPollWithVotes(pollId) {
  const poll = db.prepare(`
    SELECT p.*, u.username, u.avatar
    FROM collab_polls p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(pollId);

  if (!poll) return null;

  const options = JSON.parse(poll.options);

  const votes = db.prepare(`
    SELECT v.option_index, v.user_id, u.username, u.avatar
    FROM collab_poll_votes v
    JOIN users u ON v.user_id = u.id
    WHERE v.poll_id = ?
  `).all(pollId);

  // Transform: nest voters into each option (frontend expects options[i].voters)
  const formattedOptions = options.map((label, idx) => ({
    label: typeof label === 'string' ? label : label.label || label,
    voters: votes
      .filter(v => v.option_index === idx)
      .map(v => ({ id: v.user_id, user_id: v.user_id, username: v.username, avatar: v.avatar, avatar_url: avatarUrl(v) })),
  }));

  return {
    ...poll,
    avatar_url: avatarUrl(poll),
    options: formattedOptions,
    is_closed: !!poll.closed,
    multiple_choice: !!poll.multiple,
  };
}

// GET /polls
router.get('/polls', authenticate, (req, res) => {
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const rows = db.prepare(`
    SELECT id FROM collab_polls WHERE trip_id = ? ORDER BY created_at DESC
  `).all(tripId);

  const polls = rows.map(row => getPollWithVotes(row.id)).filter(Boolean);
  res.json({ polls });
});

// POST /polls
router.post('/polls', authenticate, (req, res) => {
  const { tripId } = req.params;
  const { question, options, multiple, multiple_choice, deadline } = req.body;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });
  if (!question) return res.status(400).json({ error: 'Question is required' });
  if (!Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'At least 2 options are required' });
  }

  // Accept both 'multiple' and 'multiple_choice' from frontend
  const isMultiple = multiple || multiple_choice;

  const result = db.prepare(`
    INSERT INTO collab_polls (trip_id, user_id, question, options, multiple, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tripId, req.user.id, question, JSON.stringify(options), isMultiple ? 1 : 0, deadline || null);

  const poll = getPollWithVotes(result.lastInsertRowid);
  res.status(201).json({ poll });
  broadcast(tripId, 'collab:poll:created', { poll }, req.headers['x-socket-id']);
});

// POST /polls/:id/vote
router.post('/polls/:id/vote', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  const { option_index } = req.body;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const poll = db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.closed) return res.status(400).json({ error: 'Poll is closed' });

  const options = JSON.parse(poll.options);
  if (option_index < 0 || option_index >= options.length) {
    return res.status(400).json({ error: 'Invalid option index' });
  }

  // Toggle: if vote exists, remove it; otherwise add it
  const existingVote = db.prepare(
    'SELECT id FROM collab_poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?'
  ).get(id, req.user.id, option_index);

  if (existingVote) {
    db.prepare('DELETE FROM collab_poll_votes WHERE id = ?').run(existingVote.id);
  } else {
    if (!poll.multiple) {
      db.prepare('DELETE FROM collab_poll_votes WHERE poll_id = ? AND user_id = ?').run(id, req.user.id);
    }
    db.prepare('INSERT INTO collab_poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)').run(id, req.user.id, option_index);
  }

  const updatedPoll = getPollWithVotes(id);
  res.json({ poll: updatedPoll });
  broadcast(tripId, 'collab:poll:voted', { poll: updatedPoll }, req.headers['x-socket-id']);
});

// PUT /polls/:id/close
router.put('/polls/:id/close', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const poll = db.prepare('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  db.prepare('UPDATE collab_polls SET closed = 1 WHERE id = ?').run(id);

  const updatedPoll = getPollWithVotes(id);
  res.json({ poll: updatedPoll });
  broadcast(tripId, 'collab:poll:closed', { poll: updatedPoll }, req.headers['x-socket-id']);
});

// DELETE /polls/:id
router.delete('/polls/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const poll = db.prepare('SELECT id FROM collab_polls WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  db.prepare('DELETE FROM collab_polls WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'collab:poll:deleted', { pollId: Number(id) }, req.headers['x-socket-id']);
});

// ─── MESSAGES (CHAT) ────────────────────────────────────────────────────────

// GET /messages
router.get('/messages', authenticate, (req, res) => {
  const { tripId } = req.params;
  const { before } = req.query;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const query = `
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.trip_id = ?${before ? ' AND m.id < ?' : ''}
    ORDER BY m.id DESC
    LIMIT 100
  `;

  const messages = before
    ? db.prepare(query).all(tripId, before)
    : db.prepare(query).all(tripId);

  messages.reverse();
  // Batch-load reactions
  const msgIds = messages.map(m => m.id);
  const reactionsByMsg = {};
  if (msgIds.length > 0) {
    const allReactions = db.prepare(`
      SELECT r.message_id, r.emoji, r.user_id, u.username
      FROM collab_message_reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id IN (${msgIds.map(() => '?').join(',')})
    `).all(...msgIds);
    for (const r of allReactions) {
      if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = [];
      reactionsByMsg[r.message_id].push(r);
    }
  }
  res.json({ messages: messages.map(m => formatMessage(m, groupReactions(reactionsByMsg[m.id] || []))) });
});

// POST /messages
router.post('/messages', authenticate, (req, res) => {
  const { tripId } = req.params;
  const { text, reply_to } = req.body;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text is required' });
  if (text.length > 5000) return res.status(400).json({ error: 'Message text too long (max 5000 characters)' });

  if (reply_to) {
    const replyMsg = db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(reply_to, tripId);
    if (!replyMsg) return res.status(400).json({ error: 'Reply target message not found' });
  }

  const result = db.prepare(`
    INSERT INTO collab_messages (trip_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)
  `).run(tripId, req.user.id, text.trim(), reply_to || null);

  const message = db.prepare(`
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.id = ?
  `).get(result.lastInsertRowid);

  const formatted = formatMessage(message);
  res.status(201).json({ message: formatted });
  broadcast(tripId, 'collab:message:created', { message: formatted }, req.headers['x-socket-id']);
});

// POST /messages/:id/react — toggle emoji reaction
router.post('/messages/:id/react', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  const { emoji } = req.body;
  if (!verifyTripAccess(Number(tripId), req.user.id)) return res.status(404).json({ error: 'Trip not found' });
  if (!emoji) return res.status(400).json({ error: 'Emoji is required' });
  if (typeof emoji !== 'string' || [...emoji].length > 3 || emoji.length > 20) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }

  const msg = db.prepare('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const existing = db.prepare('SELECT id FROM collab_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(id, req.user.id, emoji);
  if (existing) {
    db.prepare('DELETE FROM collab_message_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO collab_message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(id, req.user.id, emoji);
  }

  const reactions = groupReactions(loadReactions(id));
  res.json({ reactions });
  broadcast(Number(tripId), 'collab:message:reacted', { messageId: Number(id), reactions }, req.headers['x-socket-id']);
});

// DELETE /messages/:id (soft-delete)
router.delete('/messages/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  if (!verifyTripAccess(tripId, req.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const message = db.prepare('SELECT * FROM collab_messages WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (Number(message.user_id) !== Number(req.user.id)) return res.status(403).json({ error: 'You can only delete your own messages' });

  db.prepare('UPDATE collab_messages SET deleted = 1 WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'collab:message:deleted', { messageId: Number(id), username: message.username || req.user.username }, req.headers['x-socket-id']);
});

// ─── LINK PREVIEW ────────────────────────────────────────────────────────────

router.get('/link-preview', authenticate, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  if (!(await isUrlSafe(url))) return res.status(400).json({ error: 'URL not allowed' });

  try {
    const fetch = require('node-fetch');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NOMAD/1.0; +https://github.com/mauriceboe/NOMAD)' },
    })
      .then(r => {
        clearTimeout(timeout);
        if (!r.ok) throw new Error('Fetch failed');
        return r.text();
      })
      .then(html => {
        const get = (prop) => {
          const m = html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
            || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, 'i'));
          return m ? m[1] : null;
        };
        const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const descMeta = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
          || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);

        res.json({
          title: get('title') || (titleTag ? titleTag[1].trim() : null),
          description: get('description') || (descMeta ? descMeta[1].trim() : null),
          image: get('image') || null,
          site_name: get('site_name') || null,
          url,
        });
      })
      .catch(() => {
        clearTimeout(timeout);
        res.json({ title: null, description: null, image: null, url });
      });
  } catch {
    res.json({ title: null, description: null, image: null, url });
  }
});

module.exports = router;
