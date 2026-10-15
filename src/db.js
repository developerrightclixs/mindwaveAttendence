'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  || path.join(__dirname, '..', 'data', 'attendance.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/**
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
 * exists, so a schema change would silently skip live databases. Each entry
 * here is an additive column that is applied once if missing.
 */
const COLUMN_MIGRATIONS = [
  ['shifts', 'break_after_minutes', 'INTEGER NOT NULL DEFAULT 360'],
  ['audit_log', 'actor_name', 'TEXT'],
];

function migrateColumns() {
  for (const [table, column, decl] of COLUMN_MIGRATIONS) {
    const exists = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      console.log(`[db] migrated: ${table}.${column}`);
    }
  }
}
migrateColumns();

/**
 * SQLite cannot alter a CHECK constraint, so widening one means rebuilding the
 * table. Done inside a transaction with foreign keys briefly off, which is the
 * documented procedure; rows are copied across untouched.
 */
function migratePunchSource() {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='punches'").get();
  if (!row || row.sql.includes("'self'")) return;

  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE punches_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        punched_at   TEXT    NOT NULL,
        work_date    TEXT    NOT NULL,
        kind         TEXT    NOT NULL CHECK (kind IN ('in','out')),
        source       TEXT    NOT NULL DEFAULT 'web'
                     CHECK (source IN ('web','kiosk','admin','import','self')),
        note         TEXT,
        created_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO punches_new
        SELECT id, employee_id, punched_at, work_date, kind, source, note,
               created_by, created_at FROM punches;
      DROP TABLE punches;
      ALTER TABLE punches_new RENAME TO punches;
      CREATE INDEX IF NOT EXISTS idx_punches_emp_date ON punches(employee_id, work_date);
      CREATE INDEX IF NOT EXISTS idx_punches_date     ON punches(work_date);
    `);
  })();
  db.pragma('foreign_keys = ON');
  console.log('[db] migrated: punches.source now allows self-entry');
}
migratePunchSource();

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, String(value));
}

function audit(actorId, action, target, detail) {
  // Capture the name now. The id alone is not enough: it is set to NULL if the
  // employee is ever deleted, and an audit entry with no actor is useless.
  let actorName = null;
  if (actorId != null) {
    const row = db.prepare('SELECT name FROM employees WHERE id = ?').get(actorId);
    if (row) actorName = row.name;
  }
  db.prepare(`INSERT INTO audit_log (actor_id, actor_name, action, target, detail)
              VALUES (?, ?, ?, ?, ?)`)
    .run(actorId ?? null, actorName, action, target ?? null,
         detail == null ? null : String(detail));
}

/** Fill in actor_name for rows written before the column existed. */
function backfillAuditNames() {
  const n = db.prepare(`
    UPDATE audit_log SET actor_name = (
      SELECT e.name FROM employees e WHERE e.id = audit_log.actor_id
    )
    WHERE actor_name IS NULL AND actor_id IS NOT NULL`).run().changes;
  if (n) console.log(`[db] backfilled ${n} audit actor name(s)`);
}
backfillAuditNames();

module.exports = { db, DB_PATH, getSetting, setSetting, audit };
