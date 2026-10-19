'use strict';
/**
 * Per-request memo for read-only lookups.
 *
 * Rendering one page asks the same small questions several times over: which
 * shift most people are on, the shift list, the active employees, the month's
 * holidays. Each answer is identical within a request - they are all reading
 * the same instant - but each ask is a separate round trip, and on a cloud
 * deployment a round trip is tens of milliseconds across a network rather
 * than a lookup in the page cache next door. A staff page was spending about
 * half its queries re-asking.
 *
 * So each request runs inside its own store and those lookups answer from it
 * the second time. The scope is one request: nothing is shared between two
 * requests, between two users, or between two serverless invocations, which
 * is what keeps this from being a cache that can serve one person another
 * person's data.
 *
 * Any write empties the store (see `run` and `tx` in db.js), so a route that
 * changes something and then reads it back in the same request still sees
 * what it just wrote.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/** Run `fn` with a fresh, empty memo. Everything it awaits shares that memo. */
function withRequestCache(fn) {
  return storage.run(new Map(), fn);
}

/**
 * Answer from the memo, or call `fn` and remember it.
 *
 * The promise is stored, not the resolved value, so two callers that ask
 * concurrently share one query rather than racing into two.
 *
 * Outside a request - a script, a test, the seeder - there is no store and
 * this is a plain pass-through.
 */
function memo(key, fn) {
  const store = storage.getStore();
  if (!store) return fn();
  if (!store.has(key)) store.set(key, fn());
  return store.get(key);
}

/** Drop everything remembered for the current request. Called on every write. */
function invalidate() {
  const store = storage.getStore();
  if (store) store.clear();
}

module.exports = { withRequestCache, memo, invalidate };
