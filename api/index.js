'use strict';
/**
 * Vercel entry point.
 *
 * Vercel runs this file as a serverless function rather than starting a
 * server, so it exports the Express app instead of calling listen(). The app
 * opens its own database connection on the first request and caches it for the
 * life of the instance - which is why the store had to move to Postgres: a
 * file-backed database cannot survive here.
 */
module.exports = require('../src/server.js');
