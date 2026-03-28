const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, canAccessTrip } = require('../db/database');
const { authenticate, demoUploadBlock } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const photosDir = path.join(__dirname, '../../uploads/photos');
const uploadsDir = path.resolve(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
    cb(null, photosDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (file.mimetype.startsWith('image/') && !file.mimetype.includes('svg') && allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only jpg, png, gif, webp images allowed'));
    }
  },
});

function formatPhoto(photo) {
  return {
    ...photo,
    url: `/uploads/photos/${photo.filename}`,
  };
}

// GET /api/trips/:tripId/photos
router.get('/', authenticate, (req, res) => {
  const { tripId } = req.params;
  const { day_id, place_id } = req.query;

  const trip = canAccessTrip(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  let query = 'SELECT * FROM photos WHERE trip_id = ?';
  const params = [tripId];

  if (day_id) {
    query += ' AND day_id = ?';
    params.push(day_id);
  }

  if (place_id) {
    query += ' AND place_id = ?';
    params.push(place_id);
  }

  query += ' ORDER BY created_at DESC';

  const photos = db.prepare(query).all(...params);
  res.json({ photos: photos.map(formatPhoto) });
});

// POST /api/trips/:tripId/photos
router.post('/', authenticate, demoUploadBlock, upload.array('photos', 20), (req, res) => {
  const { tripId } = req.params;
  const { day_id, place_id, caption } = req.body;

  const trip = canAccessTrip(tripId, req.user.id);
  if (!trip) {
    // Delete uploaded files on auth failure
    if (req.files) req.files.forEach(f => fs.unlinkSync(f.path));
    return res.status(404).json({ error: 'Trip not found' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const insertPhoto = db.prepare(`
    INSERT INTO photos (trip_id, day_id, place_id, filename, original_name, file_size, mime_type, caption)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const photos = [];
  db.exec('BEGIN');
  try {
    for (const file of req.files) {
      const originalName = path.basename(file.originalname);
      const result = insertPhoto.run(
        tripId,
        day_id || null,
        place_id || null,
        file.filename,
        originalName,
        file.size,
        file.mimetype,
        caption || null
      );
      const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(result.lastInsertRowid);
      photos.push(formatPhoto(photo));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.status(201).json({ photos });
});

// PUT /api/trips/:tripId/photos/:id
router.put('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;
  const { caption, day_id, place_id } = req.body;

  const trip = canAccessTrip(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  db.prepare(`
    UPDATE photos SET
      caption = COALESCE(?, caption),
      day_id = ?,
      place_id = ?
    WHERE id = ?
  `).run(
    caption !== undefined ? caption : photo.caption,
    day_id !== undefined ? (day_id || null) : photo.day_id,
    place_id !== undefined ? (place_id || null) : photo.place_id,
    id
  );

  const updated = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  res.json({ photo: formatPhoto(updated) });
});

// DELETE /api/trips/:tripId/photos/:id
router.delete('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;

  const trip = canAccessTrip(tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  // Delete file with path traversal check
  const filePath = path.join(photosDir, photo.filename);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath.startsWith(uploadsDir + path.sep) || resolvedPath === uploadsDir) {
    if (fs.existsSync(resolvedPath)) {
      try { fs.unlinkSync(resolvedPath); } catch (e) { console.error('Error deleting photo file:', e); }
    }
  }

  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  res.json({ success: true });
});

module.exports = router;
