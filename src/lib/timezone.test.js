'use strict';
/**
 * The process clock.
 *
 * This is one line of configuration guarding every number the app produces:
 * get it wrong and check-ins are recorded at the wrong hour, night shifts land
 * on the wrong business date, and nobody is ever late. The cases below are the
 * ones that actually bit - a cloud host with no zone of its own, and Lambda's
 * injected TZ.
 */
const test = require('node:test');
const assert = require('node:assert');
const { applyTimezone, DEFAULT_TZ } = require('./timezone');

const ORIGINAL = { TZ: process.env.TZ, APP_TZ: process.env.APP_TZ };

function withEnv(env, fn) {
  for (const k of ['TZ', 'APP_TZ']) {
    if (k in env) process.env[k] = env[k];
    else delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    applyTimezone();
  }
}

/** Wall-clock hour of a known instant, under whatever zone is in force. */
const hourOfNoonUtc = () => new Date(Date.UTC(2026, 9, 16, 12, 0, 0)).getHours();

test('with nothing configured the org timezone is used, not the host default', () => {
  withEnv({}, () => {
    assert.equal(applyTimezone(), DEFAULT_TZ);
    assert.equal(process.env.TZ, DEFAULT_TZ);
    assert.equal(hourOfNoonUtc(), 17);               // noon UTC is 17:00 in PKT
  });
});

test("a host's own TZ does not win - Lambda injects TZ=:UTC", () => {
  withEnv({ TZ: ':UTC' }, () => {
    assert.equal(applyTimezone(), DEFAULT_TZ);
    assert.equal(hourOfNoonUtc(), 17);
  });
});

test('a plain inherited TZ=UTC is overridden too', () => {
  withEnv({ TZ: 'UTC' }, () => {
    assert.equal(applyTimezone(), DEFAULT_TZ);
    assert.equal(hourOfNoonUtc(), 17);
  });
});

test('APP_TZ is the way to run this somewhere else', () => {
  withEnv({ TZ: ':UTC', APP_TZ: 'Europe/London' }, () => {
    assert.equal(applyTimezone(), 'Europe/London');
    assert.equal(hourOfNoonUtc(), 13);               // BST in October
  });
});

test('a misspelled APP_TZ fails loudly instead of silently becoming UTC', () => {
  withEnv({ APP_TZ: 'Asia/Karachee' }, () => {
    assert.throws(() => applyTimezone(), /not a timezone/i);
  });
});

test('whitespace and an empty APP_TZ fall back rather than break', () => {
  withEnv({ APP_TZ: '   ' }, () => {
    assert.equal(applyTimezone(), DEFAULT_TZ);
  });
  withEnv({ APP_TZ: ' Europe/London ' }, () => {
    assert.equal(applyTimezone(), 'Europe/London');
  });
});
