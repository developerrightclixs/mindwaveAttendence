'use strict';
/**
 * The per-request memo.
 *
 * A cache in front of attendance data is the kind of thing that, when it goes
 * wrong, shows one employee another employee's day or hides a correction
 * somebody just made. These tests pin the two properties that make it safe:
 * it never outlives its request, and any write empties it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { newDb } = require('pg-mem');
const { withRequestCache, memo, invalidate } = require('./request-cache');

test('answers from the memo within one request', async () => {
  let calls = 0;
  const load = () => { calls += 1; return Promise.resolve('value'); };

  await withRequestCache(async () => {
    assert.equal(await memo('k', load), 'value');
    assert.equal(await memo('k', load), 'value');
    assert.equal(await memo('k', load), 'value');
  });
  assert.equal(calls, 1);
});

test('two requests never share an answer', async () => {
  let n = 0;
  const load = () => Promise.resolve(++n);

  const first = await withRequestCache(() => memo('k', load));
  const second = await withRequestCache(() => memo('k', load));
  assert.equal(first, 1);
  assert.equal(second, 2, 'the second request must do its own lookup');
});

test('concurrent askers share one lookup rather than racing', async () => {
  let calls = 0;
  const load = () => { calls += 1; return new Promise((r) => setTimeout(() => r('v'), 10)); };

  await withRequestCache(async () => {
    const [a, b, c] = await Promise.all([memo('k', load), memo('k', load), memo('k', load)]);
    assert.deepEqual([a, b, c], ['v', 'v', 'v']);
  });
  assert.equal(calls, 1);
});

test('different keys are kept apart', async () => {
  await withRequestCache(async () => {
    assert.equal(await memo('a', () => Promise.resolve(1)), 1);
    assert.equal(await memo('b', () => Promise.resolve(2)), 2);
    assert.equal(await memo('a', () => Promise.resolve(99)), 1);
  });
});

test('invalidate drops what was remembered', async () => {
  let n = 0;
  const load = () => Promise.resolve(++n);
  await withRequestCache(async () => {
    assert.equal(await memo('k', load), 1);
    invalidate();
    assert.equal(await memo('k', load), 2);
  });
});

test('outside a request it is a pass-through, not a global cache', async () => {
  let calls = 0;
  const load = () => { calls += 1; return Promise.resolve('v'); };
  assert.equal(await memo('k', load), 'v');
  assert.equal(await memo('k', load), 'v');
  assert.equal(calls, 2, 'a script or test must never get a stale shared value');
});

// --- the property that matters most: a write is never served from the memo --

test('a write in the same request empties the memo', async () => {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  require.cache[require.resolve('pg')] = {
    id: 'pg', filename: 'pg', loaded: true, exports: mem.adapters.createPg(),
  };
  process.env.DATABASE_URL = 'postgres://memory/test?sslmode=disable';
  const { init, run, getSetting } = require('../db');
  await init();

  await withRequestCache(async () => {
    await run(`INSERT INTO settings (key, value) VALUES ('tz_demo', 'before')
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    assert.equal(await getSetting('tz_demo'), 'before');

    // Same request, same key, changed underneath: the read must see the write.
    await run(`UPDATE settings SET value = 'after' WHERE key = 'tz_demo'`);
    assert.equal(await getSetting('tz_demo'), 'after');
  });
});
