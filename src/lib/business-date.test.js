'use strict';
/**
 * Which business date is "now" on a night shift.
 *
 * This is the bug that would have shown an empty register to a room full of
 * working people: between midnight and the early afternoon, the calendar date
 * has moved on but the night in progress has not.
 */
const test = require('node:test');
const assert = require('node:assert');
const { resolveWorkDate } = require('./attendance');

const NIGHT = { start_time: '20:00', end_time: '05:00' };   // the org's shift
const DAY = { start_time: '09:00', end_time: '18:00' };

/** Walk one clock time and report the night it belongs to. */
const at = (shift, stamp) => resolveWorkDate(shift, stamp);

test('the whole of a night shift resolves to one business date', () => {
  // Team clocks in Thu 20:00 and out Fri 05:00. Every moment in between must
  // agree that the night in progress is Thursday's.
  const thursdayNight = '2026-10-15';
  for (const stamp of [
    '2026-10-15 19:45:00',   // arriving early
    '2026-10-15 20:00:00',   // on time
    '2026-10-15 23:59:00',   // before midnight
    '2026-10-16 00:00:00',   // midnight
    '2026-10-16 00:01:00',
    '2026-10-16 01:00:00',   // the hour that broke it
    '2026-10-16 03:30:00',
    '2026-10-16 05:00:00',   // clocking out
    '2026-10-16 05:45:00',   // leaving late
    '2026-10-16 11:00:00',   // still before the cut-over
  ]) {
    assert.equal(at(NIGHT, stamp), thursdayNight,
      `${stamp} should belong to the night of ${thursdayNight}`);
  }
});

test('the next night begins only after the cut-over', () => {
  assert.equal(at(NIGHT, '2026-10-16 12:29:00'), '2026-10-15');
  assert.equal(at(NIGHT, '2026-10-16 12:30:00'), '2026-10-16');
  assert.equal(at(NIGHT, '2026-10-16 18:00:00'), '2026-10-16');
});

test('a day shift never diverges from the calendar date', () => {
  for (const t of ['00:30', '06:00', '09:00', '13:00', '18:00', '23:30']) {
    assert.equal(at(DAY, `2026-10-16 ${t}:00`), '2026-10-16');
  }
});

test('an unassigned employee falls back to the calendar date', () => {
  assert.equal(at(null, '2026-10-16 01:00:00'), '2026-10-16');
});

test('a night is a contiguous run of business dates across a week', () => {
  // Monday 20:00 through Saturday 05:00 should yield exactly five nights,
  // Mon-Fri, with no night counted twice or skipped.
  const nights = new Set();
  for (let day = 12; day <= 17; day++) {
    for (const t of ['20:30', '23:00']) {
      if (day === 17) continue;                 // Sat evening is off
      nights.add(at(NIGHT, `2026-10-${day} ${t}:00`));
    }
    for (const t of ['01:00', '04:30']) {
      if (day === 12) continue;                 // no night ended Mon morning
      nights.add(at(NIGHT, `2026-10-${day} ${t}:00`));
    }
  }
  // Mon 12 through Fri 16 - five nights, none duplicated, none skipped.
  assert.deepEqual([...nights].sort(),
    ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.equal(nights.size, 5);
});

test('the cut-over sits inside the off-shift gap for any overnight shift', () => {
  // Whatever the hours, the split must fall when nobody is scheduled, so it
  // can never cut a shift in half.
  const shifts = [
    { start_time: '20:00', end_time: '05:00' },
    { start_time: '22:00', end_time: '06:00' },
    { start_time: '18:00', end_time: '02:00' },
    { start_time: '23:00', end_time: '07:00' },
  ];
  for (const s of shifts) {
    const start = Number(s.start_time.slice(0, 2)) * 60;
    const end = Number(s.end_time.slice(0, 2)) * 60;
    const cut = Math.floor((end + start) / 2);
    assert.ok(cut > end && cut < start,
      `cut-over ${cut} must lie between ${end} and ${start} for ${s.start_time}-${s.end_time}`);
    // A punch one minute before the shift starts belongs to that shift.
    const h = String(Math.floor((start - 1) / 60)).padStart(2, '0');
    const m = String((start - 1) % 60).padStart(2, '0');
    assert.equal(at(s, `2026-10-16 ${h}:${m}:00`), '2026-10-16');
  }
});

// --- liveness of a shift that is mid-run across midnight -------------------

const { evaluateDay } = require('./attendance');

/**
 * Whether a day counts as "running now" is decided by comparing its business
 * date to the business date of the current moment - NOT to the calendar date.
 * This mirrors the check inside dayRegister/employeeDays.
 */
const isLive = (shift, businessDate, nowStamp) =>
  businessDate === resolveWorkDate(shift, nowStamp);

test('a night shift is still live just after midnight', () => {
  // 00:06 on the 16th: the night of the 15th is four hours old and running.
  assert.equal(isLive(NIGHT, '2026-10-15', '2026-10-16 00:06:00'), true);
  assert.equal(isLive(NIGHT, '2026-10-15', '2026-10-16 03:30:00'), true);
  assert.equal(isLive(NIGHT, '2026-10-15', '2026-10-16 04:59:00'), true);
});

test('a night is no longer live once the next night has begun', () => {
  assert.equal(isLive(NIGHT, '2026-10-15', '2026-10-16 20:30:00'), false);
  assert.equal(isLive(NIGHT, '2026-10-16', '2026-10-16 20:30:00'), true);
});

test('an open check-in after midnight counts as work, not a missing punch', () => {
  // The regression: at 00:06 the calendar date has rolled over, and comparing
  // it instead of the business date reported everyone still at work as a
  // forgotten check-out with zero minutes worked.
  const now = '2026-10-16 00:06:00';
  const businessDate = '2026-10-15';
  const live = isLive(NIGHT, businessDate, now) ? now : null;

  const d = evaluateDay({
    date: businessDate,
    shift: { ...NIGHT, grace_minutes: 10, break_minutes: 0, break_after_minutes: 0,
             half_day_minutes: 270, min_present_minutes: 60,
             overtime_after_minutes: 540, overtime_grace_minutes: 15, weekly_off: '6,7' },
    punches: [{ punched_at: '2026-10-15 20:01:00', work_date: businessDate, kind: 'in' }],
    nowStamp: live,
    todayDate: businessDate,
  });

  assert.equal(d.stillIn, true);
  assert.equal(d.inProgress, true);
  assert.deepEqual(d.problems, []);        // NOT "never closed"
  assert.equal(d.workedMinutes, 245);      // 20:01 -> 00:06
});

test('an open check-in from a finished night is still a missing punch', () => {
  // The guard must not swallow genuine forgotten check-outs.
  const now = '2026-10-16 20:30:00';       // the NEXT night has started
  const businessDate = '2026-10-15';
  const live = isLive(NIGHT, businessDate, now) ? now : null;

  const d = evaluateDay({
    date: businessDate,
    shift: NIGHT,
    punches: [{ punched_at: '2026-10-15 20:01:00', work_date: businessDate, kind: 'in' }],
    nowStamp: live,
    todayDate: '2026-10-16',
  });

  assert.equal(live, null);
  assert.equal(d.problems.length, 1);
  assert.match(d.problems[0], /never closed/);
  assert.equal(d.workedMinutes, 0);
});

test('a day shift is live only during its own calendar day', () => {
  assert.equal(isLive(DAY, '2026-10-16', '2026-10-16 13:00:00'), true);
  assert.equal(isLive(DAY, '2026-10-15', '2026-10-16 00:06:00'), false);
});
