'use strict';
const {
  parseStamp, timeToMinutes, isoWeekday, clockOf, isoDate, addDays,
} = require('./dates');

const DEFAULT_SHIFT = {
  id: null,
  name: 'Unassigned',
  start_time: '09:00',
  end_time: '18:00',
  grace_minutes: 10,
  break_minutes: 60,
  break_after_minutes: 360,
  half_day_minutes: 240,
  min_present_minutes: 60,
  overtime_after_minutes: 480,
  overtime_grace_minutes: 15,
  weekly_off: '6,7',
};

const STATUS_LABELS = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half day',
  absent: 'Absent',
  leave: 'Leave',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
  not_employed: 'N/A',
  upcoming: 'Upcoming',
  not_required: 'Not required',
};

/** Weekly-off days of a shift as a Set of ISO weekdays (1=Mon..7=Sun). */
function offDays(shift) {
  return new Set(
    String(shift.weekly_off || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => n >= 1 && n <= 7),
  );
}

/**
 * A shift whose end_time is at or before its start_time runs past midnight.
 * Its end is then expressed as minutes past the start day's midnight, so
 * 22:00 -> 06:00 yields end = 1800 (06:00 the next day).
 */
function shiftWindow(shift) {
  const start = timeToMinutes(shift.start_time);
  let end = timeToMinutes(shift.end_time);
  if (end <= start) end += 1440;
  return { start, end, overnight: end > 1440 };
}

/** Scheduled payable minutes for one full day of this shift. */
function expectedMinutes(shift) {
  const { start, end } = shiftWindow(shift);
  return Math.max(0, end - start - (shift.break_minutes || 0));
}

/**
 * Minutes from the business date's midnight to a stamp. For an overnight
 * shift the stamp may fall on the following calendar day, which yields a
 * value above 1440 - exactly what shiftWindow() compares against.
 */
function minutesIntoDay(stamp, businessDate) {
  const d = parseStamp(stamp);
  const mins = d.getHours() * 60 + d.getMinutes();
  const stampDate = stamp.slice(0, 10);
  if (stampDate === businessDate) return mins;
  const dayDiff = Math.round(
    (parseStamp(stampDate + ' 00:00:00') - parseStamp(businessDate + ' 00:00:00')) / 86400000,
  );
  return mins + dayDiff * 1440;
}

/**
 * The business date a punch belongs to.
 *
 * A day shift is simply its calendar date. An overnight shift is not: a 02:00
 * check-out belongs to the night that began the previous evening.
 *
 * The split point is the middle of the OFF-shift gap, not the shift start. For
 * a 20:00-05:00 shift the gap runs 05:00 to 20:00, so the cut-over is 12:30:
 * anything from 12:30 onward opens tonight's shift, anything earlier closes
 * last night's. Using the start time instead would push an employee arriving
 * at 19:45 onto the previous night - filing their check-in against a shift
 * that already ended, and leaving tonight looking like an absence.
 */
function resolveWorkDate(shift, stamp) {
  const date = stamp.slice(0, 10);
  if (!shift || !shift.start_time || !shift.end_time) return date;

  const start = timeToMinutes(shift.start_time);
  const end = timeToMinutes(shift.end_time);
  if (end > start) return date;                 // ordinary day shift

  const cutover = Math.floor((end + start) / 2);
  const d = parseStamp(stamp);
  const clock = d.getHours() * 60 + d.getMinutes();
  return clock < cutover ? addDays(date, -1) : date;
}

/**
 * The calendar date a wall-clock time falls on, for a given business date.
 *
 * The inverse of resolveWorkDate, and it uses the same cut-over so the two can
 * never disagree: on a 20:00-05:00 night the split is 12:30, so 05:10 and even
 * a late 07:00 finish belong to the morning after, while 19:45 and 20:05 sit on
 * the night's own date. Getting this wrong files a check-out BEFORE its
 * check-in and the night reads as never closed.
 */
function stampDateFor(shift, workDate, timeHHMM) {
  if (!shift || !shift.start_time || !shift.end_time) return workDate;
  const start = timeToMinutes(shift.start_time);
  const end = timeToMinutes(shift.end_time);
  if (end > start) return workDate;                 // ordinary day shift
  const cutover = Math.floor((end + start) / 2);
  return timeToMinutes(timeHHMM) < cutover ? addDays(workDate, 1) : workDate;
}

/**
 * Pair a day's punches into in/out sessions.
 *
 * Punches are a raw stream, and real people produce messy streams: a double
 * check-in, a forgotten check-out, an out with no matching in. Rather than
 * reject those, pair what can be paired and report the rest so HR sees
 * exactly what needs fixing.
 */
function buildSessions(punches, nowStamp) {
  const sorted = [...punches].sort((a, b) => (
    a.punched_at < b.punched_at ? -1 : a.punched_at > b.punched_at ? 1 : 0
  ));

  const sessions = [];
  const problems = [];
  let open = null;

  for (const p of sorted) {
    if (p.kind === 'in') {
      // Two check-ins in a row: the earlier one was never closed.
      if (open) problems.push('Check-in at ' + clockOf(open.punched_at) + ' has no check-out');
      open = p;
    } else {
      if (!open) {
        problems.push('Check-out at ' + clockOf(p.punched_at) + ' has no check-in');
        continue;
      }
      const mins = Math.round(
        (parseStamp(p.punched_at) - parseStamp(open.punched_at)) / 60000,
      );
      // Guard against a clock change or a bad admin edit producing a negative.
      if (mins < 0) {
        problems.push('Check-out at ' + clockOf(p.punched_at) + ' precedes its check-in');
      } else {
        sessions.push({ in: open, out: p, minutes: mins, open: false });
      }
      open = null;
    }
  }

  // Still clocked in. If the day is current, count time so far; otherwise it
  // is a forgotten check-out and contributes nothing but a warning.
  if (open) {
    const live = nowStamp && nowStamp >= open.punched_at;
    const mins = live
      ? Math.max(0, Math.round((parseStamp(nowStamp) - parseStamp(open.punched_at)) / 60000))
      : 0;
    sessions.push({ in: open, out: null, minutes: mins, open: true });
    if (!live) problems.push('Check-in at ' + clockOf(open.punched_at) + ' was never closed');
  }

  return { sessions, problems };
}

/**
 * Evaluate one employee-day against their shift.
 *
 * @param {object}  o
 * @param {string}  o.date        "YYYY-MM-DD" business date
 * @param {object}  o.shift       shift row (falls back to DEFAULT_SHIFT)
 * @param {Array}   o.punches     punch rows for this employee and work_date
 * @param {object} [o.override]   day_overrides row, if any
 * @param {object} [o.holiday]    holidays row, if any
 * @param {string} [o.nowStamp]   "YYYY-MM-DD HH:MM:SS" for open-session maths
 * @param {string} [o.joinedOn]   employee joined_on; earlier dates are N/A
 * @param {string} [o.todayDate]  "today" for future detection; defaults to now
 * @param {boolean} [o.exempt]    senior staff not required to clock in or out
 */
function evaluateDay({
  date, shift, punches = [], override = null, holiday = null,
  nowStamp = null, joinedOn = null, todayDate = null, exempt = false,
}) {
  const sh = { ...DEFAULT_SHIFT, ...(shift || {}) };
  const { start, end } = shiftWindow(sh);

  const { sessions, problems } = buildSessions(punches, nowStamp);
  const gross = sessions.reduce((s, x) => s + x.minutes, 0);

  // Unpaid break: time already spent punched-out between sessions counts
  // toward the break, so only the shortfall is deducted. Without this an
  // employee who clocks out for lunch would be charged the break twice.
  let gaps = 0;
  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1];
    if (!prev.out) continue;
    gaps += Math.round(
      (parseStamp(sessions[i].in.punched_at) - parseStamp(prev.out.punched_at)) / 60000,
    );
  }
  const breakOwed = Math.max(0, (sh.break_minutes || 0) - gaps);
  const hasAnyWork = sessions.length > 0;
  // The break is an entitlement that only arises on a long enough day. A
  // 3-hour half day must not be charged a lunch break nobody took.
  const breakDue = gross > (sh.break_after_minutes != null ? sh.break_after_minutes : 360);
  const breakCharged = hasAnyWork && breakDue ? breakOwed : 0;
  const worked = hasAnyWork ? Math.max(0, gross - breakCharged) : 0;

  const firstIn = sessions.length ? sessions[0].in.punched_at : null;
  const closed = [...sessions].reverse().find((s) => s.out);
  const lastOut = closed ? closed.out.punched_at : null;
  const stillIn = sessions.some((s) => s.open);

  // --- Lateness ------------------------------------------------------------
  // Grace decides *whether* a day is late; lateness is then measured from the
  // scheduled start, not from the end of grace. Arriving 09:15 on a 09:00
  // shift with 10m grace is 15 minutes late, not 5.
  let lateMinutes = 0;
  if (firstIn) {
    const inMins = minutesIntoDay(firstIn, date);
    if (inMins > start + (sh.grace_minutes || 0)) lateMinutes = inMins - start;
  }

  // --- Early exit ----------------------------------------------------------
  let earlyMinutes = 0;
  if (lastOut && !stillIn) {
    const outMins = minutesIntoDay(lastOut, date);
    if (outMins < end) earlyMinutes = end - outMins;
  }

  // --- Overtime ------------------------------------------------------------
  let overtimeMinutes = 0;
  const otThreshold = sh.overtime_after_minutes != null ? sh.overtime_after_minutes : 480;
  if (worked > otThreshold) {
    const ot = worked - otThreshold;
    if (ot >= (sh.overtime_grace_minutes || 0)) overtimeMinutes = ot;
  }

  // --- Status --------------------------------------------------------------
  const isOff = offDays(sh).has(isoWeekday(date));
  const notYetJoined = joinedOn && date < joinedOn;
  // A date that has not happened yet is not absence. Without this, a report
  // run mid-month counts every remaining day against everyone.
  const inFuture = date > (todayDate || isoDate());

  let status;
  let note = null;

  if (notYetJoined) {
    status = 'not_employed';
  } else if (override) {
    status = override.status;              // HR's word is final
    note = override.note || null;
  } else if (holiday) {
    status = 'holiday';
    note = holiday.name;
  } else if (isOff && !hasAnyWork) {
    // Weekly offs and holidays are known in advance, so they are reported as
    // themselves even for dates still to come - only the absence verdict
    // below has to wait for the day to actually happen.
    status = 'weekly_off';
  } else if (exempt && !hasAnyWork) {
    // Not required to clock in. Checked after the calendar facts above: a
    // weekend is still a weekend for someone who is exempt. Silence rather
    // than an accusation - an absence mark would be wrong about them, and
    // would drag the whole team's figures down with it.
    status = 'not_required';
  } else if (inFuture && !hasAnyWork) {
    status = 'upcoming';
  } else if (!hasAnyWork) {
    status = 'absent';
  } else if (worked < (sh.min_present_minutes || 0)) {
    status = 'absent';                     // punched, but nowhere near a work day
  } else if (worked < (sh.half_day_minutes || 0)) {
    status = 'half_day';
  } else if (lateMinutes > 0) {
    status = 'late';
  } else {
    status = 'present';
  }

  // Work on a day off or a holiday is real work and should be paid, but it is
  // not measured against a schedule that does not apply that day.
  const unscheduled = (isOff || status === 'holiday') && hasAnyWork;
  if (unscheduled) {
    lateMinutes = 0;
    earlyMinutes = 0;
    if (!override) overtimeMinutes = worked;
  }

  // An exempt employee keeps whatever hours they recorded, but is never judged
  // against the clock - no lateness, no early exit, and a short day is not a
  // half day. Their time is tracked, not policed.
  if (exempt) {
    lateMinutes = 0;
    earlyMinutes = 0;
    if (['late', 'half_day', 'absent'].includes(status)) {
      status = hasAnyWork ? 'present' : 'not_required';
    }
  }

  const countsPresent = ['present', 'late', 'half_day'].includes(status);

  // A shift still running has not earned its verdict yet: at 22:00 on a
  // 20:00-05:00 night everyone has only worked two hours, which would read as
  // "Half day" on the live register. Flag it for display without touching the
  // computed status, so reports and payroll still use the real figure.
  const inProgress = stillIn && !inFuture;

  return {
    date,
    status,
    statusLabel: inProgress ? 'In progress' : (STATUS_LABELS[status] || status),
    inProgress,
    note,
    firstIn,
    lastOut,
    firstInClock: firstIn ? clockOf(firstIn) : null,
    lastOutClock: lastOut ? clockOf(lastOut) : null,
    workedMinutes: worked,
    grossMinutes: gross,
    breakMinutes: breakCharged,
    expectedMinutes: isOff || status === 'holiday' || status === 'upcoming'
      || status === 'not_employed' || status === 'not_required' || exempt
      ? 0 : expectedMinutes(sh),
    lateMinutes,
    earlyMinutes,
    overtimeMinutes,
    stillIn,
    sessions,
    problems,
    isOff,
    countsPresent,
    dayCredit: status === 'half_day' ? 0.5 : countsPresent ? 1 : 0,
    shiftName: sh.name,
  };
}

/** Roll a list of evaluated days into the figures a report or payslip needs. */
function summarise(days) {
  const t = {
    days: 0, present: 0, late: 0, halfDay: 0, absent: 0, leave: 0,
    holiday: 0, weeklyOff: 0, workedMinutes: 0, expectedMinutes: 0,
    lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0,
    payableDays: 0, problemDays: 0,
  };
  for (const d of days) {
    // Exempt days are not attendance facts, so they do not belong in a count
    // of who turned up.
    if (['not_employed', 'upcoming', 'not_required'].includes(d.status)) continue;
    t.days++;
    if (d.status === 'present') t.present++;
    else if (d.status === 'late') { t.late++; t.present++; }
    else if (d.status === 'half_day') t.halfDay++;
    else if (d.status === 'absent') t.absent++;
    else if (d.status === 'leave') t.leave++;
    else if (d.status === 'holiday') t.holiday++;
    else if (d.status === 'weekly_off') t.weeklyOff++;

    t.workedMinutes += d.workedMinutes;
    t.expectedMinutes += d.expectedMinutes;
    t.lateMinutes += d.lateMinutes;
    t.earlyMinutes += d.earlyMinutes;
    t.overtimeMinutes += d.overtimeMinutes;
    t.payableDays += d.dayCredit;
    if (d.problems.length) t.problemDays++;
  }
  return t;
}

module.exports = {
  DEFAULT_SHIFT, STATUS_LABELS, evaluateDay, summarise,
  expectedMinutes, shiftWindow, offDays, buildSessions, minutesIntoDay,
  resolveWorkDate, stampDateFor,
};
