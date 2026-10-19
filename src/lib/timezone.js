'use strict';
/**
 * Pin the process timezone.
 *
 * Every attendance rule in this app is wall-clock reasoning: a shift starts at
 * "20:00", a punch is stored as "2026-10-16 20:49:00", and lateness is the gap
 * between the two. All of that runs through `new Date()` and `getHours()`,
 * which means it silently inherits whatever timezone the host happens to be
 * in. On the office box that is Pakistan Standard Time and everything agrees.
 * On a cloud host it is UTC - and the whole system quietly slides five hours:
 * a 20:49 check-in is written down as 15:49, a night shift is attributed to
 * the wrong business date, and nobody is ever marked late.
 *
 * So the zone is the app's own configuration, not the host's. `APP_TZ` sets
 * it; otherwise it is the default below.
 *
 * An inherited `TZ` is deliberately NOT trusted. Serverless platforms set it
 * themselves - AWS Lambda, which is what Vercel's Node runtime sits on, exports
 * `TZ=:UTC` into every invocation - so "use TZ if the host set one" would read
 * as a deployment choosing UTC when nobody chose anything. That is precisely
 * the five-hour error this module exists to prevent, so TZ is overwritten
 * rather than read.
 */

// The org this was built for. A deployment elsewhere sets APP_TZ instead of
// editing this.
const DEFAULT_TZ = 'Asia/Karachi';

/** Does the host's ICU data actually know this zone? */
function isKnownZone(tz) {
  try {
    // Throws RangeError on an unknown identifier.
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the timezone to this process. Call once, first thing in an entry
 * point - before any module-level `new Date()` anywhere in the tree.
 *
 * Returns the zone now in force.
 */
function applyTimezone() {
  const configured = String(process.env.APP_TZ || '').trim();
  const wanted = configured || DEFAULT_TZ;

  // Node does not fail on an unusable zone, it falls back to UTC. Rejecting it
  // here turns a typo into an error at boot instead of a month of punches
  // quietly stamped five hours out.
  if (!isKnownZone(wanted)) {
    throw new Error(
      `APP_TZ is set to ${JSON.stringify(configured)}, which is not a timezone `
      + `this host knows. Use an IANA zone name such as "Asia/Karachi".`);
  }

  process.env.TZ = wanted;

  // Node re-reads process.env.TZ when it changes, but only for Dates built
  // afterwards. Confirm it actually took, so a host that ignores the variable
  // fails here rather than in a month of mis-stamped punches.
  const actual = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (actual !== wanted) {
    throw new Error(
      `Could not set the process timezone to ${wanted} (still ${actual}). `
      + `Set TZ=${wanted} in the environment before the process starts.`);
  }

  return wanted;
}

/** Current UTC offset in minutes - 300 for Pakistan. For display. */
function offsetMinutes(at = new Date()) {
  return -at.getTimezoneOffset();
}

module.exports = { applyTimezone, offsetMinutes, DEFAULT_TZ };
