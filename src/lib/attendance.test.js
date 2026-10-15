'use strict';
/**
 * Rules-engine tests. Run with: node --test src/lib/
 * No test framework needed - node:test ships with Node.
 */
const test = require('node:test');
const assert = require('node:assert');
const { evaluateDay, summarise, expectedMinutes, shiftWindow } = require('./attendance');

const DAY = '2026-10-15';        // a Thursday
const SAT = '2026-10-17';        // a Saturday -> weekly off under '6,7'

const SHIFT = {
  name: 'General', start_time: '09:00', end_time: '18:00',
  grace_minutes: 10, break_minutes: 60, break_after_minutes: 360,
  half_day_minutes: 240,
  min_present_minutes: 60, overtime_after_minutes: 480,
  overtime_grace_minutes: 15, weekly_off: '6,7',
};

const NIGHT = {
  ...SHIFT, name: 'Night', start_time: '22:00', end_time: '06:00',
};

/** Terse punch builder. p('09:00','in') */
const p = (time, kind, date = DAY) => ({
  punched_at: `${date} ${time}:00`, work_date: DAY, kind,
});

const evalDay = (punches, extra = {}) =>
  evaluateDay({ date: DAY, shift: SHIFT, punches, ...extra });

// --- shift window ----------------------------------------------------------

test('day shift window is a plain span', () => {
  const w = shiftWindow(SHIFT);
  assert.equal(w.start, 540);
  assert.equal(w.end, 1080);
  assert.equal(w.overnight, false);
  assert.equal(expectedMinutes(SHIFT), 480); // 9h span - 1h break
});

test('overnight shift end rolls past midnight', () => {
  const w = shiftWindow(NIGHT);
  assert.equal(w.start, 1320);        // 22:00
  assert.equal(w.end, 1800);          // 06:00 next day
  assert.equal(w.overnight, true);
  assert.equal(expectedMinutes(NIGHT), 420);
});

// --- the ordinary day ------------------------------------------------------

test('on-time full day is present with no flags', () => {
  const d = evalDay([p('09:00', 'in'), p('18:00', 'out')]);
  assert.equal(d.status, 'present');
  assert.equal(d.workedMinutes, 480);   // 540 gross - 60 break
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.earlyMinutes, 0);
  assert.equal(d.overtimeMinutes, 0);
  assert.equal(d.dayCredit, 1);
  assert.deepEqual(d.problems, []);
});

test('arrival inside grace is not late', () => {
  const d = evalDay([p('09:08', 'in'), p('18:00', 'out')]);
  assert.equal(d.status, 'present');
  assert.equal(d.lateMinutes, 0);
});

test('lateness is measured from shift start, not from end of grace', () => {
  const d = evalDay([p('09:15', 'in'), p('18:00', 'out')]);
  assert.equal(d.status, 'late');
  assert.equal(d.lateMinutes, 15);      // not 5
});

test('leaving before shift end records early exit', () => {
  const d = evalDay([p('09:00', 'in'), p('16:30', 'out')]);
  assert.equal(d.earlyMinutes, 90);
  assert.equal(d.workedMinutes, 390);
});

// --- break handling --------------------------------------------------------

test('break is deducted when the employee never punches out for lunch', () => {
  const d = evalDay([p('09:00', 'in'), p('18:00', 'out')]);
  assert.equal(d.grossMinutes, 540);
  assert.equal(d.breakMinutes, 60);
  assert.equal(d.workedMinutes, 480);
});

test('a punched-out lunch is not charged twice', () => {
  // Out 13:00-14:00 is a real 60m gap, so no further deduction.
  const d = evalDay([
    p('09:00', 'in'), p('13:00', 'out'),
    p('14:00', 'in'), p('18:00', 'out'),
  ]);
  assert.equal(d.grossMinutes, 480);
  assert.equal(d.breakMinutes, 0);
  assert.equal(d.workedMinutes, 480);
  assert.equal(d.status, 'present');
});

test('a short lunch is topped up to the full break', () => {
  // Only 20m taken out of a 60m break -> 40m still owed.
  const d = evalDay([
    p('09:00', 'in'), p('13:00', 'out'),
    p('13:20', 'in'), p('18:00', 'out'),
  ]);
  assert.equal(d.grossMinutes, 520);
  assert.equal(d.breakMinutes, 40);
  assert.equal(d.workedMinutes, 480);
});

test('a very short visit is not charged a break at all', () => {
  const d = evalDay([p('09:00', 'in'), p('09:30', 'out')]);
  assert.equal(d.breakMinutes, 0);
  assert.equal(d.workedMinutes, 30);
  assert.equal(d.status, 'absent');     // under min_present_minutes
});

// --- overtime --------------------------------------------------------------

test('overtime accrues past the threshold', () => {
  const d = evalDay([p('09:00', 'in'), p('20:00', 'out')]);
  assert.equal(d.workedMinutes, 600);
  assert.equal(d.overtimeMinutes, 120);
});

test('trivial overruns are ignored by overtime grace', () => {
  const d = evalDay([p('09:00', 'in'), p('18:05', 'out')]);
  assert.equal(d.workedMinutes, 485);
  assert.equal(d.overtimeMinutes, 0);   // 5m < 15m grace
});

test('overtime grace is a threshold, not a deduction', () => {
  const d = evalDay([p('09:00', 'in'), p('18:20', 'out')]);
  assert.equal(d.overtimeMinutes, 20);  // not 5
});

// --- half day and absence --------------------------------------------------

test('a short day is a half day and is charged no lunch break', () => {
  const d = evalDay([p('09:00', 'in'), p('12:30', 'out')]);
  assert.equal(d.grossMinutes, 210);
  assert.equal(d.breakMinutes, 0);     // under break_after_minutes
  assert.equal(d.workedMinutes, 210);
  assert.equal(d.status, 'half_day');
  assert.equal(d.dayCredit, 0.5);
});

test('the break starts applying only past the entitlement threshold', () => {
  // 6h01m gross crosses break_after_minutes (360) and is charged the break.
  const over = evalDay([p('09:00', 'in'), p('15:01', 'out')]);
  assert.equal(over.breakMinutes, 60);
  assert.equal(over.workedMinutes, 301);
  // Exactly 6h does not.
  const under = evalDay([p('09:00', 'in'), p('15:00', 'out')]);
  assert.equal(under.breakMinutes, 0);
  assert.equal(under.workedMinutes, 360);
});

test('no punches on a working day is absent', () => {
  const d = evalDay([]);
  assert.equal(d.status, 'absent');
  assert.equal(d.dayCredit, 0);
  assert.equal(d.expectedMinutes, 480);
});

test('a late arrival that is also short is a half day, not late', () => {
  const d = evalDay([p('11:00', 'in'), p('14:00', 'out')]);
  assert.equal(d.workedMinutes, 180);
  assert.equal(d.status, 'half_day');
  assert.equal(d.lateMinutes, 120);     // still recorded for the report
});

// --- messy punch streams ---------------------------------------------------

test('forgotten check-out on a past day is flagged, not counted', () => {
  const d = evalDay([p('09:00', 'in')]);
  assert.equal(d.workedMinutes, 0);
  assert.equal(d.problems.length, 1);
  assert.match(d.problems[0], /never closed/);
});

test('open session on the current day counts time so far', () => {
  const d = evalDay([p('09:00', 'in')], { nowStamp: `${DAY} 13:00:00` });
  assert.equal(d.stillIn, true);
  assert.equal(d.grossMinutes, 240);
  assert.equal(d.problems.length, 0);
  assert.equal(d.lastOut, null);
});

test('an open session suppresses the early-exit flag', () => {
  const d = evalDay([p('09:00', 'in')], { nowStamp: `${DAY} 13:00:00` });
  assert.equal(d.earlyMinutes, 0);
});

test('double check-in keeps the later one and flags the first', () => {
  const d = evalDay([p('09:00', 'in'), p('09:30', 'in'), p('18:00', 'out')]);
  assert.equal(d.problems.length, 1);
  assert.equal(d.firstInClock, '09:30');
  assert.equal(d.grossMinutes, 510);
});

test('check-out with no check-in is reported', () => {
  const d = evalDay([p('18:00', 'out')]);
  assert.equal(d.problems.length, 1);
  assert.match(d.problems[0], /no check-in/);
  assert.equal(d.status, 'absent');
});

test('punches arriving out of order are still paired correctly', () => {
  const d = evalDay([p('18:00', 'out'), p('09:00', 'in')]);
  assert.equal(d.workedMinutes, 480);
  assert.deepEqual(d.problems, []);
});

// --- non-working days ------------------------------------------------------

test('Saturday with no punches is weekly off and expects nothing', () => {
  const d = evaluateDay({ date: SAT, shift: SHIFT, punches: [] });
  assert.equal(d.status, 'weekly_off');
  assert.equal(d.expectedMinutes, 0);
  assert.equal(d.dayCredit, 0);
});

test('work on a weekly off is all overtime and never late', () => {
  const d = evaluateDay({
    date: SAT,
    shift: SHIFT,
    punches: [
      { punched_at: `${SAT} 10:30:00`, work_date: SAT, kind: 'in' },
      { punched_at: `${SAT} 15:30:00`, work_date: SAT, kind: 'out' },
    ],
  });
  // 5h gross, under the break entitlement, so nothing is deducted.
  assert.equal(d.workedMinutes, 300);
  assert.equal(d.overtimeMinutes, 300);
  assert.equal(d.lateMinutes, 0);
});

test('a holiday wins over derived status', () => {
  const d = evalDay([], { holiday: { work_date: DAY, name: 'Founders Day' } });
  assert.equal(d.status, 'holiday');
  assert.equal(d.note, 'Founders Day');
  assert.equal(d.expectedMinutes, 0);
});

test('an HR override wins over everything, including punches', () => {
  const d = evalDay([p('09:00', 'in'), p('18:00', 'out')], {
    override: { status: 'leave', note: 'Approved sick leave' },
  });
  assert.equal(d.status, 'leave');
  assert.equal(d.note, 'Approved sick leave');
});

test('dates before joining are not held against the employee', () => {
  const d = evalDay([], { joinedOn: '2026-11-01' });
  assert.equal(d.status, 'not_employed');
});

// --- overnight shift -------------------------------------------------------

test('overnight shift spanning midnight computes a full day', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT,
    punches: [
      { punched_at: `${DAY} 22:00:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 06:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.grossMinutes, 480);
  assert.equal(d.workedMinutes, 420);
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.earlyMinutes, 0);
  assert.equal(d.status, 'present');
});

test('overnight shift detects lateness across midnight correctly', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT,
    punches: [
      { punched_at: `${DAY} 22:40:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 06:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.lateMinutes, 40);
  assert.equal(d.status, 'late');
});

test('overnight shift detects an early exit after midnight', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT,
    punches: [
      { punched_at: `${DAY} 22:00:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 04:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.earlyMinutes, 120);
});

// --- corrupt data ----------------------------------------------------------

test('a check-out before its check-in is rejected, not counted negative', () => {
  const d = evalDay([
    { punched_at: `${DAY} 18:00:00`, work_date: DAY, kind: 'in' },
    { punched_at: `${DAY} 18:00:00`, work_date: DAY, kind: 'out' },
  ]);
  assert.equal(d.workedMinutes, 0);
  assert.equal(d.grossMinutes, 0);
});

test('a missing shift falls back to defaults rather than crashing', () => {
  const d = evaluateDay({ date: DAY, shift: null, punches: [p('09:00', 'in'), p('18:00', 'out')] });
  assert.equal(d.status, 'present');
  assert.equal(d.shiftName, 'Unassigned');
});

// --- monthly rollup --------------------------------------------------------

test('summarise rolls days into report figures', () => {
  const days = [
    evalDay([p('09:00', 'in'), p('18:00', 'out')]),                 // present
    evalDay([p('09:30', 'in'), p('18:00', 'out')]),                 // late 30
    evalDay([p('09:00', 'in'), p('12:00', 'out')]),                 // half day
    evalDay([]),                                                     // absent
    evalDay([], { override: { status: 'leave' } }),                  // leave
    evalDay([p('09:00', 'in'), p('20:00', 'out')]),                 // ot 120
  ];
  const t = summarise(days);
  assert.equal(t.days, 6);
  assert.equal(t.present, 3);          // on-time + late + overtime day
  assert.equal(t.late, 1);
  assert.equal(t.halfDay, 1);
  assert.equal(t.absent, 1);
  assert.equal(t.leave, 1);
  assert.equal(t.lateMinutes, 30);
  assert.equal(t.overtimeMinutes, 120);
  assert.equal(t.payableDays, 3.5);    // 3 full + 1 half
});

test('summarise excludes pre-joining days from the denominator', () => {
  const t = summarise([
    evalDay([], { joinedOn: '2026-11-01' }),
    evalDay([p('09:00', 'in'), p('18:00', 'out')]),
  ]);
  assert.equal(t.days, 1);
  assert.equal(t.present, 1);
});

// --- future dates ----------------------------------------------------------

test('a future working day is upcoming, never absent', () => {
  // 2026-12-01 is a Tuesday, so the weekly-off rule does not apply.
  const d = evaluateDay({
    date: '2026-12-01', shift: SHIFT, punches: [], todayDate: DAY,
  });
  assert.equal(d.status, 'upcoming');
  assert.equal(d.expectedMinutes, 0);
  assert.equal(d.dayCredit, 0);
});

test('summarise ignores upcoming days entirely', () => {
  const t = summarise([
    evaluateDay({ date: DAY, shift: SHIFT, punches: [p('09:00', 'in'), p('18:00', 'out')], todayDate: DAY }),
    evaluateDay({ date: '2026-10-16', shift: SHIFT, punches: [], todayDate: DAY }),
    evaluateDay({ date: '2026-10-19', shift: SHIFT, punches: [], todayDate: DAY }),
  ]);
  assert.equal(t.days, 1);
  assert.equal(t.absent, 0);            // the two future days are not absences
  assert.equal(t.present, 1);
  assert.equal(t.expectedMinutes, 480); // only the real day is expected
});

test('today itself is still evaluated normally', () => {
  const d = evaluateDay({ date: DAY, shift: SHIFT, punches: [], todayDate: DAY });
  assert.equal(d.status, 'absent');
});

test('a backdated punch on a future date still counts as work', () => {
  // Guards against the future check hiding real data, e.g. a clock skew or a
  // night shift whose punches land on tomorrow's calendar date.
  const d = evaluateDay({
    date: '2026-10-16',
    shift: SHIFT,
    todayDate: DAY,
    punches: [
      { punched_at: '2026-10-16 09:00:00', work_date: '2026-10-16', kind: 'in' },
      { punched_at: '2026-10-16 18:00:00', work_date: '2026-10-16', kind: 'out' },
    ],
  });
  assert.equal(d.status, 'present');
  assert.equal(d.workedMinutes, 480);
});

test('a weekly off still reads as a weekly off when it is in the future', () => {
  const d = evaluateDay({ date: SAT, shift: SHIFT, punches: [], todayDate: '2026-10-01' });
  assert.equal(d.status, 'weekly_off');
});

test('a future holiday still reads as a holiday', () => {
  const d = evaluateDay({
    date: '2026-12-25', shift: SHIFT, punches: [], todayDate: DAY,
    holiday: { work_date: '2026-12-25', name: 'Christmas' },
  });
  assert.equal(d.status, 'holiday');
  assert.equal(d.note, 'Christmas');
});

// --- work-date attribution for the 20:00-05:00 night shift ------------------

const NIGHT_8 = { ...SHIFT, name: 'Night 8PM', start_time: '20:00', end_time: '05:00' };
const { resolveWorkDate } = require('./attendance');

test('a 20:00-05:00 shift spans two calendar dates but one business date', () => {
  const w = shiftWindow(NIGHT_8);
  assert.equal(w.start, 1200);          // 20:00
  assert.equal(w.end, 1740);            // 05:00 next day
  assert.equal(w.overnight, true);
  assert.equal(expectedMinutes(NIGHT_8), 480);   // 9h span - 1h break
});

test('arriving early for a 20:00 shift stays on tonight, not last night', () => {
  // The bug this guards: 19:45 was being filed under the previous night,
  // marking tonight absent and orphaning the punch on a finished shift.
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-16 19:45:00'), '2026-10-16');
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-16 19:00:00'), '2026-10-16');
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-16 17:30:00'), '2026-10-16');
});

test('the after-midnight tail of a 20:00 shift belongs to the previous date', () => {
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-17 00:30:00'), '2026-10-16');
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-17 02:00:00'), '2026-10-16');
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-17 05:00:00'), '2026-10-16');
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-17 05:40:00'), '2026-10-16');
});

test('on-time punches land on the shift start date', () => {
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-16 20:00:00'), '2026-10-16');
  assert.equal(resolveWorkDate(NIGHT_8, '2026-10-16 23:59:00'), '2026-10-16');
});

test('a day shift is always just its calendar date', () => {
  for (const t of ['06:00', '09:00', '13:00', '18:00', '23:30']) {
    assert.equal(resolveWorkDate(SHIFT, `2026-10-16 ${t}:00`), '2026-10-16');
  }
});

test('an employee with no shift falls back to the calendar date', () => {
  assert.equal(resolveWorkDate(null, '2026-10-17 02:00:00'), '2026-10-17');
});

test('a full 20:00-05:00 night is a present day with no flags', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [
      { punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 05:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.grossMinutes, 540);
  assert.equal(d.workedMinutes, 480);
  assert.equal(d.status, 'present');
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.earlyMinutes, 0);
  assert.equal(d.overtimeMinutes, 0);
  assert.deepEqual(d.problems, []);
});

test('clocking in early on a night shift is not credited as overtime', () => {
  // 19:45 to 05:00 is 9h15m gross, 8h15m paid - 15m over, which is exactly
  // the overtime grace, so it does count. One minute less would not.
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [
      { punched_at: `${DAY} 19:45:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 05:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.workedMinutes, 495);
  assert.equal(d.overtimeMinutes, 15);
  assert.equal(d.lateMinutes, 0);
});

test('lateness on a night shift is measured across midnight correctly', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [
      { punched_at: `${DAY} 20:35:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 05:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.lateMinutes, 35);
  assert.equal(d.status, 'late');
});

test('leaving before 05:00 on a night shift is an early exit', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [
      { punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 03:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.earlyMinutes, 120);
  assert.equal(d.workedMinutes, 360);
});

test('staying past 05:00 on a night shift earns overtime', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [
      { punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 07:30:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.workedMinutes, 630);   // 11h30 gross - 1h break
  assert.equal(d.overtimeMinutes, 150);
  assert.equal(d.earlyMinutes, 0);
});

test('a night-shift meal break punched out is not double charged', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [
      { punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 00:00:00', work_date: DAY, kind: 'out' },
      { punched_at: '2026-10-16 01:00:00', work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 06:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.grossMinutes, 540);
  assert.equal(d.breakMinutes, 0);      // the 1h gap was the break
  assert.equal(d.workedMinutes, 540);
});

// --- a shift still running --------------------------------------------------

test('a running shift reads as in progress, not as a verdict', () => {
  // 22:00 on a 20:00-05:00 night: two hours in, which would otherwise show
  // as "Half day" on the live register.
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [{ punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' }],
    nowStamp: `${DAY} 22:00:00`,
    todayDate: DAY,
  });
  assert.equal(d.inProgress, true);
  assert.equal(d.statusLabel, 'In progress');
  assert.equal(d.stillIn, true);
  // The underlying figures are untouched, so payroll still sees the truth.
  assert.equal(d.status, 'half_day');
  assert.equal(d.grossMinutes, 120);
});

test('a finished shift is not in progress', () => {
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [
      { punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' },
      { punched_at: '2026-10-16 05:00:00', work_date: DAY, kind: 'out' },
    ],
  });
  assert.equal(d.inProgress, false);
  assert.equal(d.statusLabel, 'Present');
});

test('a forgotten check-out on a past night is not "in progress"', () => {
  // No nowStamp means the day is historical: the open session is a problem,
  // not someone at work.
  const d = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [{ punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' }],
    todayDate: '2026-10-20',
  });
  assert.equal(d.inProgress, true);   // stillIn is set...
  assert.equal(d.problems.length, 1); // ...but it is also flagged for repair
});

test('in-progress days do not distort monthly totals', () => {
  const running = evaluateDay({
    date: DAY,
    shift: NIGHT_8,
    punches: [{ punched_at: `${DAY} 20:00:00`, work_date: DAY, kind: 'in' }],
    nowStamp: `${DAY} 22:00:00`,
    todayDate: DAY,
  });
  const t = summarise([running]);
  assert.equal(t.days, 1);
  assert.equal(t.halfDay, 1);        // counted by its real status, not the label
});

// --- which calendar day a time sits on -------------------------------------

const { stampDateFor } = require('./attendance');

test('an overnight end time is stamped on the morning after', () => {
  // The bug this guards: stamping 05:10 on the night's own date put the
  // check-out BEFORE its check-in, and the night read as never closed.
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '05:10'), '2026-10-15');
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '05:00'), '2026-10-15');
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '00:30'), '2026-10-15');
});

test('a late finish past the shift end is still the morning after', () => {
  // 07:00 is beyond the 05:00 end, so a naive "before the end time" rule
  // misses it and files it on the wrong day.
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '07:00'), '2026-10-15');
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '11:00'), '2026-10-15');
});

test('an evening start stays on the night own date', () => {
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '19:45'), '2026-10-14');
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '20:05'), '2026-10-14');
  assert.equal(stampDateFor(NIGHT_8, '2026-10-14', '23:59'), '2026-10-14');
});

test('it uses the same cut-over as resolveWorkDate, so the two agree', () => {
  // Whatever stampDateFor decides, feeding that stamp back through
  // resolveWorkDate must return the business date we started from.
  for (const t of ['19:45', '20:00', '23:30', '00:30', '05:10', '07:00', '12:29']) {
    const date = stampDateFor(NIGHT_8, '2026-10-14', t);
    assert.equal(resolveWorkDate(NIGHT_8, `${date} ${t}:00`), '2026-10-14',
      `${t} stamped on ${date} should resolve back to the night of 2026-10-14`);
  }
});

test('a day shift always stamps on its own date', () => {
  for (const t of ['09:00', '13:00', '17:30', '23:00']) {
    assert.equal(stampDateFor(SHIFT, '2026-10-14', t), '2026-10-14');
  }
});

test('an employee with no shift stamps on the work date', () => {
  assert.equal(stampDateFor(null, '2026-10-14', '05:10'), '2026-10-14');
});

test('an admin-corrected overnight pair evaluates as a full night', () => {
  const d = evaluateDay({
    date: '2026-10-14',
    shift: { ...NIGHT_8, break_minutes: 0, break_after_minutes: 0 },
    punches: [
      { punched_at: `2026-10-14 ${'20:05'}:00`, work_date: '2026-10-14', kind: 'in' },
      { punched_at: `${stampDateFor(NIGHT_8, '2026-10-14', '05:10')} 05:10:00`,
        work_date: '2026-10-14', kind: 'out' },
    ],
  });
  assert.equal(d.status, 'present');
  assert.equal(d.workedMinutes, 545);
  assert.deepEqual(d.problems, []);
});

// --- staff not required to clock in ----------------------------------------

test('an exempt employee with no punches is not marked absent', () => {
  const d = evaluateDay({
    date: DAY, shift: SHIFT, punches: [], exempt: true, todayDate: '2026-10-20',
  });
  assert.equal(d.status, 'not_required');
  assert.equal(d.statusLabel, 'Not required');
  assert.equal(d.dayCredit, 0);
  assert.equal(d.expectedMinutes, 0);
});

test('an exempt employee is never late, however late they arrive', () => {
  const d = evaluateDay({
    date: DAY, shift: SHIFT, exempt: true,
    punches: [p('11:30', 'in'), p('18:00', 'out')],
  });
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.status, 'present');
});

test('an exempt employee keeps the hours they do record', () => {
  const d = evaluateDay({
    date: DAY, shift: SHIFT, exempt: true,
    punches: [p('09:00', 'in'), p('18:00', 'out')],
  });
  assert.equal(d.workedMinutes, 480);
  assert.equal(d.status, 'present');
});

test('a short day for an exempt employee is not a half day or an early exit', () => {
  const d = evaluateDay({
    date: DAY, shift: SHIFT, exempt: true,
    punches: [p('09:00', 'in'), p('11:00', 'out')],
  });
  assert.equal(d.status, 'present');
  assert.equal(d.earlyMinutes, 0);
  assert.equal(d.workedMinutes, 120);
});

test('exempt days are left out of the monthly figures entirely', () => {
  const t = summarise([
    evaluateDay({ date: DAY, shift: SHIFT, punches: [], exempt: true, todayDate: '2026-10-20' }),
    evaluateDay({ date: DAY, shift: SHIFT, punches: [p('09:00', 'in'), p('18:00', 'out')] }),
  ]);
  assert.equal(t.days, 1);          // only the tracked day counts
  assert.equal(t.absent, 0);
  assert.equal(t.present, 1);
});

test('HR can still pin a status on an exempt employee', () => {
  // Exemption must not block a deliberate decision, such as recording leave.
  const d = evaluateDay({
    date: DAY, shift: SHIFT, punches: [], exempt: true,
    override: { status: 'leave', note: 'annual' }, todayDate: '2026-10-20',
  });
  assert.equal(d.status, 'leave');
  assert.equal(d.note, 'annual');
});
