'use strict';
// QMS gateway: the portal backend calls it server-to-server; browsers never do.
const crypto = require('crypto');
const http = require('http');
const {GatewayError} = require('./errors');
const {buildEditorConfig} = require('./editorConfig');
const {extractReview} = require('./review');
const {closeSessions} = require('./sessions');
const {finalize} = require('./finalize');

const JSON_LIMIT = 1024 * 1024;
const DOCX_LIMIT = 60 * 1024 * 1024; // QMS source files are limited to 50 MB
const FINALIZE_JSON_LIMIT = Math.ceil(DOCX_LIMIT * 4 / 3) + JSON_LIMIT; // the DOCX may come as base64
const FETCH_TIMEOUT_MS = 60000;
const PUBLISHED_FILE_TTL_MS = 10 * 60 * 1000;

const trimSlashes = value => value.replace(/\/+$/, '');

function settingsFromEnv(env = process.env) {
  const publicUrl = trimSlashes(env.OFFICIER_PUBLIC_URL || 'http://127.0.0.1:8080');
  const settings = {
    jwtSecret: env.OFFICIER_JWT_SECRET || '',
    apiKey: env.GATEWAY_API_KEY || '',
    publicUrl,
    // How the gateway reaches the document server, and how the document server reaches the gateway.
    officierInternalUrl: trimSlashes(env.OFFICIER_INTERNAL_URL || publicUrl),
    gatewayInternalUrl: env.GATEWAY_INTERNAL_URL ? trimSlashes(env.GATEWAY_INTERNAL_URL) : null,
    // Decision dates on the approval sheet are printed in this zone.
    timeZone: env.QMS_TIME_ZONE || 'Asia/Almaty',
    port: Number(env.GATEWAY_PORT || 8081),
    tokenTtlSeconds: Number(env.GATEWAY_TOKEN_TTL_SECONDS || 36000)
  };
  // Fail closed: without both secrets the gateway would sign configs for anyone or nobody.
  if (settings.jwtSecret.length < 32) throw new Error('OFFICIER_JWT_SECRET must be set (the document server JWT_SECRET)');
  if (settings.apiKey.length < 32) throw new Error('GATEWAY_API_KEY must be set to at least 32 characters');
  return settings;
}

function authorized(req, apiKey) {
  const header = req.headers.authorization || '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(apiKey);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new GatewayError(413, 'GW-413-TOO-LARGE', `Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = JSON_LIMIT) {
  try {
    return JSON.parse((await readBody(req, limit)).toString('utf8'));
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError(400, 'GW-400-JSON', 'Request body must be JSON');
  }
}

async function download(url) {
  let response;
  try {
    response = await fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow'});
  } catch (err) {
    throw new GatewayError(502, 'GW-502-FETCH', `Cannot download the document: ${err.message}`);
  }
  if (!response.ok) throw new GatewayError(502, 'GW-502-FETCH', `Document download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > DOCX_LIMIT) throw new GatewayError(413, 'GW-413-TOO-LARGE', 'Document exceeds the size limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > DOCX_LIMIT) throw new GatewayError(413, 'GW-413-TOO-LARGE', 'Document exceeds the size limit');
  return buffer;
}

// DOCX bytes in the body, or JSON {"url": "..."} pointing to a file the gateway can download.
async function reviewSource(req) {
  if ((req.headers['content-type'] || '').startsWith('application/json')) {
    const {url} = await readJson(req);
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
    } catch {
      throw new GatewayError(422, 'GW-422-INVALID', 'Invalid review request', ['url must be an http(s) URL']);
    }
    return download(url);
  }
  return readBody(req, DOCX_LIMIT);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload)});
  res.end(payload);
}

// Files the document server downloads from the gateway (the print copy for PDF conversion).
// The unguessable name is the only credential, so a file lives only while its conversion runs.
function fileStore(settings) {
  const files = new Map();
  return {
    publish(buffer) {
      const name = crypto.randomBytes(32).toString('base64url');
      const timer = setTimeout(() => files.delete(name), PUBLISHED_FILE_TTL_MS);
      timer.unref();
      files.set(name, buffer);
      return {
        url: `${settings.gatewayInternalUrl}/files/${name}`,
        release() {
          clearTimeout(timer);
          files.delete(name);
        }
      };
    },
    get: name => files.get(name)
  };
}

function createServer(settings) {
  const store = fileStore(settings);
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const path = new URL(req.url, 'http://gateway').pathname;
    // Published file names are credentials: keep them out of the log.
    const logPath = path.startsWith('/files/') ? '/files/…' : path;
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, {ok: true});
      const published = req.method === 'GET' && /^\/files\/([\w-]{43})$/.exec(path);
      if (published) {
        const file = store.get(published[1]);
        if (!file) throw new GatewayError(404, 'GW-404', 'Not found');
        res.writeHead(200, {'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Length': file.length, 'Cache-Control': 'no-store'});
        return res.end(file);
      }
      if (!authorized(req, settings.apiKey)) throw new GatewayError(401, 'GW-401-AUTH', 'Missing or invalid service API key');
      if (req.method === 'POST' && path === '/api/v1/editor-config') {
        return send(res, 200, buildEditorConfig(await readJson(req), settings));
      }
      if (req.method === 'POST' && path === '/api/v1/review/report') {
        return send(res, 200, extractReview(await reviewSource(req)));
      }
      if (req.method === 'POST' && path === '/api/v1/editor/close') {
        return send(res, 200, await closeSessions(await readJson(req), settings));
      }
      if (req.method === 'POST' && path === '/api/v1/finalize') {
        return send(res, 200, await finalize(await readJson(req, FINALIZE_JSON_LIMIT), settings, {download, publish: store.publish}));
      }
      throw new GatewayError(404, 'GW-404', 'Not found');
    } catch (err) {
      if (err instanceof GatewayError) {
        send(res, err.status, {error: err.code, message: err.message, details: err.details});
      } else {
        console.error(JSON.stringify({level: 'error', path: logPath, message: err.stack}));
        send(res, 500, {error: 'GW-500', message: 'Internal gateway error'});
      }
    } finally {
      console.log(JSON.stringify({method: req.method, path: logPath, status: res.statusCode, ms: Date.now() - started}));
    }
  });
}

if (require.main === module) {
  const settings = settingsFromEnv();
  createServer(settings).listen(settings.port, () => console.log(JSON.stringify({level: 'info', message: `QMS gateway listening on ${settings.port}`})));
}

module.exports = {createServer, settingsFromEnv};
