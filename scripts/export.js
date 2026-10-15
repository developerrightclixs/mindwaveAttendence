'use strict';
/**
 * Export the whole database to a JSON file.
 *
 *   node scripts/export.js [outfile]
 *
 * Supabase takes its own backups, so this is not the disaster-recovery plan -
 * it is for moving between projects, keeping an off-platform copy, and being
 * able to read your own data without a Postgres client.
 */
const fs = require('node:fs');
const path = require('node:path');
const { init, all, pool } = require('../src/db');

const TABLES = ['departments', 'shifts', 'employees', 'punches',
  'day_overrides', 'holidays', 'audit_log', 'settings'];

(async () => {
  await init();
  const out = { exported_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    out.tables[t] = await all(`SELECT * FROM ${t}`);
    console.log(`  ${t.padEnd(16)} ${out.tables[t].length} rows`);
  }

  // Password and PIN hashes are in here. Anyone holding this file holds the
  // means to crack them offline, so say so rather than let it look inert.
  out.warning = 'Contains bcrypt password and PIN hashes. Store it like a password.';

  const file = process.argv[2]
    || path.join(__dirname, '..', `export-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`\n  Written to ${file}`);
  console.log('  This file contains password hashes - keep it somewhere safe.');
  await pool.end();
})().catch((e) => {
  console.error('Export failed:', e.message.split('\n')[0]);
  process.exit(1);
});
