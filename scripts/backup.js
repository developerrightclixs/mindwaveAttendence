'use strict';
/**
 * Back up the attendance database safely while the server is running.
 *
 *   node scripts/backup.js                  -> backups/attendance-YYYY-MM-DD-HHMM.db
 *   node scripts/backup.js D:\\path\\to\\dir   -> same, in a directory you choose
 *
 * Copying the .db file with Explorer or `copy` while the server is live can
 * produce a torn file, because SQLite keeps recent writes in a separate -wal
 * file. This uses SQLite's own online backup, which takes a consistent
 * snapshot of everything including the WAL, then verifies the result opens and
 * holds the expected rows.
 *
 * Old backups are pruned, keeping the most recent KEEP files.
 */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const KEEP = Number(process.env.BACKUP_KEEP || 30);

const SOURCE = process.env.DB_PATH
  || path.join(__dirname, '..', 'data', 'attendance.db');

const outDir = process.argv[2]
  || process.env.BACKUP_DIR
  || path.join(__dirname, '..', 'backups');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`No database at ${SOURCE}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const target = path.join(outDir, `attendance-${stamp()}.db`);
  if (fs.existsSync(target)) {
    console.error(`Refusing to overwrite an existing backup: ${target}`);
    process.exit(1);
  }
  const db = new Database(SOURCE, { readonly: true });

  // better-sqlite3 exposes SQLite's online backup API and returns a promise.
  await db.backup(target);
  db.close();

  // Take the copy out of WAL mode so each backup is ONE self-contained file.
  // A WAL database needs -wal/-shm sidecars the moment anything opens it, so a
  // backup left in WAL mode spawns extra files whenever it is inspected and is
  // easy to copy incompletely. journal_mode=DELETE folds everything into the
  // single .db, which can then be copied or emailed on its own.
  const fold = new Database(target);
  fold.pragma('journal_mode = DELETE');
  fold.close();

  // A backup nobody has opened is a guess, not a backup. Verify it.
  const check = new Database(target, { readonly: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  const employees = check.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
  const punches = check.prepare('SELECT COUNT(*) AS n FROM punches').get().n;
  check.close();

  if (integrity !== 'ok') {
    console.error(`Backup failed integrity check: ${integrity}`);
    fs.unlinkSync(target);
    process.exit(1);
  }

  // Opening the file to verify it can leave WAL sidecars behind; a backup
  // directory should contain backups and nothing else.
  for (const ext of ['-wal', '-shm']) {
    const stray = target + ext;
    if (fs.existsSync(stray)) fs.unlinkSync(stray);
  }

  const size = (fs.statSync(target).size / 1024).toFixed(0);
  console.log(`Backup OK  ${target}`);
  console.log(`  ${size} KB, ${employees} employees, ${punches} punches, integrity ${integrity}`);

  // Prune, newest first.
  const old = fs.readdirSync(outDir)
    .filter((f) => /^attendance-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(KEEP);
  for (const o of old) {
    fs.unlinkSync(path.join(outDir, o.f));
    console.log(`  pruned ${o.f}`);
  }

  // Sweep sidecars left by any earlier version of this script.
  for (const f of fs.readdirSync(outDir)) {
    if (/\.db-(wal|shm)$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  }
}

main().catch((e) => {
  console.error(`Backup failed: ${e.message}`);
  process.exit(1);
});
