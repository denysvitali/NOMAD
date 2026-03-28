const express = require('express');
const archiver = require('archiver');
const unzipper = require('unzipper');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticate, adminOnly } = require('../middleware/auth');
const scheduler = require('../scheduler');
const { db, closeDb, reinitialize } = require('../db/database');

const router = express.Router();

// All backup routes require admin
router.use(authenticate, adminOnly);

const dataDir = path.join(__dirname, '../../data');
const backupsDir = path.join(dataDir, 'backups');
const uploadsDir = path.join(__dirname, '../../uploads');

function ensureBackupsDir() {
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// GET /api/backup/list
router.get('/list', (req, res) => {
  ensureBackupsDir();

  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.zip'))
      .map(filename => {
        const filePath = path.join(backupsDir, filename);
        const stat = fs.statSync(filePath);
        return {
          filename,
          size: stat.size,
          sizeText: formatSize(stat.size),
          created_at: stat.birthtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ backups: files });
  } catch (err) {
    res.status(500).json({ error: 'Error loading backups' });
  }
});

// POST /api/backup/create
router.post('/create', async (req, res) => {
  ensureBackupsDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup-${timestamp}.zip`;
  const outputPath = path.join(backupsDir, filename);

  try {
    // Flush WAL to main DB file before archiving so all data is captured
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);

      // Add database
      const dbPath = path.join(dataDir, 'travel.db');
      if (fs.existsSync(dbPath)) {
        archive.file(dbPath, { name: 'travel.db' });
      }

      // Add uploads directory
      if (fs.existsSync(uploadsDir)) {
        archive.directory(uploadsDir, 'uploads');
      }

      archive.finalize();
    });

    const stat = fs.statSync(outputPath);
    res.json({
      success: true,
      backup: {
        filename,
        size: stat.size,
        sizeText: formatSize(stat.size),
        created_at: stat.birthtime.toISOString(),
      }
    });
  } catch (err) {
    console.error('Backup error:', err);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: 'Error creating backup' });
  }
});

// GET /api/backup/download/:filename
router.get('/download/:filename', (req, res) => {
  const { filename } = req.params;

  // Security: prevent path traversal
  if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(backupsDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  res.download(filePath, filename);
});

// Helper: restore from a zip file path
async function restoreFromZip(zipPath, res) {
  const extractDir = path.join(dataDir, `restore-${Date.now()}`);
  try {
    // Safe extraction with zip-slip protection
    const directory = await unzipper.Open.file(zipPath);
    const extractDirResolved = path.resolve(extractDir);
    for (const file of directory.files) {
      const fullPath = path.join(extractDir, file.path);
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(extractDirResolved + path.sep) && resolved !== extractDirResolved) {
        throw new Error('Potentially unsafe file path in archive');
      }
      if (file.type === 'Directory') {
        if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
      } else {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await new Promise((resolve, reject) => {
          file.stream()
            .pipe(fs.createWriteStream(fullPath))
            .on('finish', resolve)
            .on('error', reject);
        });
      }
    }

    const extractedDb = path.join(extractDir, 'travel.db');
    if (!fs.existsSync(extractedDb)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Invalid backup: travel.db not found' });
    }

    // Step 1: close DB connection BEFORE touching the file (required on Windows)
    closeDb();

    try {
      // Step 2: remove WAL/SHM and overwrite DB file
      const dbDest = path.join(dataDir, 'travel.db');
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbDest + ext); } catch (e) {}
      }
      fs.copyFileSync(extractedDb, dbDest);

      // Step 3: restore uploads — overwrite in-place instead of rmSync
      // (rmSync fails with EBUSY because express.static holds the directory)
      const extractedUploads = path.join(extractDir, 'uploads');
      if (fs.existsSync(extractedUploads)) {
        // Clear contents of each subdirectory without removing the root uploads dir
        for (const sub of fs.readdirSync(uploadsDir)) {
          const subPath = path.join(uploadsDir, sub);
          if (fs.statSync(subPath).isDirectory()) {
            for (const file of fs.readdirSync(subPath)) {
              try { fs.unlinkSync(path.join(subPath, file)); } catch (e) {}
            }
          }
        }
        // Copy restored files over
        fs.cpSync(extractedUploads, uploadsDir, { recursive: true, force: true });
      }
    } finally {
      // Step 4: ALWAYS reopen DB — even if file copy failed, so the server stays functional
      reinitialize();
    }

    fs.rmSync(extractDir, { recursive: true, force: true });

    res.json({ success: true });
  } catch (err) {
    console.error('Restore error:', err);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    if (!res.headersSent) res.status(500).json({ error: 'An internal error occurred' });
  }
}

// POST /api/backup/restore/:filename - restore from stored backup
router.post('/restore/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const zipPath = path.join(backupsDir, filename);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  await restoreFromZip(zipPath, res);
});

// POST /api/backup/upload-restore - upload a zip and restore
const uploadTmp = multer({
  dest: path.join(dataDir, 'tmp/'),
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.zip')) cb(null, true);
    else cb(new Error('Only ZIP files allowed'));
  },
  limits: { fileSize: 500 * 1024 * 1024 },
});

router.post('/upload-restore', uploadTmp.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const zipPath = req.file.path;
  await restoreFromZip(zipPath, res);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
});

// GET /api/backup/auto-settings
router.get('/auto-settings', (req, res) => {
  res.json({ settings: scheduler.loadSettings() });
});

// PUT /api/backup/auto-settings
router.put('/auto-settings', (req, res) => {
  const { enabled, interval, keep_days } = req.body;
  const settings = {
    enabled: !!enabled,
    interval: scheduler.VALID_INTERVALS.includes(interval) ? interval : 'daily',
    keep_days: Number.isInteger(keep_days) && keep_days >= 0 ? keep_days : 7,
  };
  scheduler.saveSettings(settings);
  scheduler.start();
  res.json({ settings });
});

// DELETE /api/backup/:filename
router.delete('/:filename', (req, res) => {
  const { filename } = req.params;

  if (!/^backup-[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(backupsDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }

  fs.unlinkSync(filePath);
  res.json({ success: true });
});

module.exports = router;
