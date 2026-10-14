const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createServer, settingsFromEnv} = require('../src/server');
const {reviewedDocx} = require('./helpers.cjs');

const apiKey = 'k'.repeat(40);
const settings = settingsFromEnv({OFFICIER_JWT_SECRET: 's'.repeat(32), GATEWAY_API_KEY: apiKey, OFFICIER_PUBLIC_URL: 'https://docs.example.kz/'});
let server;
let fileServer;
let base;
let fileBase;

before(async () => {
  server = createServer(settings);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  fileServer = http.createServer((req, res) => res.end(reviewedDocx()));
  await new Promise(resolve => fileServer.listen(0, '127.0.0.1', resolve));
  fileBase = `http://127.0.0.1:${fileServer.address().port}`;
});

after(() => {
  server.close();
  fileServer.close();
});

const call = (path, {headers = {}, ...options} = {}) =>
  fetch(base + path, {method: 'POST', ...options, headers: {Authorization: `Bearer ${apiKey}`, ...headers}});

test('Settings fail closed without secrets', () => {
  assert.throws(() => settingsFromEnv({GATEWAY_API_KEY: apiKey}), /OFFICIER_JWT_SECRET/);
  assert.throws(() => settingsFromEnv({OFFICIER_JWT_SECRET: 's'.repeat(32), GATEWAY_API_KEY: 'short'}), /GATEWAY_API_KEY/);
  assert.equal(settings.publicUrl, 'https://docs.example.kz');
});

test('Health is public, everything else needs the service key', async () => {
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const denied = await call('/api/v1/editor-config', {headers: {Authorization: 'Bearer wrong'}, body: '{}'});
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, 'GW-401-AUTH');
});

test('Editor config endpoint returns a signed config or validation details', async () => {
  const body = {
    document: {id: 'd', versionNo: 1, revision: 'r1', title: 'Политика.docx', url: 'https://portal/file', callbackUrl: 'https://portal/cb'},
    user: {id: 'u', name: 'Автор'},
    access: {status: 'DRAFT', role: 'OWNER'}
  };
  const ok = await call('/api/v1/editor-config', {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal(ok.status, 200);
  const result = await ok.json();
  assert.equal(result.policy.mode, 'EDIT');
  assert.equal(result.config.token.split('.').length, 3);

  const invalid = await call('/api/v1/editor-config', {headers: {'Content-Type': 'application/json'}, body: '{"document":{}}'});
  assert.equal(invalid.status, 422);
  assert.ok((await invalid.json()).details.length > 0);
  assert.equal((await call('/api/v1/editor-config', {body: 'not json'})).status, 400);
});

test('Review report accepts DOCX bytes or a URL', async () => {
  const direct = await call('/api/v1/review/report', {headers: {'Content-Type': 'application/octet-stream'}, body: reviewedDocx()});
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).summary.openSuggestions, 5);

  const byUrl = await call('/api/v1/review/report', {headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: fileBase + '/doc.docx'})});
  assert.equal(byUrl.status, 200);
  assert.equal((await byUrl.json()).summary.comments, 2);

  const notDocx = await call('/api/v1/review/report', {body: 'plain text'});
  assert.equal(notDocx.status, 422);
  assert.equal((await notDocx.json()).error, 'GW-422-NOT-DOCX');
});

test('Unknown routes are 404', async () => {
  assert.equal((await call('/api/v1/unknown')).status, 404);
});
