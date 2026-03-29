const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'travel.db');

let _db = null;

function initDb() {
  if (_db) {
    try { _db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    try { _db.close(); } catch (e) {}
    _db = null;
  }

  _db = new Database(dbPath);

  // Restrict DB file permissions to owner-only (rw-------)
  try { fs.chmodSync(dbPath, 0o600); } catch {}

  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 5000');
  _db.exec('PRAGMA foreign_keys = ON');

  // Create all tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      maps_api_key TEXT,
      unsplash_api_key TEXT,
      openweather_api_key TEXT,
      avatar TEXT,
      oidc_sub TEXT,
      oidc_issuer TEXT,
      last_login DATETIME,
      is_demo INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT,
      end_date TEXT,
      currency TEXT DEFAULT 'EUR',
      cover_image TEXT,
      is_archived INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_number INTEGER NOT NULL,
      date TEXT,
      notes TEXT,
      title TEXT,
      UNIQUE(trip_id, day_number)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      icon TEXT DEFAULT '📍',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#10b981',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      lat REAL,
      lng REAL,
      address TEXT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      price REAL,
      currency TEXT,
      reservation_status TEXT DEFAULT 'none',
      reservation_notes TEXT,
      reservation_datetime TEXT,
      place_time TEXT,
      end_time TEXT,
      duration_minutes INTEGER DEFAULT 60,
      notes TEXT,
      image_url TEXT,
      google_place_id TEXT,
      website TEXT,
      phone TEXT,
      transport_mode TEXT DEFAULT 'walking',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS place_tags (
      place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (place_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS day_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      order_index INTEGER DEFAULT 0,
      notes TEXT,
      reservation_status TEXT DEFAULT 'none',
      reservation_notes TEXT,
      reservation_datetime TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS packing_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      checked INTEGER DEFAULT 0,
      category TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
      place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      caption TEXT,
      taken_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trip_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
      reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
      place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
      assignment_id INTEGER REFERENCES day_assignments(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      reservation_time TEXT,
      location TEXT,
      confirmation_number TEXT,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      type TEXT DEFAULT 'other',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trip_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by INTEGER REFERENCES users(id),
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(trip_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS day_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      time TEXT,
      icon TEXT DEFAULT '📝',
      sort_order REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS budget_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT 'Other',
      name TEXT NOT NULL,
      total_price REAL NOT NULL DEFAULT 0,
      persons INTEGER DEFAULT NULL,
      days INTEGER DEFAULT NULL,
      note TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Addon system
    CREATE TABLE IF NOT EXISTS addons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'global',
      icon TEXT DEFAULT 'Puzzle',
      enabled INTEGER DEFAULT 0,
      config TEXT DEFAULT '{}',
      sort_order INTEGER DEFAULT 0
    );

    -- Vacay addon tables
    CREATE TABLE IF NOT EXISTS vacay_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      block_weekends INTEGER DEFAULT 1,
      holidays_enabled INTEGER DEFAULT 0,
      holidays_region TEXT DEFAULT '',
      company_holidays_enabled INTEGER DEFAULT 1,
      carry_over_enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id)
    );

    CREATE TABLE IF NOT EXISTS vacay_plan_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(plan_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS vacay_user_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      color TEXT DEFAULT '#6366f1',
      UNIQUE(user_id, plan_id)
    );

    CREATE TABLE IF NOT EXISTS vacay_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      UNIQUE(plan_id, year)
    );

    CREATE TABLE IF NOT EXISTS vacay_user_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      vacation_days INTEGER DEFAULT 30,
      carried_over INTEGER DEFAULT 0,
      UNIQUE(user_id, plan_id, year)
    );

    CREATE TABLE IF NOT EXISTS vacay_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      note TEXT DEFAULT '',
      UNIQUE(user_id, plan_id, date)
    );

    CREATE TABLE IF NOT EXISTS vacay_company_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES vacay_plans(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      note TEXT DEFAULT '',
      UNIQUE(plan_id, date)
    );

    CREATE TABLE IF NOT EXISTS day_accommodations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
      start_day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      end_day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      check_in TEXT,
      check_out TEXT,
      confirmation TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Collab addon tables
    CREATE TABLE IF NOT EXISTS collab_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT DEFAULT 'General',
      title TEXT NOT NULL,
      content TEXT,
      color TEXT DEFAULT '#6366f1',
      pinned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collab_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      multiple INTEGER DEFAULT 0,
      closed INTEGER DEFAULT 0,
      deadline TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collab_poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL REFERENCES collab_polls(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(poll_id, user_id, option_index)
    );

    CREATE TABLE IF NOT EXISTS collab_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      reply_to INTEGER REFERENCES collab_messages(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_collab_notes_trip ON collab_notes(trip_id);
    CREATE INDEX IF NOT EXISTS idx_collab_polls_trip ON collab_polls(trip_id);
    CREATE INDEX IF NOT EXISTS idx_collab_messages_trip ON collab_messages(trip_id);

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti TEXT PRIMARY KEY,
      revoked_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `);

  // Purge any expired revoked tokens on startup
  _db.prepare("DELETE FROM revoked_tokens WHERE expires_at < datetime('now')").run();

  // Create indexes for performance
  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_places_trip_id ON places(trip_id);
    CREATE INDEX IF NOT EXISTS idx_places_category_id ON places(category_id);
    CREATE INDEX IF NOT EXISTS idx_days_trip_id ON days(trip_id);
    CREATE INDEX IF NOT EXISTS idx_day_assignments_day_id ON day_assignments(day_id);
    CREATE INDEX IF NOT EXISTS idx_day_assignments_place_id ON day_assignments(place_id);
    CREATE INDEX IF NOT EXISTS idx_place_tags_place_id ON place_tags(place_id);
    CREATE INDEX IF NOT EXISTS idx_place_tags_tag_id ON place_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_trip_members_trip_id ON trip_members(trip_id);
    CREATE INDEX IF NOT EXISTS idx_trip_members_user_id ON trip_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_packing_items_trip_id ON packing_items(trip_id);
    CREATE INDEX IF NOT EXISTS idx_budget_items_trip_id ON budget_items(trip_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_trip_id ON reservations(trip_id);
    CREATE INDEX IF NOT EXISTS idx_trip_files_trip_id ON trip_files(trip_id);
    CREATE INDEX IF NOT EXISTS idx_day_notes_day_id ON day_notes(day_id);
    CREATE INDEX IF NOT EXISTS idx_photos_trip_id ON photos(trip_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_day_accommodations_trip_id ON day_accommodations(trip_id);

    CREATE TABLE IF NOT EXISTS assignment_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL REFERENCES day_assignments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(assignment_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assignment_participants_assignment ON assignment_participants(assignment_id);
  `);

  // Versioned migrations — each runs exactly once
  _db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const versionRow = _db.prepare('SELECT version FROM schema_version').get();
  let currentVersion = versionRow?.version ?? 0;

  // Existing or fresh DBs may already have columns the migrations add.
  // Detect by checking for a column from migration 1 (unsplash_api_key).
  if (currentVersion === 0) {
    const hasUnsplash = _db.prepare(
      "SELECT 1 FROM pragma_table_info('users') WHERE name = 'unsplash_api_key'"
    ).get();
    if (hasUnsplash) {
      // All columns from CREATE TABLE already exist — skip ALTER migrations
      currentVersion = 19;
      _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(currentVersion);
      console.log('[DB] Schema already up-to-date, setting version to', currentVersion);
    } else {
      _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(0);
    }
  }

  const migrations = [
    // 1–18: ALTER TABLE additions
    () => _db.exec('ALTER TABLE users ADD COLUMN unsplash_api_key TEXT'),
    () => _db.exec('ALTER TABLE users ADD COLUMN openweather_api_key TEXT'),
    () => _db.exec('ALTER TABLE places ADD COLUMN duration_minutes INTEGER DEFAULT 60'),
    () => _db.exec('ALTER TABLE places ADD COLUMN notes TEXT'),
    () => _db.exec('ALTER TABLE places ADD COLUMN image_url TEXT'),
    () => _db.exec("ALTER TABLE places ADD COLUMN transport_mode TEXT DEFAULT 'walking'"),
    () => _db.exec('ALTER TABLE days ADD COLUMN title TEXT'),
    () => _db.exec("ALTER TABLE reservations ADD COLUMN status TEXT DEFAULT 'pending'"),
    () => _db.exec('ALTER TABLE trip_files ADD COLUMN reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL'),
    () => _db.exec("ALTER TABLE reservations ADD COLUMN type TEXT DEFAULT 'other'"),
    () => _db.exec('ALTER TABLE trips ADD COLUMN cover_image TEXT'),
    () => _db.exec("ALTER TABLE day_notes ADD COLUMN icon TEXT DEFAULT '📝'"),
    () => _db.exec('ALTER TABLE trips ADD COLUMN is_archived INTEGER DEFAULT 0'),
    () => _db.exec('ALTER TABLE categories ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'),
    () => _db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'),
    () => _db.exec('ALTER TABLE users ADD COLUMN oidc_sub TEXT'),
    () => _db.exec('ALTER TABLE users ADD COLUMN oidc_issuer TEXT'),
    () => _db.exec('ALTER TABLE users ADD COLUMN last_login DATETIME'),
    // 19: budget_items table rebuild (NOT NULL → nullable persons)
    () => {
      const schema = _db.prepare("SELECT sql FROM sqlite_master WHERE name = 'budget_items'").get();
      if (schema?.sql?.includes('NOT NULL DEFAULT 1')) {
        _db.exec(`
          CREATE TABLE budget_items_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            category TEXT NOT NULL DEFAULT 'Other',
            name TEXT NOT NULL,
            total_price REAL NOT NULL DEFAULT 0,
            persons INTEGER DEFAULT NULL,
            days INTEGER DEFAULT NULL,
            note TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO budget_items_new SELECT * FROM budget_items;
          DROP TABLE budget_items;
          ALTER TABLE budget_items_new RENAME TO budget_items;
        `);
      }
    },
    // 20: accommodation check-in/check-out/confirmation fields
    () => {
      try { _db.exec('ALTER TABLE day_accommodations ADD COLUMN check_in TEXT'); } catch {}
      try { _db.exec('ALTER TABLE day_accommodations ADD COLUMN check_out TEXT'); } catch {}
      try { _db.exec('ALTER TABLE day_accommodations ADD COLUMN confirmation TEXT'); } catch {}
    },
    // 21: places end_time field (place_time becomes start_time conceptually, end_time is new)
    () => {
      try { _db.exec('ALTER TABLE places ADD COLUMN end_time TEXT'); } catch {}
    },
    // 22: Move reservation fields from places to day_assignments
    () => {
      // Add new columns to day_assignments
      try { _db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_status TEXT DEFAULT \'none\''); } catch {}
      try { _db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_notes TEXT'); } catch {}
      try { _db.exec('ALTER TABLE day_assignments ADD COLUMN reservation_datetime TEXT'); } catch {}

      // Migrate existing data: copy reservation info from places to all their assignments
      try {
        _db.exec(`
          UPDATE day_assignments SET
            reservation_status = (SELECT reservation_status FROM places WHERE places.id = day_assignments.place_id),
            reservation_notes = (SELECT reservation_notes FROM places WHERE places.id = day_assignments.place_id),
            reservation_datetime = (SELECT reservation_datetime FROM places WHERE places.id = day_assignments.place_id)
          WHERE place_id IN (SELECT id FROM places WHERE reservation_status IS NOT NULL AND reservation_status != 'none')
        `);
        console.log('[DB] Migrated reservation data from places to day_assignments');
      } catch (e) {
        console.error('[DB] Migration 22 data copy error:', e.message);
      }
    },
    // 23: Add assignment_id to reservations table
    () => {
      try { _db.exec('ALTER TABLE reservations ADD COLUMN assignment_id INTEGER REFERENCES day_assignments(id) ON DELETE SET NULL'); } catch {}
    },
    // 24: Assignment participants (who's joining which activity)
    () => {
      _db.exec(`
        CREATE TABLE IF NOT EXISTS assignment_participants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          assignment_id INTEGER NOT NULL REFERENCES day_assignments(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(assignment_id, user_id)
        )
      `);
    },
    // 25: Collab addon tables
    () => {
      _db.exec(`
        CREATE TABLE IF NOT EXISTS collab_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          category TEXT DEFAULT 'General',
          title TEXT NOT NULL,
          content TEXT,
          color TEXT DEFAULT '#6366f1',
          pinned INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS collab_polls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          options TEXT NOT NULL,
          multiple INTEGER DEFAULT 0,
          closed INTEGER DEFAULT 0,
          deadline TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS collab_poll_votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_id INTEGER NOT NULL REFERENCES collab_polls(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          option_index INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(poll_id, user_id, option_index)
        );
        CREATE TABLE IF NOT EXISTS collab_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          reply_to INTEGER REFERENCES collab_messages(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_collab_notes_trip ON collab_notes(trip_id);
        CREATE INDEX IF NOT EXISTS idx_collab_polls_trip ON collab_polls(trip_id);
        CREATE INDEX IF NOT EXISTS idx_collab_messages_trip ON collab_messages(trip_id);
      `);
      // Ensure collab addon exists for existing installations
      try {
        _db.prepare("INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES ('collab', 'Collab', 'Notes, polls, and live chat for trip collaboration', 'trip', 'Users', 1, 6)").run();
      } catch {}
    },
    // 26: Per-assignment times (instead of shared place times)
    () => {
      try { _db.exec('ALTER TABLE day_assignments ADD COLUMN assignment_time TEXT'); } catch {}
      try { _db.exec('ALTER TABLE day_assignments ADD COLUMN assignment_end_time TEXT'); } catch {}
      // Copy existing place times to assignments as initial values
      try {
        _db.exec(`
          UPDATE day_assignments SET
            assignment_time = (SELECT place_time FROM places WHERE places.id = day_assignments.place_id),
            assignment_end_time = (SELECT end_time FROM places WHERE places.id = day_assignments.place_id)
        `);
      } catch {}
    },
    // 27: Budget item members (per-person expense tracking)
    () => {
      _db.exec(`
        CREATE TABLE IF NOT EXISTS budget_item_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          budget_item_id INTEGER NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          paid INTEGER NOT NULL DEFAULT 0,
          UNIQUE(budget_item_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_budget_item_members_item ON budget_item_members(budget_item_id);
        CREATE INDEX IF NOT EXISTS idx_budget_item_members_user ON budget_item_members(user_id);
      `);
    },
    // 28: Message reactions
    () => {
      _db.exec(`
        CREATE TABLE IF NOT EXISTS collab_message_reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL REFERENCES collab_messages(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          emoji TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(message_id, user_id, emoji)
        );
        CREATE INDEX IF NOT EXISTS idx_collab_reactions_msg ON collab_message_reactions(message_id);
      `);
    },
    // 29: Soft-delete for chat messages
    () => {
      try { _db.exec('ALTER TABLE collab_messages ADD COLUMN deleted INTEGER DEFAULT 0'); } catch {}
    },
    // 30: Note attachments + website field
    () => {
      try { _db.exec('ALTER TABLE trip_files ADD COLUMN note_id INTEGER REFERENCES collab_notes(id) ON DELETE SET NULL'); } catch {}
      try { _db.exec('ALTER TABLE collab_notes ADD COLUMN website TEXT'); } catch {}
    },
    // 31: Add is_demo flag to users
    () => {
      try { _db.exec('ALTER TABLE users ADD COLUMN is_demo INTEGER DEFAULT 0'); } catch {}
    },
    // 32: Flight-specific fields on reservations
    () => {
      try { _db.exec('ALTER TABLE reservations ADD COLUMN flight_number TEXT'); } catch {}
      try { _db.exec('ALTER TABLE reservations ADD COLUMN airline TEXT'); } catch {}
      try { _db.exec('ALTER TABLE reservations ADD COLUMN departure_airport TEXT'); } catch {}
      try { _db.exec('ALTER TABLE reservations ADD COLUMN arrival_airport TEXT'); } catch {}
    },
    // 33: Aviation API key for flight lookups
    () => {
      try { _db.exec('ALTER TABLE users ADD COLUMN aviation_api_key TEXT'); } catch {}
    },
    // Future migrations go here (append only, never reorder)
  ];

  if (currentVersion < migrations.length) {
    for (let i = currentVersion; i < migrations.length; i++) {
      console.log(`[DB] Running migration ${i + 1}/${migrations.length}`);
      migrations[i]();
    }
    _db.prepare('UPDATE schema_version SET version = ?').run(migrations.length);
    console.log(`[DB] Migrations complete — schema version ${migrations.length}`);
  }

  // First registered user becomes admin — no default admin seed needed

  // Seed: default categories
  try {
    const existingCats = _db.prepare('SELECT COUNT(*) as count FROM categories').get();
    if (existingCats.count === 0) {
      const defaultCategories = [
        { name: 'Hotel', color: '#3b82f6', icon: '🏨' },
        { name: 'Restaurant', color: '#ef4444', icon: '🍽️' },
        { name: 'Attraction', color: '#8b5cf6', icon: '🏛️' },
        { name: 'Shopping', color: '#f59e0b', icon: '🛍️' },
        { name: 'Transport', color: '#6b7280', icon: '🚌' },
        { name: 'Activity', color: '#10b981', icon: '🎯' },
        { name: 'Bar/Cafe', color: '#f97316', icon: '☕' },
        { name: 'Beach', color: '#06b6d4', icon: '🏖️' },
        { name: 'Nature', color: '#84cc16', icon: '🌿' },
        { name: 'Other', color: '#6366f1', icon: '📍' },
      ];
      const insertCat = _db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
      for (const cat of defaultCategories) insertCat.run(cat.name, cat.color, cat.icon);
      console.log('Default categories seeded');
    }
  } catch (err) {
    console.error('Error seeding categories:', err.message);
  }

  // Seed: default addons (INSERT OR IGNORE so migration-inserted rows don't block seeding)
  try {
    const defaultAddons = [
      { id: 'packing', name: 'Packing List', description: 'Pack your bags with checklists per trip', type: 'trip', icon: 'ListChecks', enabled: 1, sort_order: 0 },
      { id: 'budget', name: 'Budget Planner', description: 'Track expenses and plan your travel budget', type: 'trip', icon: 'Wallet', enabled: 1, sort_order: 1 },
      { id: 'documents', name: 'Documents', description: 'Store and manage travel documents', type: 'trip', icon: 'FileText', enabled: 1, sort_order: 2 },
      { id: 'vacay', name: 'Vacay', description: 'Personal vacation day planner with calendar view', type: 'global', icon: 'CalendarDays', enabled: 1, sort_order: 10 },
      { id: 'atlas', name: 'Atlas', description: 'World map of your visited countries with travel stats', type: 'global', icon: 'Globe', enabled: 1, sort_order: 11 },
      { id: 'collab', name: 'Collab', description: 'Notes, polls, and live chat for trip collaboration', type: 'trip', icon: 'Users', enabled: 1, sort_order: 6 },
    ];
    const insertAddon = _db.prepare('INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const a of defaultAddons) insertAddon.run(a.id, a.name, a.description, a.type, a.icon, a.enabled, a.sort_order);
    console.log('Default addons seeded');
  } catch (err) {
    console.error('Error seeding addons:', err.message);
  }
}

// Initialize on module load
initDb();

// Demo mode: seed admin + demo user + example trips
if (process.env.DEMO_MODE === 'true') {
  try {
    const { seedDemoData } = require('../demo/demo-seed');
    seedDemoData(_db);
    // Ensure the demo user is marked with is_demo = 1
    try {
      _db.prepare("UPDATE users SET is_demo = 1 WHERE email = 'demo@nomad.app'").run();
    } catch {}
  } catch (err) {
    console.error('[Demo] Seed error:', err.message);
  }
}

// Proxy so all route modules always use the current _db instance
// without needing a server restart after reinitialize()
const db = new Proxy({}, {
  get(_, prop) {
    if (!_db) throw new Error('Database connection is not available (restore in progress?)');
    const val = _db[prop];
    return typeof val === 'function' ? val.bind(_db) : val;
  },
  set(_, prop, val) {
    _db[prop] = val;
    return true;
  },
});

function closeDb() {
  if (_db) {
    try { _db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    try { _db.close(); } catch (e) {}
    _db = null;
    console.log('[DB] Database connection closed');
  }
}

function reinitialize() {
  console.log('[DB] Reinitializing database connection after restore...');
  // initDb handles close + reopen, but if closeDb was already called, _db is null
  if (_db) closeDb();
  initDb();
  console.log('[DB] Database reinitialized successfully');
}

function getPlaceWithTags(placeId) {
  const place = _db.prepare(`
    SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `).get(placeId);

  if (!place) return null;

  const tags = _db.prepare(`
    SELECT t.* FROM tags t
    JOIN place_tags pt ON t.id = pt.tag_id
    WHERE pt.place_id = ?
  `).all(placeId);

  return {
    ...place,
    category: place.category_id ? {
      id: place.category_id,
      name: place.category_name,
      color: place.category_color,
      icon: place.category_icon,
    } : null,
    tags,
  };
}

function canAccessTrip(tripId, userId) {
  return _db.prepare(`
    SELECT t.id, t.user_id FROM trips t
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
    WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)
  `).get(userId, tripId, userId);
}

function isOwner(tripId, userId) {
  return !!_db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId);
}

module.exports = { db, closeDb, reinitialize, getPlaceWithTags, canAccessTrip, isOwner };
