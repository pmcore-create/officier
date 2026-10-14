'use strict';
// Demo portal for showing the QMS editor integration. Not for production: no users, no checks.
// It plays the portal backend: stores DOCX files, asks the gateway for configs, receives callbacks.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {sampleRegulation} = require('./sample');

const port = Number(process.env.DEMO_PORT || 8090);
const gatewayUrl = process.env.GATEWAY_URL || 'http://qms-gateway:8081';
const apiKey = process.env.GATEWAY_API_KEY || '';
// How the document server reaches this demo, and how the demo reaches the document server.
const selfUrl = process.env.DEMO_INTERNAL_URL || 'http://demo:8090';
const docsInternalUrl = process.env.OFFICIER_INTERNAL_URL || 'http://officier';
const dataDir = process.env.DEMO_DATA || path.join(__dirname, 'data');
const page = fs.readFileSync(path.join(__dirname, 'index.html'));

fs.mkdirSync(dataDir, {recursive: true});
const documents = new Map();
for (const name of fs.readdirSync(dataDir).filter(item => item.endsWith('.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  documents.set(meta.id, meta);
}

function store(meta, bytes) {
  if (bytes) fs.writeFileSync(path.join(dataDir, `${meta.id}.docx`), bytes);
  fs.writeFileSync(path.join(dataDir, `${meta.id}.json`), JSON.stringify(meta, null, 2));
  documents.set(meta.id, meta);
}

// The end of an editing session arrives as a callback: 2 = saved with changes, 4 = closed without.
const sessionEndWaiters = new Map();
function waitForSessionEnd(id, ms) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const waiter = status => {
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => {
      cancel();
      reject(Object.assign(new Error('Редактор не сохранил документ за отведённое время, повторите'), {status: 504}));
    }, ms);
    cancel = () => {
      clearTimeout(timer);
      sessionEndWaiters.set(id, (sessionEndWaiters.get(id) || []).filter(item => item !== waiter));
    };
    sessionEndWaiters.set(id, [...(sessionEndWaiters.get(id) || []), waiter]);
  });
  return {promise, cancel};
}
function sessionEnded(id, status) {
  const waiters = sessionEndWaiters.get(id) || [];
  sessionEndWaiters.delete(id);
  waiters.forEach(waiter => waiter(status));
}

function documentRef(meta) {
  return {id: meta.id, versionNo: 1, revision: String(meta.revision)};
}

// Status change on the portal: everybody leaves the editor, the server saves, then the portal goes on.
async function closeAndWait(meta) {
  const ended = waitForSessionEnd(meta.id, 90000);
  const closed = await gateway('/api/v1/editor/close', JSON.stringify({document: documentRef(meta)}));
  if (closed.status !== 200 || closed.body.session === 'none') ended.cancel();
  if (closed.status !== 200) throw Object.assign(new Error(closed.body.message || 'Шлюз не закрыл сеансы'), {status: closed.status});
  const status = closed.body.session === 'none' ? null : await ended.promise;
  return {session: closed.body.session, users: closed.body.users, savedStatus: status};
}

// Demo route decisions for the approval sheet (the portal takes them from QmsRoute).
function demoApprovals() {
  const date = new Date().toISOString();
  return [
    {name: 'Петров П. П.', position: 'Начальник отдела качества', stage: 'Согласование, этап 1', decision: 'Согласовано', date},
    {name: 'Иванов И. И.', position: 'Главный инженер', stage: 'Согласование, этап 2', decision: 'Согласовано с замечаниями', comment: 'Замечания учтены автором', date},
    {name: 'Ахметова Г. К.', position: 'Нормоконтролёр', stage: 'Нормоконтроль, этап 3', decision: 'Согласовано', date}
  ];
}

function create(title, bytes) {
  const meta = {id: crypto.randomUUID(), title, revision: 1, saves: [], createdAt: new Date().toISOString()};
  store(meta, bytes);
  return meta;
}

if (!documents.size) create('Регламент управления документацией СМК.docx', sampleRegulation());

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {'Content-Type': type, 'Content-Length': payload.length, 'Cache-Control': 'no-store'});
  res.end(payload);
}

async function body(req, limit = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Файл больше 50 МБ'), {status: 413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function gateway(route, payload, contentType = 'application/json') {
  const response = await fetch(gatewayUrl + route, {method: 'POST', headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': contentType}, body: payload});
  return {status: response.status, body: await response.json()};
}

function list() {
  return [...documents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({id, title, revision, saves, approved}) => ({id, title, revision, lastSave: saves[saves.length - 1] || null, approved: approved || null}));
}

const routes = {
  'GET /': (req, res) => send(res, 200, page, 'text/html; charset=utf-8'),
  'GET /api/documents': (req, res) => send(res, 200, list()),
  'POST /api/documents/sample': (req, res) => send(res, 200, create('Регламент управления документацией СМК.docx', sampleRegulation())),
  'POST /api/documents/upload': async (req, res, url) => {
    const title = (url.searchParams.get('name') || 'Документ.docx').replace(/[\\/]/g, '_');
    if (!/\.docx$/i.test(title)) return send(res, 415, {message: 'Допустим только DOCX'});
    send(res, 200, create(title, await body(req)));
  },
  'POST /api/editor-config': async (req, res) => {
    const {documentId, user, access} = JSON.parse((await body(req, 65536)).toString('utf8'));
    const meta = documents.get(documentId);
    if (!meta) return send(res, 404, {message: 'Документ не найден'});
    const result = await gateway('/api/v1/editor-config', JSON.stringify({
      document: {
        id: meta.id, versionNo: 1, revision: String(meta.revision), title: meta.title,
        url: `${selfUrl}/files/${meta.id}?r=${meta.revision}`, callbackUrl: `${selfUrl}/callback/${meta.id}`
      },
      user,
      access
    }));
    send(res, result.status, result.body);
  },
  'POST /api/report': async (req, res, url) => {
    const meta = documents.get(url.searchParams.get('id'));
    if (!meta) return send(res, 404, {message: 'Документ не найден'});
    const result = await gateway('/api/v1/review/report', fs.readFileSync(path.join(dataDir, `${meta.id}.docx`)), 'application/octet-stream');
    send(res, result.status, {...result.body, revision: meta.revision, lastSave: meta.saves[meta.saves.length - 1] || null});
  },
  'POST /api/close': async (req, res, url) => {
    const meta = documents.get(url.searchParams.get('id'));
    if (!meta) return send(res, 404, {message: 'Документ не найден'});
    send(res, 200, {...await closeAndWait(meta), revision: meta.revision});
  },
  // Before the APPROVE stage (QMS logic 6.1): freeze the final text, build the PDF the signer signs.
  'POST /api/approve': async (req, res, url) => {
    const meta = documents.get(url.searchParams.get('id'));
    if (!meta) return send(res, 404, {message: 'Документ не найден'});
    const closed = await closeAndWait(meta);
    const result = await gateway('/api/v1/finalize', JSON.stringify({
      document: {url: `${selfUrl}/files/${meta.id}?r=${meta.revision}`, code: 'РЕГ-ДОТиОС-2026-014', name: meta.title.replace(/\.docx$/i, ''), versionNo: 1},
      approvals: demoApprovals()
    }));
    if (result.status !== 200) return send(res, result.status, {...result.body, closed});
    const {source, pdf, removed} = result.body;
    fs.writeFileSync(path.join(dataDir, `${meta.id}.approved.docx`), Buffer.from(source.base64, 'base64'));
    fs.writeFileSync(path.join(dataDir, `${meta.id}.approved.pdf`), Buffer.from(pdf.base64, 'base64'));
    meta.approved = {at: new Date().toISOString(), revision: meta.revision, source: {sha256: source.sha256, size: source.size}, pdf: {sha256: pdf.sha256, size: pdf.size}, removed};
    store(meta);
    send(res, 200, {closed, approved: meta.approved});
  }
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://demo');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) return route(req, res, url);

  const file = /^\/(files|download)\/([\w-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && file && documents.has(file[2])) {
    const meta = documents.get(file[2]);
    const headers = {'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
    if (file[1] === 'download') headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(meta.title)}`;
    res.writeHead(200, headers);
    return res.end(fs.readFileSync(path.join(dataDir, `${meta.id}.docx`)));
  }

  const approved = /^\/approved\/([\w-]+)\.(pdf|docx)$/.exec(url.pathname);
  if (req.method === 'GET' && approved && documents.get(approved[1])?.approved) {
    const meta = documents.get(approved[1]);
    const name = `${meta.title.replace(/\.docx$/i, '')} (утверждаемая редакция).${approved[2]}`;
    res.writeHead(200, {
      'Content-Type': approved[2] === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `${approved[2] === 'pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`
    });
    return res.end(fs.readFileSync(path.join(dataDir, `${meta.id}.approved.${approved[2]}`)));
  }

  // Document server callback: 2 = all users left with changes, 6 = forced save (Save button),
  // 4 = all users left without changes.
  const callback = /^\/callback\/([\w-]+)$/.exec(url.pathname);
  if (req.method === 'POST' && callback && documents.has(callback[1])) {
    const data = JSON.parse((await body(req, 1024 * 1024)).toString('utf8'));
    if ([2, 6].includes(data.status) && data.url) {
      const source = new URL(data.url);
      const internal = new URL(source.pathname + source.search, docsInternalUrl);
      const bytes = Buffer.from(await (await fetch(internal)).arrayBuffer());
      const meta = documents.get(callback[1]);
      // A forced save keeps the editing session (and its key) alive; only status 2 ends it.
      if (data.status === 2) meta.revision++;
      meta.saves.push({at: new Date().toISOString(), status: data.status, users: data.users || []});
      store(meta, bytes);
      console.log(`saved ${meta.title} revision ${meta.revision} (status ${data.status})`);
    }
    if ([2, 4].includes(data.status)) sessionEnded(callback[1], data.status);
    return send(res, 200, {error: 0});
  }
  send(res, 404, {message: 'Не найдено'});
}

http.createServer((req, res) => handle(req, res).catch(err => {
  console.error(err);
  send(res, err.status || 500, {message: err.message});
})).listen(port, () => console.log(`QMS demo portal on ${port}`));
