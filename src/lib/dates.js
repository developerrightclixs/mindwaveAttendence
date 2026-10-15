'use strict';

// All attendance reasoning happens in the server's local wall-clock time.
// The org is single-timezone, and shift rules ("09:00") are inherently local,
// so converting to UTC would only add a conversion to undo later.

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for a Date (local). */
function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD HH:MM:SS" for a Date (local) — the punches.punched_at format. */
function isoStamp(d = new Date()) {
  return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Parse "YYYY-MM-DD HH:MM:SS" (or "...THH:MM") as local time. */
function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error(`Bad timestamp: ${s}`);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

/** Parse "YYYY-MM-DD" as local midnight. */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Bad date: ${s}`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

/** "HH:MM" -> minutes since midnight. */
function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Bad time: ${hhmm}`);
  return +m[1] * 60 + +m[2];
}

/** minutes since midnight -> "HH:MM" (wraps past 24h for overnight shifts). */
function minutesToTime(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Human duration: 495 -> "8h 15m". */
function formatDuration(mins) {
  if (mins == null) return '—';
  const sign = mins < 0 ? '-' : '';
  const a = Math.abs(Math.round(mins));
  const h = Math.floor(a / 60);
  return h ? `${sign}${h}h ${a % 60}m` : `${sign}${a}m`;
}

/** Clock time of day from a stamp: "2026-10-15 09:07:00" -> "09:07". */
function clockOf(stamp) {
  const d = parseStamp(stamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO weekday: 1=Mon .. 7=Sun. */
function isoWeekday(dateStr) {
  const wd = parseDate(dateStr).getDay(); // 0=Sun
  return wd === 0 ? 7 : wd;
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** Inclusive list of dates from `from` to `to`. */
function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** First and last day of the month containing `dateStr`. */
function monthBounds(dateStr) {
  const d = parseDate(dateStr);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: isoDate(first), to: isoDate(last) };
}

function prettyDate(dateStr) {
  return parseDate(dateStr).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

module.exports = {
  isoDate, isoStamp, parseStamp, parseDate,
  timeToMinutes, minutesToTime, formatDuration, clockOf,
  isoWeekday, addDays, dateRange, monthBounds, prettyDate,
};
