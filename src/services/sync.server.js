const http = require('http');
const knowledge = require('./knowledge.service');

/**
 * A small HTTP service on 127.0.0.1 that the JobFill extension posts to as you
 * apply, so the interview knowledge grows with every application:
 *
 *   GET  /v1/health        -> { ok, kbDir }
 *   POST /v1/applications  { items: [{ title, company, link, status, appliedOn, ... }] }
 *   POST /v1/answers       { items: [{ question, answer, saved }] }
 *   POST /v1/profile       { profile }   (JobFill's profile; contact details are dropped)
 *
 * Only the loopback interface is bound, and a request that carries an Origin
 * must come from a browser extension, so a web page cannot write to it.
 */

const DEFAULT_PORT = 47321;
const MAX_BODY = 1024 * 1024;

function allowedOrigin(origin) {
  return !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^moz-extension:\/\//.test(origin);
}

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(body == null ? '' : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(Object.assign(new Error('Body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function handler({ dir, logger } = {}) {
  return async (req, res) => {
    const origin = req.headers.origin || '';
    if (!allowedOrigin(origin)) return send(res, 403, { ok: false, error: 'Origin not allowed' });
    if (req.method === 'OPTIONS') return send(res, 204, null, origin);
    const route = `${req.method} ${(req.url || '').split('?')[0]}`;
    try {
      if (route === 'GET /v1/health') return send(res, 200, { ok: true, kbDir: dir || knowledge.kbDir() }, origin);
      if (route === 'POST /v1/profile') {
        const body = await readJson(req);
        knowledge.setProfile(body.profile, dir);
        if (logger) logger.info('Knowledge sync', { route });
        return send(res, 200, { ok: true }, origin);
      }
      if (route === 'POST /v1/applications' || route === 'POST /v1/answers') {
        const body = await readJson(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const result = route.endsWith('applications') ? knowledge.addApplications(items, dir) : knowledge.addAnswers(items, dir);
        if (logger) logger.info('Knowledge sync', { route, ...result });
        return send(res, 200, { ok: true, ...result }, origin);
      }
      return send(res, 404, { ok: false, error: 'Not found' }, origin);
    } catch (error) {
      if (logger) logger.warn('Knowledge sync failed', { route, error: error.message });
      return send(res, error.status || 500, { ok: false, error: error.message }, origin);
    }
  };
}

/** Start listening; resolves to the server, or null when the port is taken or sync is off. */
function start({ port = Number(process.env.JOBAI_SYNC_PORT) || DEFAULT_PORT, dir, logger } = {}) {
  if (/^(false|0|off|no)$/i.test(String(process.env.JOBAI_SYNC || '').trim())) return Promise.resolve(null);
  return new Promise((resolve) => {
    const server = http.createServer(handler({ dir, logger }));
    server.once('error', (error) => {
      if (logger) logger.warn('Knowledge sync service not started', { port, error: error.message });
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => {
      if (logger) logger.info('Knowledge sync service listening', { port, kbDir: dir || knowledge.kbDir() });
      resolve(server);
    });
  });
}

module.exports = { start, handler, allowedOrigin, DEFAULT_PORT };
