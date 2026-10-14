import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';

const base = 'http://127.0.0.1:8080';
// Same FIXTURE_PORT convention as qms.mjs: 8090 may be taken on the build machine.
const fixturePort = Number(process.env.FIXTURE_PORT || 8090);
const secret = process.env.JWT_SECRET;
assert(secret, 'JWT_SECRET is required');
const sign = body => {
  const encoded = [JSON.stringify({alg: 'HS256', typ: 'JWT'}), JSON.stringify(body)].map(v => Buffer.from(v).toString('base64url')).join('.');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
};
async function jsonPost(route, body, signed = true) {
  const response = await fetch(base + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...body, token: signed ? sign(body) : 'invalid'})});
  return response.json();
}
async function until(check, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for smoke condition');
}

await until(async () => {try {return (await (await fetch(base + '/healthcheck')).text()).trim() === 'true';} catch {return false;}}, 240000);
const license = await jsonPost('/command', {c: 'license'});
assert.equal(license.error, 0, JSON.stringify(license));
assert.equal(license.license.branding, true);
assert.equal(license.license.customization, true);
assert.equal(license.license.advanced_api, true);
assert.notEqual((await jsonPost('/command', {c: 'version'}, false)).error, 0, 'Invalid JWT was accepted');
const version = await jsonPost('/command', {c: 'version'});
assert.match(version.version, /^9\.4\.0\./);
assert.match(await (await fetch(base + '/welcome/officier.html')).text(), /Officier/);

const runtimeManifest = await (await fetch(base + '/officier/runtime/manifest.json')).json();
assert.equal(runtimeManifest.protocolVersion, 1);
assert.equal(runtimeManifest.capabilities.word, true);
assert.equal(runtimeManifest.capabilities.wopi, true);
assert.equal(runtimeManifest.capabilities.noIframe, true);
assert.deepEqual(runtimeManifest.assets.map(asset => asset.url), [
  '/web-apps/vendor/jquery/jquery.min.js',
  '/web-apps/vendor/xregexp/xregexp-all-min.js',
  '/web-apps/vendor/socketio/socket.io.min.js',
  '/sdkjs/word/sdk-all-min.js',
  'runtime/direct-word-adapter.js'
]);
console.log('Health, runtime capabilities, protocol version and JWT checks passed');

execFileSync('python3', ['document.py'], {cwd: import.meta.dirname});
const document = await readFile(new URL('./document.docx', import.meta.url));
const key = 'officier-smoke-' + Date.now();
let saved = null;
let callbackError = null;
function config(view = false) {
  const body = {documentType: 'word', document: {key: view ? key + '-view' : key, fileType: 'docx', title: 'Officier smoke.docx', url: `http://host.docker.internal:${fixturePort}/${view ? 'saved' : 'document'}.docx`, permissions: {edit: !view}}, editorConfig: {mode: view ? 'view' : 'edit', lang: 'en', user: {id: 'smoke-user', name: 'Smoke Test'}, callbackUrl: `http://host.docker.internal:${fixturePort}/callback`, customization: {forcesave: true}}, width: '100%', height: '100%'};
  return {...body, token: sign(body)};
}
const fixture = createServer(async (req, res) => {
  try {
    if (req.url === '/document.docx' || req.url === '/saved.docx') {
      res.writeHead(200, {'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
      return res.end(req.url === '/saved.docx' ? saved : document);
    }
    if (req.url === '/callback') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const callback = JSON.parse(raw);
      console.log('Save callback status:', callback.status);
      if ([2, 6].includes(callback.status) && callback.url) {
        const response = await fetch(callback.url);
        assert(response.ok, 'Saved file download failed');
        saved = Buffer.from(await response.arrayBuffer());
        await writeFile(new URL('./saved.docx', import.meta.url), saved);
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end('{"error":0}');
    }
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(`<!doctype html><html><style>html,body,#host{margin:0;width:100%;height:100%}</style><div id="host"></div><script src="${base}/web-apps/apps/api/documents/api.js"></script><script>window.ready=false;window.errors=[];const config=${JSON.stringify(config(req.url === '/view'))};config.events={onDocumentReady:()=>window.ready=true,onError:e=>window.errors.push(e.data)};window.instance=new DocsAPI.DocEditor('host',config);</script></html>`);
  } catch (error) {callbackError = error; res.writeHead(500); res.end(String(error));}
});
await new Promise(resolve => fixture.listen(fixturePort, '0.0.0.0', resolve));
const browser = await chromium.launch({headless: true});
try {
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', error => probeErrors.push(error.message));
  const probeResult = await probe.evaluate(async ({assets, baseUrl}) => {
    const loaded = [];
    const failed = [];
    for (const asset of assets) {
      const url = new URL(asset.url, baseUrl).toString();
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => {
          loaded.push(url);
          resolve();
        };
        script.onerror = () => {
          failed.push(url);
          reject(new Error(`Failed to load ${url}`));
        };
        document.head.append(script);
      });
    }
    return {
      loaded,
      failed,
      directRuntime: !!window.OfficierDirectRuntime,
      wordApi: !!(window.Asc?.asc_docs_api || window.asc_docs_api),
      socketIo: !!window.io,
      iframe: !!document.querySelector('iframe')
    };
  }, {assets: runtimeManifest.assets, baseUrl: base + '/officier/'});
  assert.equal(probeResult.socketIo, true, JSON.stringify({probeResult, probeErrors}));
  assert.equal(probeResult.wordApi, true, JSON.stringify({probeResult, probeErrors}));
  assert.equal(probeResult.directRuntime, true, JSON.stringify({probeResult, probeErrors}));
  assert.equal(probeResult.iframe, false, JSON.stringify({probeResult, probeErrors}));
  await probe.close();
  console.log('Direct runtime browser assets loaded without creating an iframe');

  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.on('pageerror', error => console.log('Browser error:', error.message));
  await page.goto(`http://127.0.0.1:${fixturePort}/`);
  await page.waitForFunction(() => window.ready || window.errors.length, null, {timeout: 180000});
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  assert.equal(await page.evaluate(() => window.ready), true);
  const editor = page.frames().find(frame => frame.url().includes('/documenteditor/'));
  assert(editor, 'Word editor iframe did not load');
  await editor.waitForFunction(() => !!window.Asc?.editor?.WordControl?.m_oLogicDocument);
  assert.equal(await editor.evaluate(() => window.Asc.editor.isViewMode), false);
  // Officier branding: no ONLYOFFICE marks in the working UI, legal notice stays in File > About.
  const branding = await editor.evaluate(() => {
    const about = DE.getController('LeftMenu').leftMenu.getMenu('about');
    about.show();
    return {
      title: document.title,
      logoHidden: document.querySelector('#header-logo')?.classList.contains('hidden') ?? true,
      about: about.$el.text().replace(/\s+/g, ' ')
    };
  });
  await page.screenshot({path: new URL('./smoke-about.png', import.meta.url).pathname});
  await editor.evaluate(() => DE.getController('LeftMenu').leftMenu.getMenu('about').hide());
  assert.doesNotMatch(branding.title, /ONLYOFFICE/i, JSON.stringify(branding));
  assert.equal(branding.logoHidden, true, JSON.stringify(branding));
  assert.match(branding.about, /ONLYOFFICE Docs 9\.4\.0.*Ascensio System SIA/, branding.about);
  assert.match(branding.about, /\/welcome\/officier\.html/, branding.about);
  console.log('Branding checks passed:', branding.title);
  await editor.evaluate(() => {window.Asc.editor.asc_AddText('OfficierSavedMarker'); window.Asc.editor.asc_Save();});
  await page.screenshot({path: new URL('./smoke.png', import.meta.url).pathname});
  // Force save (status 6) must land before the editor closes: on a slow (emulated) host closing
  // right away drops the unsent change and the server reports "closed without changes" (status 4).
  await until(async () => {if (callbackError) throw callbackError; return !!saved;}, 180000);
  // Closing the editor exercises the ordinary save callback path.
  await page.evaluate(() => window.instance.destroyEditor());
  execFileSync('python3', ['-c', "import zipfile; z=zipfile.ZipFile('saved.docx'); assert b'OfficierSavedMarker' in z.read('word/document.xml')"], {cwd: import.meta.dirname});
  await page.goto(`http://127.0.0.1:${fixturePort}/view`);
  await page.waitForFunction(() => window.ready, null, {timeout: 180000});
  const viewer = page.frames().find(frame => frame.url().includes('/documenteditor/'));
  assert.equal(await viewer.evaluate(() => window.Asc.editor.isViewMode), true);
  console.log('Real DOCX open/edit/save and view-only browser checks passed');
} finally {
  await browser.close();
  await new Promise(resolve => fixture.close(resolve));
}
