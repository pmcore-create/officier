const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {createServer, settingsFromEnv} = require('../src/server');
const {documentKey} = require('../src/editorConfig');
const {readZip} = require('../src/zip');
const {zip, reviewedDocx} = require('./helpers.cjs');

const apiKey = 'k'.repeat(40);
const secret = 's'.repeat(32);
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const cleanDocx = () => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Утверждаемый текст</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`
});

// Fake document server: Command API and synchronous conversion that downloads the print copy.
const commands = [];
const conversions = [];
let docs;
let gateway;
let settings;
let printUrl;

function verifyToken(body) {
  const {token, ...payload} = body;
  const [header, claims, signature] = token.split('.');
  assert.equal(signature, crypto.createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url'));
  const decoded = JSON.parse(Buffer.from(claims, 'base64url'));
  for (const [name, value] of Object.entries(payload)) assert.deepEqual(decoded[name], value, name);
}

before(async () => {
  docs = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/result/')) return res.end('%PDF-1.7 fake pdf');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    verifyToken(body);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/command') {
      commands.push(body);
      if (body.c === 'info') return res.end(JSON.stringify(body.key === documentKey({id: 'open', versionNo: 1, revision: '3'}) ? {key: body.key, error: 0, users: ['u-201']} : {key: body.key, error: 1}));
      return res.end(JSON.stringify({key: body.key, error: 0}));
    }
    // The document server fetches the source like any document URL.
    printUrl = body.url;
    const print = Buffer.from(await (await fetch(body.url)).arrayBuffer());
    conversions.push({...body, print});
    res.end(JSON.stringify({endConvert: true, percent: 100, fileUrl: `http://127.0.0.1:${docs.address().port}/result/${body.key}`}));
  });
  await new Promise(resolve => docs.listen(0, '127.0.0.1', resolve));
  settings = settingsFromEnv({OFFICIER_JWT_SECRET: secret, GATEWAY_API_KEY: apiKey, OFFICIER_INTERNAL_URL: `http://127.0.0.1:${docs.address().port}`});
  gateway = createServer(settings);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  settings.gatewayInternalUrl = `http://127.0.0.1:${gateway.address().port}`;
});

after(() => {
  gateway.close();
  docs.close();
});

const call = (path, body) => fetch(settings.gatewayInternalUrl + path, {
  method: 'POST', headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)
});
const request = (docx, overrides = {}) => ({
  document: {base64: docx.toString('base64'), code: 'РЕГ-ДОТиОС-2026-014', name: 'Регламент', versionNo: 2},
  approvals: [{name: 'Иванов И. И.', position: 'Начальник ОТиОС', stage: 'Согласование', decision: 'Согласовано', date: '2026-10-13'}],
  ...overrides
});

test('Finalize returns the frozen source and the signed-for PDF with their SHA-256', async () => {
  const response = await call('/api/v1/finalize', request(cleanDocx()));
  assert.equal(response.status, 200);
  const result = await response.json();
  for (const file of [result.source, result.pdf]) {
    const bytes = Buffer.from(file.base64, 'base64');
    assert.equal(file.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.size, bytes.length);
  }
  assert.equal(Buffer.from(result.pdf.base64, 'base64').toString(), '%PDF-1.7 fake pdf');
  assert.equal(result.review.summary.openSuggestions, 0);
  // The document server converted the print copy: source text plus the approval sheet.
  const conversion = conversions.at(-1);
  assert.deepEqual([conversion.filetype, conversion.outputtype, conversion.async], ['docx', 'pdf', false]);
  assert.match(conversion.key, /^qmsfin_[0-9a-f]{40}$/);
  const printed = readZip(conversion.print).readText('word/document.xml');
  assert.match(printed, /Утверждаемый текст[\s\S]*ЛИСТ СОГЛАСОВАНИЯ[\s\S]*Иванов И\. И\.[\s\S]*13\.10\.2026/);
  assert.match(printed, new RegExp(`SHA-256: ${result.source.sha256}`));
  // The print copy was reachable only during the conversion, without the service key.
  assert.equal((await fetch(printUrl)).status, 404);
});

test('Finalize refuses a document with undecided suggestions', async () => {
  const response = await call('/api/v1/finalize', request(reviewedDocx()));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error, 'GW-409-OPEN-SUGGESTIONS');
  assert.equal(body.details.openSuggestions, 5);
  assert.equal(body.details.suggestions.length, 5);
  assert.deepEqual(Object.keys(body.details.suggestions[0]), ['id', 'type', 'author', 'stamp', 'textBefore', 'textAfter']);
});

test('Finalize validates the card and the approval sheet', async () => {
  const response = await call('/api/v1/finalize', request(cleanDocx(), {approvals: [{name: 'Без решения', date: 'вчера'}], document: {url: 'ftp://x', base64: 'AA==', versionNo: 0}}));
  assert.equal(response.status, 422);
  const {details} = await response.json();
  for (const expected of [/exactly one/, /url must be/, /code is required/, /name is required/, /versionNo/, /decision is required/, /date must be/]) {
    assert.ok(details.some(item => expected.test(item)), `${expected} in ${details.join('; ')}`);
  }
});

test('Finalize needs the address under which the document server reaches the gateway', async () => {
  const local = createServer({...settings, gatewayInternalUrl: null});
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${local.address().port}/api/v1/finalize`, {method: 'POST', headers: {Authorization: `Bearer ${apiKey}`}, body: JSON.stringify(request(cleanDocx()))});
    assert.equal(response.status, 503);
  } finally {
    local.close();
  }
});

test('Closing sessions disconnects everybody, or reports that nothing is open', async () => {
  commands.length = 0;
  const open = await (await call('/api/v1/editor/close', {document: {id: 'open', versionNo: 1, revision: '3'}})).json();
  assert.deepEqual(open, {key: documentKey({id: 'open', versionNo: 1, revision: '3'}), session: 'closing', users: ['u-201']});
  assert.deepEqual(commands.map(item => item.c), ['info', 'drop']);
  assert.equal(commands[1].users, undefined, 'drop without a user list disconnects everybody');

  commands.length = 0;
  const none = await (await call('/api/v1/editor/close', {document: {id: 'never-opened', versionNo: 1, revision: '1'}})).json();
  assert.equal(none.session, 'none');
  assert.deepEqual(commands.map(item => item.c), ['info']);

  const invalid = await call('/api/v1/editor/close', {document: {id: 'x'}});
  assert.equal(invalid.status, 422);
});
