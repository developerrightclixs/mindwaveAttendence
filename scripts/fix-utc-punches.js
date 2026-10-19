'use strict';
require('../src/lib/timezone').applyTimezone();
/**
 * Repair punches recorded while the server ran in the wrong timezone.
 *
 *   node scripts/fix-utc-punches.js --hours=5                 # preview only
 *   node scripts/fix-utc-punches.js --hours=5 --commit        # write it
 *   node scripts/fix-utc-punches.js --hours=5 --from=2026-10-01 --to=2026-10-16
 *
 * Until the timezone was pinned, a cloud host stamped live punches in UTC: a
 * 20:49 check-in went into the database as 15:49. The hours are still right -
 * the duration between an in and an out is unaffected - but the clock times
 * are wrong by the offset, and for a night shift the wrong clock time can also
 * put the punch on the wrong business date.
 *
 * Only punches the SERVER stamped are touched: source 'web' and 'kiosk'. A
 * punch an admin corrected, or one an employee entered for a past night, was
 * typed as a wall-clock time by a human and is already right - shifting those
 * would break records that were never broken.
 *
 * It is a preview unless you pass --commit, and it refuses to run twice over
 * the same dates, because shifting an already-shifted punch is not something
 * you can spot afterwards.
 */
const { init, all, tx, pool, audit, getSetting, setSetting } = require('../src/db');
const { parseStamp, isoStamp, isoDate } = require('../src/lib/dates');
const { resolveWorkDate } = require('../src/lib/attendance');

const LEDGER = 'utc_punch_repairs';
// Stamped by the server clock; these are the ones that inherited its timezone.
const SERVER_SOURCES = ['web', 'kiosk'];

const arg = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** Shift "YYYY-MM-DD HH:MM:SS" by whole hours, rolling the date as needed. */
function shiftStamp(stamp, hours) {
  const d = parseStamp(stamp);
  d.setHours(d.getHours() + hours);
  return isoStamp(d);
}

async function readLedger() {
  const raw = await getSetting(LEDGER, '[]');
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function main() {
  const hours = Number(arg('hours'));
  if (!Number.isFinite(hours) || hours === 0 || Math.abs(hours) > 23) {
    throw new Error(
      'Pass --hours=<n>: how far to move each punch. Pakistan on a UTC host is '
      + '--hours=5 (the stored time is 5 hours behind what the clock said).');
  }
  const from = arg('from', '0000-01-01');
  const to = arg('to', '9999-12-31');
  const commit = flag('commit');

  await init();

  // --- refuse a double shift ------------------------------------------------
  const ledger = await readLedger();
  const clash = ledger.find((r) => !(r.to < from || r.from > to));
  if (clash && !flag('force')) {
    throw new Error(
      `Punches from ${clash.from} to ${clash.to} were already shifted by `
      + `${clash.hours}h on ${clash.at}. Shifting them again would move them `
      + `twice. Narrow the range, or pass --force if you are certain.`);
  }

  // --- gather ---------------------------------------------------------------
  const rows = await all(
    `SELECT p.id, p.employee_id, p.punched_at, p.work_date, p.kind, p.source,
            e.name AS employee, e.emp_code,
            s.start_time, s.end_time
     FROM punches p
     JOIN employees e ON e.id = p.employee_id
     LEFT JOIN shifts s ON s.id = e.shift_id
     WHERE p.source IN (${SERVER_SOURCES.map(() => '?').join(',')})
       AND p.work_date BETWEEN ? AND ?
     ORDER BY p.punched_at, p.id`,
    ...SERVER_SOURCES, from, to);

  if (!rows.length) {
    console.log('Nothing to do: no server-recorded punches in that range.');
    return;
  }

  const changes = rows.map((r) => {
    const shift = r.start_time && r.end_time
      ? { start_time: r.start_time, end_time: r.end_time }
      : null;
    const punchedAt = shiftStamp(r.punched_at, hours);
    return {
      id: r.id,
      who: `${r.emp_code} ${r.employee}`,
      kind: r.kind,
      source: r.source,
      from: r.punched_at,
      to: punchedAt,
      workDateFrom: r.work_date,
      workDateTo: resolveWorkDate(shift, punchedAt),
    };
  });

  // --- report ---------------------------------------------------------------
  const movedDate = changes.filter((c) => c.workDateFrom !== c.workDateTo);
  console.log(`\n  ${commit ? 'Shifting' : 'Would shift'} ${changes.length} punch`
    + `${changes.length === 1 ? '' : 'es'} by ${hours > 0 ? '+' : ''}${hours}h`
    + ` (sources: ${SERVER_SOURCES.join(', ')})`);
  console.log(`  Business date changes for ${movedDate.length} of them.\n`);

  for (const c of changes.slice(0, 40)) {
    const date = c.workDateFrom === c.workDateTo
      ? `  ${c.workDateFrom}`
      : `  ${c.workDateFrom} -> ${c.workDateTo}  <-- business date moves`;
    console.log(`  ${c.who.padEnd(26)} ${c.kind.padEnd(3)} `
      + `${c.from} -> ${c.to}${date}`);
  }
  if (changes.length > 40) console.log(`  ... and ${changes.length - 40} more`);

  if (!commit) {
    console.log('\n  Preview only. Re-run with --commit to write it.\n');
    return;
  }

  // --- write ----------------------------------------------------------------
  // One transaction: a half-shifted month is worse than an unshifted one.
  await tx(async (q) => {
    for (const c of changes) {
      await q.run(
        'UPDATE punches SET punched_at = ?, work_date = ? WHERE id = ?',
        c.to, c.workDateTo, c.id);
    }
  });

  ledger.push({
    from: from === '0000-01-01' ? (changes[0].workDateTo) : from,
    to: to === '9999-12-31' ? changes[changes.length - 1].workDateTo : to,
    hours,
    punches: changes.length,
    at: isoDate(),
  });
  await setSetting(LEDGER, JSON.stringify(ledger));

  await audit(null, 'punches.timezone_repair', null,
    `${changes.length} punches shifted by ${hours}h; `
    + `${movedDate.length} moved business date`);

  console.log(`\n  Done. ${changes.length} punches updated.\n`);
}

main()
  .catch((e) => {
    console.error(`\n  ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
