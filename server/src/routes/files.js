const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, canAccessTrip } = require('../db/database');
const { authenticate, demoUploadBlock } = require('../middleware/auth');
const { broadcast } = require('../websocket');

const router = express.Router({ mergeParams: true });

const filesDir = path.join(__dirname, '../../uploads/files');
const uploadsDir = path.resolve(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
    cb(null, filesDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const DEFAULT_ALLOWED_EXTENSIONS = 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv';
const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.dll', '.com', '.scr', '.pif', '.vbs', '.js', '.wsh', '.wsf', '.html', '.htm', '.svg', '.xml', '.xhtml'];

function getAllowedExtensions() {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'allowed_file_types'").get();
    return row?.value || DEFAULT_ALLOWED_EXTENSIONS;
  } catch { return DEFAULT_ALLOWED_EXTENSIONS; }
}

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext) || file.mimetype.includes('svg')) {
      return cb(new Error('File type not allowed'));
    }
    const allowed = getAllowedExtensions().split(',').map(e => e.trim().toLowerCase());
    const fileExt = ext.replace('.', '');
    if (allowed.includes(fileExt) || (allowed.includes('*') && !BLOCKED_EXTENSIONS.includes(ext))) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  },
});

function verifyTripOwnership(tripId, userId) {
  return canAccessTrip(tripId, userId);
}

function formatFile(file) {
  return {
    ...file,
    url: file.filename?.startsWith('files/') ? `/uploads/${file.filename}` : `/uploads/files/${file.filename}`,
  };
}

// GET /api/trips/:tripId/files
router.get('/', authenticate, (req, res) => {
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const files = db.prepare(`
    SELECT f.*, r.title as reservation_title
    FROM trip_files f
    LEFT JOIN reservations r ON f.reservation_id = r.id
    WHERE f.trip_id = ?
    ORDER BY f.created_at DESC
  `).all(tripId);
  res.json({ files: files.map(formatFile) });
});

// POST /api/trips/:tripId/files
router.post('/', authenticate, demoUploadBlock, upload.single('file'), (req, res) => {
  const { tripId } = req.params;
  const { place_id, description, reservation_id } = req.body;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Trip not found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const originalName = path.basename(req.file.originalname);
  const result = db.prepare(`
    INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId,
    place_id || null,
    reservation_id || null,
    req.file.filename,
    originalName,
    req.file.size,
    req.file.mimetype,
    description || null
  );

  const file = db.prepare(`
    SELECT f.*, r.title as reservation_title
    FROM trip_files f
    LEFT JOIN reservations r ON f.reservation_id = r.id
    WHERE f.id = ?
  `).get(result.lastInsertRowid);
  res.status(201).json({ file: formatFile(file) });
  broadcast(tripId, 'file:created', { file: formatFile(file) }, req.headers['x-socket-id']);
});

// PUT /api/trips/:tripId/files/:id
router.put('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  const { description, place_id, reservation_id } = req.body;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  db.prepare(`
    UPDATE trip_files SET
      description = COALESCE(?, description),
      place_id = ?,
      reservation_id = ?
    WHERE id = ?
  `).run(
    description !== undefined ? description : file.description,
    place_id !== undefined ? (place_id || null) : file.place_id,
    reservation_id !== undefined ? (reservation_id || null) : file.reservation_id,
    id
  );

  const updated = db.prepare(`
    SELECT f.*, r.title as reservation_title
    FROM trip_files f
    LEFT JOIN reservations r ON f.reservation_id = r.id
    WHERE f.id = ?
  `).get(id);
  res.json({ file: formatFile(updated) });
  broadcast(tripId, 'file:updated', { file: formatFile(updated) }, req.headers['x-socket-id']);
});

// DELETE /api/trips/:tripId/files/:id
router.delete('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const file = db.prepare('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const filePath = path.join(filesDir, file.filename);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath.startsWith(uploadsDir + path.sep) || resolvedPath === uploadsDir) {
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) { console.error('Error deleting file:', e); }
    }
  }

  db.prepare('DELETE FROM trip_files WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'file:deleted', { fileId: Number(id) }, req.headers['x-socket-id']);
});

module.exports = router;
