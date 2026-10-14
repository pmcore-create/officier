// Performance check against a running stand (docker compose up):
//  1. N documents converted at the same time (opening and saving go through the same converter);
//  2. how fast one co-author's typing appears for another.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {crc32, deflateRawSync} from 'node:zlib';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';

const docs = process.env.OFFICIER_URL || 'http://127.0.0.1:8080';
const gateway = process.env.GATEWAY_URL || 'http://127.0.0.1:8081';
const {JWT_SECRET: secret, GATEWAY_API_KEY: apiKey} = process.env;
assert(secret && apiKey, 'JWT_SECRET and GATEWAY_API_KEY are required');
const fixturePort = Number(process.env.FIXTURE_PORT || 8092);
const portal = `http://host.docker.internal:${fixturePort}`;
const parallel = Number(process.env.PERF_PARALLEL || 8);

const sign = body => {
  const encoded = [{alg: 'HS256', typ: 'JWT'}, body].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// A regulation-sized document (~60 pages of text and tables) so the converter does real work.
function largeDocx(paragraphs) {
  const zip = files => {
    const parts = [];
    const directory = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const data = Buffer.from(text);
      const packed = deflateRawSync(data);
      const nameBytes = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
      central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
      parts.push(local, nameBytes, packed);
      directory.push(central, nameBytes);
      offset += 30 + nameBytes.length + packed.length;
    }
    const dir = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, dir, end]);
  };
  const text = 'Владелец документа обеспечивает актуальность содержания, согласование с заинтересованными подразделениями и своевременный пересмотр в соответствии с требованиями системы менеджмента качества. ';
  const cell = value => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  let body = '';
  for (let i = 0; i < paragraphs; i++) {
    body += `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${i + 1}. </w:t></w:r><w:r><w:t xml:space="preserve">${text.repeat(3)}</w:t></w:r></w:p>`;
    if (i % 25 === 24) body += `<w:tbl>${Array.from({length: 6}, (_, r) => `<w:tr>${cell(`Строка ${r + 1}`)}${cell('Ответственный')}${cell('Срок: 10 рабочих дней')}</w:tr>`).join('')}</w:tbl>`;
  }
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`
  });
}

execFileSync('python3', ['document.py'], {cwd: import.meta.dirname});
const file = await readFile(new URL('./document.docx', import.meta.url));
const large = largeDocx(Number(process.env.PERF_PARAGRAPHS || 300));
let pageConfig = null;
// Documents whose session has ended (2 = saved, 4 = closed without changes).
const closed = new Set();
const fixture = createServer(async (req, res) => {
  if (req.url.startsWith('/large')) return res.end(large);
  if (req.url.startsWith('/file')) return res.end(file);
  if (req.url === '/callback') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const {key, status} = JSON.parse(raw);
    if ([2, 4].includes(status)) closed.add(key);
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end('{"error":0}');
  }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  res.end(`<!doctype html><meta charset="utf-8"><div id="h" style="height:800px"></div><script src="${docs}/web-apps/apps/api/documents/api.js"></script><script>const c=${JSON.stringify(pageConfig)};c.events={onDocumentReady:()=>window.ready=true};new DocsAPI.DocEditor('h',c)</script>`);
});
await new Promise(resolve => fixture.listen(fixturePort, '0.0.0.0', resolve));

async function convert(key, source = 'large') {
  const body = {async: false, filetype: 'docx', outputtype: 'pdf', key, title: 'perf.docx', url: `${portal}/${source}?k=${key}`};
  const started = Date.now();
  const response = await fetch(`${docs}/converter`, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${sign({payload: body})}`}, body: JSON.stringify(body)});
  const result = await response.json();
  assert(result.endConvert, JSON.stringify(result));
  return Date.now() - started;
}

const run = Date.now();
const single = await convert(`perf-single-${run}`);
const batchStarted = Date.now();
const durations = await Promise.all(Array.from({length: parallel}, (_, i) => convert(`perf-batch-${run}-${i}`)));
const batch = Date.now() - batchStarted;
console.log(`Conversion: one document ${single} ms; ${parallel} at once ${batch} ms total, slowest ${Math.max(...durations)} ms, ~${(batch / single).toFixed(1)}x a single one`);

// A short document opened while others save large ones: with one converter it would wait for all of them.
const busyCount = Number(process.env.PERF_BUSY || 2);
const alone = await convert(`perf-small-${run}`, 'file');
const heavy = Promise.all(Array.from({length: busyCount}, (_, i) => convert(`perf-busy-${run}-${i}`)));
await new Promise(resolve => setTimeout(resolve, 500));
const busy = await convert(`perf-small-busy-${run}`, 'file');
const heavyTotal = Math.max(...await heavy);
console.log(`Short document: ${alone} ms on an idle server, ${busy} ms while ${busyCount} large ones convert (they take ${heavyTotal} ms)`);
if (process.env.PERF_CONVERT_ONLY) {
  fixture.close();
  process.exit(0);
}

async function editor(browser, user, access = {status: 'DRAFT', role: 'OWNER'}, documentId = `perf-${run}`) {
  const response = await fetch(`${gateway}/api/v1/editor-config`, {method: 'POST', headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'}, body: JSON.stringify({
    document: {id: documentId, versionNo: 1, revision: '1', title: 'Perf.docx', url: `${portal}/file`, callbackUrl: `${portal}/callback`},
    user, access})});
  pageConfig = (await response.json()).config;
  opened.add(pageConfig.document.key);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${fixturePort}/`);
  await page.waitForFunction(() => window.ready, null, {timeout: 180000});
  const frame = page.frames().find(item => item.url().includes('/documenteditor/'));
  await frame.waitForFunction(() => !!window.Asc?.editor?.WordControl?.m_oLogicDocument);
  return {page, frame};
}

const opened = new Set();
const browser = await chromium.launch();
try {
  const a = await editor(browser, {id: 'perf-a', name: 'Автор А'});
  const b = await editor(browser, {id: 'perf-b', name: 'Автор Б'});
  const latencies = [];
  for (let i = 0; i < 5; i++) {
    const marker = `M${i}x${Date.now() % 100000}`;
    const started = Date.now();
    await a.frame.evaluate(text => window.Asc.editor.asc_AddText(text + ' '), marker);
    await b.frame.waitForFunction(text => window.Asc.editor.WordControl.m_oLogicDocument.GetText().includes(text), marker, {timeout: 60000, polling: 20});
    latencies.push(Date.now() - started);
  }
  console.log(`Co-editing: typing of user A visible to user B after ${median(latencies)} ms (median of ${latencies.join(', ')} ms)`);
  await a.page.close();
  await b.page.close();

  // A reviewer's suggestion as it shows up in the owner's review panel.
  const reviewer = await editor(browser, {id: 'perf-r', name: 'Рецензент'}, {status: 'ON_REVIEW', role: 'REVIEWER', round: 1, stageNo: 1}, `perf-panel-${run}`);
  const owner = await editor(browser, {id: 'perf-o', name: 'Автор'}, {status: 'ON_REVIEW', role: 'OWNER', round: 1}, `perf-panel-${run}`);
  let panel;
  for (let i = 0; i < 60 && !panel; i++) {
    panel = owner.page.frames().find(frame => frame.url().includes('/sdkjs-plugins/qms-review/index.html'));
    if (!panel) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(panel, 'Review panel did not open');
  await panel.waitForFunction(() => /Правок без решения/.test(document.getElementById('summary').textContent), null, {timeout: 30000});
  const panelLatencies = [];
  for (let i = 0; i < 5; i++) {
    const marker = `P${i}x${Date.now() % 100000}`;
    const started = Date.now();
    await reviewer.frame.evaluate(text => window.Asc.editor.asc_AddText(text + ' '), marker);
    await panel.waitForFunction(text => document.body.innerText.includes(text), marker, {timeout: 60000, polling: 20});
    panelLatencies.push(Date.now() - started);
  }
  console.log(`Review panel: reviewer's suggestion listed for the owner after ${median(panelLatencies)} ms (median of ${panelLatencies.join(', ')} ms)`);
} finally {
  await browser.close();
  // Let the server deliver the final saves; otherwise it retries them in the background and slows the next run.
  for (const end = Date.now() + 60000; [...opened].some(key => !closed.has(key)) && Date.now() < end;) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fixture.close();
}
