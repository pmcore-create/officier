// End-to-end check of the QMS gateway policy in the real editor against a running stand
// (docker compose up): reviewer suggestions and comments, owner comment-only, reader view.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';

const docs = process.env.OFFICIER_URL || 'http://127.0.0.1:8080';
const gateway = process.env.GATEWAY_URL || 'http://127.0.0.1:8081';
const apiKey = process.env.GATEWAY_API_KEY;
assert(apiKey, 'GATEWAY_API_KEY is required');
// Address under which the document server container reaches this script (compose extra_hosts).
// The demo portal may already use 8090 on the same machine.
const fixturePort = Number(process.env.FIXTURE_PORT || 8090);
const portal = `http://host.docker.internal:${fixturePort}`;

execFileSync('python3', ['document.py'], {cwd: import.meta.dirname});
let file = await readFile(new URL('./document.docx', import.meta.url));
let revision = 1;
let saves = 0;
// Editing sessions that ended (callback 2 = saved with changes, 4 = closed without changes).
let ended = 0;
const pages = new Map();
// Sessions left over from earlier runs may still call back on the same port: answer them, but ignore their files.
const run = `${process.pid}-${Date.now()}`;
const documentId = `qms-e2e-${run}`;

async function gatewayRaw(path, body, contentType = 'application/json') {
  const response = await fetch(gateway + path, {method: 'POST', headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': contentType}, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
}

async function gatewayCall(path, body, contentType = 'application/json') {
  const {status, body: result} = await gatewayRaw(path, body, contentType);
  assert.equal(status, 200, JSON.stringify(result));
  return result;
}

// The current stored file goes in as base64: the gateway container cannot reach this script.
function finalizeRequest() {
  return {
    document: {base64: file.toString('base64'), code: 'РЕГ-ТЕСТ-2026-001', name: 'Регламент управления документацией', versionNo: 1},
    approvals: [
      {name: 'Петров П. П.', position: 'Начальник отдела качества', stage: 'Согласование, этап 2', decision: 'Согласовано', date: new Date().toISOString()},
      {name: 'Ахметова Г. К.', position: 'Нормоконтролёр', stage: 'Нормоконтроль', decision: 'Согласовано', date: new Date().toISOString()}
    ]
  };
}

function editorRequest(access, user) {
  return JSON.stringify({
    document: {id: documentId, versionNo: 1, revision: String(revision), title: 'Регламент.docx', url: `${portal}/file?r=${revision}`, callbackUrl: `${portal}/callback/${run}`},
    user,
    access
  });
}

const fixture = createServer(async (req, res) => {
  if (req.url.startsWith('/file')) {
    res.writeHead(200, {'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
    return res.end(file);
  }
  if (req.url.startsWith('/callback/')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const callback = JSON.parse(raw);
    const ours = req.url === `/callback/${run}`;
    console.log(`Save callback status: ${callback.status}${ours ? '' : ' (earlier run, ignored)'}`);
    if (ours && [2, 6].includes(callback.status) && callback.url) {
      file = Buffer.from(await (await fetch(callback.url)).arrayBuffer());
      await writeFile(new URL('./saved-qms.docx', import.meta.url), file);
      revision++;
      saves++;
    }
    if (ours && [2, 4].includes(callback.status)) ended++;
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end('{"error":0}');
  }
  const config = pages.get(req.url.slice(1));
  res.writeHead(config ? 200 : 404, {'Content-Type': 'text/html; charset=utf-8'});
  res.end(`<!doctype html><html><meta charset="utf-8"><style>html,body,#host{margin:0;width:100%;height:100%}</style><div id="host"></div><script src="${docs}/web-apps/apps/api/documents/api.js"></script><script>window.ready=false;window.errors=[];const config=${JSON.stringify(config)};config.events={onDocumentReady:()=>window.ready=true,onError:e=>window.errors.push(e.data)};window.instance=new DocsAPI.DocEditor('host',config);</script></html>`);
});
await new Promise(resolve => fixture.listen(fixturePort, '0.0.0.0', resolve));

async function open(browser, name, config) {
  pages.set(name, config);
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on('pageerror', error => {
    errors.push(error.message);
    console.log(`[${name}] browser error:`, error.message);
  });
  await page.goto(`http://127.0.0.1:${fixturePort}/${name}`);
  await page.waitForFunction(() => window.ready || window.errors.length, null, {timeout: 180000});
  assert.deepEqual(await page.evaluate(() => window.errors), [], name);
  const editor = page.frames().find(frame => frame.url().includes('/documenteditor/'));
  await editor.waitForFunction(() => !!window.Asc?.editor?.WordControl?.m_oLogicDocument);
  return {page, editor, errors};
}

// The review panel plugin opens by itself (right or left variant share the same page).
async function reviewPanel(page, summary) {
  let panel;
  for (let i = 0; i < 60 && !panel; i++) {
    panel = page.frames().find(frame => frame.url().includes('/sdkjs-plugins/qms-review/index.html'));
    if (!panel) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(panel, 'Review panel did not open');
  await panel.waitForFunction(pattern => new RegExp(pattern).test(document.getElementById('summary').textContent), summary, {timeout: 30000})
    .catch(async err => {
      const state = await panel.evaluate(() => {
        const result = {text: document.body.innerText, api: !!window.parent.Asc?.editor?.asc_GetTrackRevisionsReportByAuthors, info: !!window.Asc?.plugin?.info};
        try {
          result.revisions = Object.keys(window.parent.Asc.editor.asc_GetTrackRevisionsReportByAuthors());
          result.comments = Object.keys(window.parent.Asc.editor.asc_GetCommentsReportByAuthors());
        } catch (error) {
          result.error = error.stack;
        }
        return result;
      });
      throw new Error(`Review panel shows ${JSON.stringify(state)}: ${err.message}`);
    });
  return {panel, text: await panel.evaluate(() => document.body.innerText)};
}

const options = editor => editor.evaluate(() => {
  const app = DE.getController('Main').appOptions;
  return {isEdit: app.isEdit, isReviewOnly: !!app.isReviewOnly, canReview: !!app.canReview, canComments: !!app.canComments,
    canViewComments: !!app.canViewComments, isRestrictedEdit: !!app.isRestrictedEdit, viewMode: window.Asc.editor.isViewMode,
    trackChanges: window.Asc.editor.asc_GetLocalTrackRevisions()};
});

async function waitForSessionEnd(before) {
  for (const end = Date.now() + 180000; ended === before;) {
    assert(Date.now() < end, 'The editing session did not end with a save callback');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// Waits for the end of the session (not the forced save before it), so the next step sees the final file.
async function closeAndSave(page, editor) {
  const before = ended;
  // Push pending changes to the server first; closing alone may end the session without them.
  await editor.evaluate(() => window.Asc.editor.asc_Save());
  await editor.waitForFunction(() => !window.Asc.editor.asc_IsDocumentModified?.(), null, {timeout: 60000}).catch(() => {});
  await page.evaluate(() => window.instance.destroyEditor());
  await waitForSessionEnd(before);
  await page.close();
}

const browser = await chromium.launch({headless: true});
try {
  // 1. Route participant, round 1, stage 2: suggestions only, comments immutable.
  const reviewerConfig = await gatewayCall('/api/v1/editor-config', editorRequest({status: 'ON_REVIEW', role: 'REVIEWER', round: 1, stageNo: 2}, {id: 'u-201', name: 'Петров П. П.'}));
  assert.equal(reviewerConfig.policy.mode, 'REVIEW');
  const reviewer = await open(browser, 'reviewer', reviewerConfig.config);
  const reviewerOptions = await options(reviewer.editor);
  assert.equal(reviewerOptions.isReviewOnly, true, JSON.stringify(reviewerOptions));
  assert.equal(reviewerOptions.trackChanges, true, JSON.stringify(reviewerOptions));
  const comment = await reviewer.editor.evaluate(async () => {
    const api = window.Asc.editor;
    api.asc_AddText('Замечание согласующего. ');
    api.asc_EditSelectAll();
    const controller = DE.getController('Common.Controllers.Comments');
    const data = new Asc.asc_CCommentDataWord(null);
    data.asc_putText('Уточнить формулировку');
    data.asc_putTime(controller.utcDateToString(new Date()));
    data.asc_putOnlyOfficeTime(controller.ooDateToString(new Date()));
    data.asc_putUserId(controller.currentUserId);
    data.asc_putUserName(AscCommon.UserInfoParser.getCurrentName());
    data.asc_putSolved(false);
    data.asc_putDocumentFlag(false);
    api.asc_addComment(data);
    for (let i = 0; i < 50 && !controller.collection.length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const model = controller.collection.at(0);
    return {count: controller.collection.length, editable: model.get('editable'), removable: model.get('removable'),
      stored: model.get('username'), shown: AscCommon.UserInfoParser.getParsedName(model.get('username'))};
  });
  // The stamp is stored with the author, the interface shows the plain name.
  assert.deepEqual(comment, {count: 1, editable: false, removable: false, stored: 'R1.S2\u00a0Петров П. П.', shown: 'Петров П. П.'});
  // Review panel opens by itself on the right and names the author of every change and comment.
  const reviewerPanel = await reviewPanel(reviewer.page, 'Правок без решения: 1 · комментариев: 1');
  assert.match(reviewerPanel.text, /Петров П\. П\.[\s\S]*круг 1 · этап 2[\s\S]*Уточнить формулировку[\s\S]*Вставлено[\s\S]*Замечание согласующего/, reviewerPanel.text);
  // Lock the word "Officier": the panel lists the lock and no tracked change appears.
  await reviewer.editor.evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    doc.MoveCursorToStartPos(false);
    for (let i = 0; i < 24; i++) doc.MoveCursorRight(false, false);
    for (let i = 0; i < 8; i++) doc.MoveCursorRight(true, false);
  });
  await reviewerPanel.panel.click('#lock');
  await reviewerPanel.panel.waitForFunction(() => /Заблокированные фрагменты · 1/.test(document.body.innerText), null, {timeout: 15000});
  const lockedText = await reviewerPanel.panel.evaluate(() => document.body.innerText);
  assert.match(lockedText, /Правок без решения: 1 ·[\s\S]*«Officier»[\s\S]*Петров П\. П\. · круг 1 · этап 2[\s\S]*Снять/, lockedText);
  // Typing inside the locked fragment changes nothing.
  assert.equal(await reviewer.editor.evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    doc.MoveCursorToStartPos(false);
    for (let i = 0; i < 27; i++) doc.MoveCursorRight(false, false);
    const before = doc.GetText();
    window.Asc.editor.asc_AddText('X');
    return before === doc.GetText();
  }), true);
  assert.deepEqual(reviewer.errors, []);
  await reviewer.page.screenshot({path: new URL('./smoke-qms-reviewer.png', import.meta.url).pathname});
  await closeAndSave(reviewer.page, reviewer.editor);
  console.log('Reviewer: tracked suggestion and immutable comment saved');

  // 2. The saved DOCX carries the round/stage stamps for the review report.
  const report = await gatewayCall('/api/v1/review/report', file, 'application/octet-stream');
  const inserted = report.suggestions.find(item => item.textAfter.includes('Замечание согласующего'));
  assert(inserted, JSON.stringify(report.suggestions));
  assert.deepEqual([inserted.type, inserted.author.name, inserted.author.stamp, inserted.author.round, inserted.author.stageNo], ['INSERT', 'Петров П. П.', 'R1.S2', 1, 2]);
  assert.deepEqual([report.comments[0].author.stamp, report.comments[0].text], ['R1.S2', 'Уточнить формулировку']);
  assert.equal(report.summary.openSuggestions, 1, JSON.stringify(report.summary));
  assert.deepEqual(report.locks.map(lock => [lock.text, lock.stamp, lock.userId, lock.contentLocked]), [['Officier', 'R1.S2', 'u-201', true]]);
  console.log('Review report:', JSON.stringify({summary: report.summary, userIds: [inserted.author.userId, report.comments[0].author.userId]}));

  // 3. Owner while the document is on the route: comments only, sees the suggestion and the comment.
  const ownerConfig = await gatewayCall('/api/v1/editor-config', editorRequest({status: 'ON_REVIEW', role: 'OWNER', round: 1}, {id: 'u-100', name: 'Сидорова А. А.'}));
  const owner = await open(browser, 'owner', ownerConfig.config);
  const ownerOptions = await options(owner.editor);
  assert.deepEqual([ownerOptions.isEdit, ownerOptions.isRestrictedEdit, ownerOptions.canComments], [false, true, true], JSON.stringify(ownerOptions));
  // Comment-only mode has no right panel: the review panel opens on the left with the same content.
  const ownerPanel = await reviewPanel(owner.page, 'Правок без решения: 1 · комментариев: 1');
  assert.match(ownerPanel.text, /Заблокированные фрагменты · 1[\s\S]*Петров П\. П\.[\s\S]*Уточнить формулировку[\s\S]*Замечание согласующего/, ownerPanel.text);
  assert.doesNotMatch(ownerPanel.text, /Снять/, 'The owner cannot release locks while the document is on the route');
  assert.deepEqual(owner.errors, []);
  await owner.page.screenshot({path: new URL('./smoke-qms-owner.png', import.meta.url).pathname});
  await owner.page.evaluate(() => window.instance.destroyEditor());
  await owner.page.close();
  console.log('Owner on route: comment-only mode, sees the lock');

  // 3b. Owner reworking the returned document releases the lock; no tracked change appears.
  const deciderConfig = await gatewayCall('/api/v1/editor-config', editorRequest({status: 'RETURNED', role: 'OWNER', round: 1}, {id: 'u-100', name: 'Сидорова А. А.'}));
  const decider = await open(browser, 'decider', deciderConfig.config);
  const deciderPanel = await reviewPanel(decider.page, 'Правок без решения: 1 · комментариев: 1');
  assert.match(deciderPanel.text, /Заблокированные фрагменты · 1[\s\S]*Снять/, deciderPanel.text);
  await deciderPanel.panel.click('text=Снять');
  await deciderPanel.panel.waitForFunction(() => /Блокировка снята/.test(document.body.innerText) && !/Заблокированные фрагменты/.test(document.body.innerText), null, {timeout: 15000});
  assert.match(await deciderPanel.panel.evaluate(() => document.getElementById('summary').textContent), /^Правок без решения: 1 ·/);
  assert.deepEqual(decider.errors, []);
  await closeAndSave(decider.page, decider.editor);
  console.log('Owner after return: lock released');

  // 3b2. A second route participant replaces a word ("smoke" -> "итоговый") and adds a sentence.
  const secondConfig = await gatewayCall('/api/v1/editor-config', editorRequest({status: 'ON_REVIEW', role: 'REVIEWER', round: 1, stageNo: 3}, {id: 'u-202', name: 'Иванов И. И.'}));
  const second = await open(browser, 'second', secondConfig.config);
  await second.editor.evaluate(() => {
    const api = window.Asc.editor;
    const doc = api.WordControl.m_oLogicDocument;
    doc.MoveCursorToStartPos(false);
    for (let i = 0; i < 33; i++) doc.MoveCursorRight(false, false); // after "Замечание согласующего. Officier "
    for (let i = 0; i < 5; i++) doc.MoveCursorRight(true, false);
    api.asc_AddText('итоговый');
    doc.MoveCursorToEndPos(false);
    api.asc_AddText(' Лишнее.');
  });
  await closeAndSave(second.page, second.editor);
  const reviewed = await gatewayCall('/api/v1/review/report', file, 'application/octet-stream');
  assert.deepEqual(reviewed.suggestions.map(item => [item.type, item.author.stamp, item.textBefore, item.textAfter]),
    [['INSERT', 'R1.S2', '', 'Замечание согласующего. '], ['REPLACE', 'R1.S3', 'smoke', 'итоговый'], ['INSERT', 'R1.S3', '', ' Лишнее.']]);

  // 3c. The PDF for the signer is built only when every suggestion has a decision.
  const blocked = await gatewayRaw('/api/v1/finalize', finalizeRequest());
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.deepEqual([blocked.body.error, blocked.body.details.openSuggestions], ['GW-409-OPEN-SUGGESTIONS', 3]);
  console.log('Finalize with undecided suggestions: refused');

  // 3d. The owner decides in the review panel: the editor's own accept/reject is off, a rejection
  // needs a reason, and every decision is written into the document.
  const sessionRef = {id: documentId, versionNo: 1, revision: String(revision)};
  const closingConfig = await gatewayCall('/api/v1/editor-config', editorRequest({status: 'RETURNED', role: 'OWNER', round: 1}, {id: 'u-100', name: 'Сидорова А. А.'}));
  const closing = await open(browser, 'closing', closingConfig.config);
  assert.equal(await closing.editor.evaluate(() => DE.getController('Main').appOptions.canReview), false, 'native accept/reject is hidden');
  const decisionPanel = (await reviewPanel(closing.page, 'Правок без решения: 3 · комментариев: 1')).panel;
  const authorBlock = name => decisionPanel.locator('section.author', {hasText: name});
  await authorBlock('Петров П. П.').locator('button.link.reject').click();
  const confirm = decisionPanel.locator('button.decide-confirm');
  assert.equal(await confirm.isDisabled(), true, 'no rejection without a reason');
  await decisionPanel.locator('textarea.decide-text').fill('Формулировка избыточна');
  await closing.page.screenshot({path: new URL('./smoke-qms-reject-form.png', import.meta.url).pathname});
  await confirm.click();
  await decisionPanel.waitForFunction(() => /Решения автора · 1/.test(document.body.innerText), null, {timeout: 15000});
  await authorBlock('Иванов И. И.').getByRole('button', {name: 'Принять', exact: true}).first().click(); // the replacement
  await decisionPanel.locator('textarea.decide-text').fill('Согласна');
  await decisionPanel.locator('button.decide-confirm').click();
  await decisionPanel.waitForFunction(() => /^Правок без решения: 1 · комментариев: 1 · решений: 2/.test(document.getElementById('summary').textContent), null, {timeout: 15000});
  // Deleting a suggested sentence directly (the owner edits freely) still asks for a decision.
  // The editor takes keys only after a click on the page, as with a real user coming from the panel.
  await closing.editor.locator('#editor_sdk').click({position: {x: 600, y: 500}});
  await closing.editor.evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    doc.MoveCursorToEndPos(false);
    for (let i = 0; i < 8; i++) doc.MoveCursorLeft(true, false); // " Лишнее."
  });
  await closing.page.keyboard.press('Backspace');
  await decisionPanel.waitForFunction(() => /Правки исчезли без решения · 1/.test(document.body.innerText), null, {timeout: 15000}).catch(async err => {
    const text = await closing.editor.evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.GetText());
    const panelText = await decisionPanel.evaluate(() => document.body.innerText);
    throw new Error(`No orphan warning. Document: ${JSON.stringify(text)}; panel: ${JSON.stringify(panelText)}: ${err.message}`);
  });
  await closing.page.screenshot({path: new URL('./smoke-qms-orphan.png', import.meta.url).pathname});
  await decisionPanel.locator('section.orphans button.link.reject').click();
  await decisionPanel.locator('textarea.decide-text').fill('Лишний текст');
  await decisionPanel.locator('button.decide-confirm').click();
  await decisionPanel.waitForFunction(() => /^Правок без решения: 0 · комментариев: 1 · решений: 3/.test(document.getElementById('summary').textContent) &&
    !/исчезли без решения/.test(document.body.innerText), null, {timeout: 15000});
  const decidedText = await decisionPanel.evaluate(() => document.body.innerText);
  assert.match(decidedText, /Решения автора · 3[\s\S]*Отклонена[\s\S]*Петров П\. П\.[\s\S]*Обоснование: Формулировка избыточна[\s\S]*Принята[\s\S]*Иванов И\. И\.[\s\S]*«smoke»[\s\S]*«итоговый»[\s\S]*Комментарий: Согласна[\s\S]*Отклонена[\s\S]*Лишнее[\s\S]*Обоснование: Лишний текст/, decidedText);
  assert.equal(await closing.editor.evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.GetText().trim()), 'Officier итоговый document.');
  await closing.page.screenshot({path: new URL('./smoke-qms-decisions.png', import.meta.url).pathname});
  console.log('Owner decisions: rejection with a reason, acceptance with a comment, deleted suggestion recorded');

  // 3e. Status change: the owner is still typing when the portal closes the session; the server
  // saves everything and the old tab cannot continue.
  await closing.editor.evaluate(() => {
    const api = window.Asc.editor;
    api.WordControl.m_oLogicDocument.MoveCursorToEndPos(false);
    api.asc_AddText(' Окончательная редакция.');
  });
  await new Promise(resolve => setTimeout(resolve, 3000)); // fast co-editing sends changes as they are made
  const [endedBeforeClose, savesBeforeClose] = [ended, saves];
  const closed = await gatewayCall('/api/v1/editor/close', JSON.stringify({document: sessionRef}));
  assert.deepEqual([closed.session, closed.users.length], ['closing', 1], JSON.stringify(closed));
  await waitForSessionEnd(endedBeforeClose);
  assert.equal(saves, savesBeforeClose + 1, 'closing a changed document saves it');
  const afterClose = await gatewayCall('/api/v1/review/report', file, 'application/octet-stream');
  assert.equal(afterClose.summary.openSuggestions, 0, 'decided before the session was closed');
  assert.deepEqual(afterClose.summary.decisions, {accepted: 1, rejected: 2});
  // Decisions may fall into one second, so compare them by the suggestion they decide.
  const decisionRows = afterClose.decisions
    .map(item => [item.suggestion.type, item.suggestion.author.stamp, item.decision, item.reason, item.decidedBy.stamp, item.decidedBy.userId, item.suggestion.textBefore, item.suggestion.textAfter, item.suggestion.date])
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  // The decision names the suggestion exactly as the earlier report did, so the portal can match them.
  const [petrovInsert, ivanovReplace, ivanovInsert] = reviewed.suggestions;
  assert.deepEqual(decisionRows, [
    ['INSERT', 'R1.S2', 'REJECTED', 'Формулировка избыточна', 'R1.OWNER', 'u-100', '', 'Замечание согласующего. ', petrovInsert.date],
    ['INSERT', 'R1.S3', 'REJECTED', 'Лишний текст', 'R1.OWNER', 'u-100', '', ' Лишнее.', ivanovInsert.date],
    ['REPLACE', 'R1.S3', 'ACCEPTED', 'Согласна', 'R1.OWNER', 'u-100', 'smoke', 'итоговый', ivanovReplace.date]
  ]);
  await closing.editor.evaluate(() => window.Asc.editor.asc_AddText(' Текст после закрытия.'));
  await new Promise(resolve => setTimeout(resolve, 5000));
  const reopened = await gatewayCall('/api/v1/editor/close', JSON.stringify({document: sessionRef}));
  assert.deepEqual(reopened.users, [], 'the closed tab must not reconnect to the old session');
  await closing.page.close();
  console.log('Session closed on status change: changes saved, old tab disconnected');

  // 3e. Approval snapshot: frozen source without comments and locks, PDF with the approval sheet.
  const final = await gatewayCall('/api/v1/finalize', JSON.stringify(finalizeRequest()));
  const sourceBytes = Buffer.from(final.source.base64, 'base64');
  const pdfBytes = Buffer.from(final.pdf.base64, 'base64');
  assert.equal(final.source.sha256, createHash('sha256').update(sourceBytes).digest('hex'));
  assert.equal(final.pdf.sha256, createHash('sha256').update(pdfBytes).digest('hex'));
  assert.equal(pdfBytes.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(final.removed.comments, 4, `the comment and three decisions: ${JSON.stringify(final.removed)}`);
  assert.equal(final.removed.locks, 0, 'the lock was released in 3b');
  assert.equal(final.review.decisions.length, 3, 'the decision journal comes back with the snapshot');
  const frozen = await gatewayCall('/api/v1/review/report', sourceBytes, 'application/octet-stream');
  assert.deepEqual([frozen.summary.openSuggestions, frozen.summary.comments, frozen.summary.locks], [0, 0, 0]);
  await writeFile(new URL('./approved-qms.pdf', import.meta.url), pdfBytes);
  await writeFile(new URL('./approved-qms.docx', import.meta.url), sourceBytes);
  console.log(`Finalize: PDF ${pdfBytes.length} bytes, sha256 ${final.pdf.sha256.slice(0, 12)}…, removed ${JSON.stringify(final.removed)}`);

  // 4. A browser cannot widen its permissions: an edited config no longer matches the signed token.
  const tampered = structuredClone(reviewerConfig.config);
  tampered.document.permissions = {...tampered.document.permissions, edit: true, review: false};
  pages.set('forged', tampered);
  const forged = await browser.newPage();
  await forged.goto(`http://127.0.0.1:${fixturePort}/forged`);
  await forged.waitForFunction(() => window.ready || window.errors.length, null, {timeout: 180000});
  const forgedErrors = await forged.evaluate(() => window.errors);
  assert.equal(forgedErrors[0]?.errorCode, -23, JSON.stringify(forgedErrors)); // access denied
  await forged.close();
  console.log('Tampered config: rejected by the document server');

  // 5. Employee reading a published version: view only, no review traces.
  const readerConfig = await gatewayCall('/api/v1/editor-config', editorRequest({status: 'ACTIVE', role: 'READER'}, {id: 'u-900', name: 'Сотрудник'}));
  const reader = await open(browser, 'reader', readerConfig.config);
  const readerOptions = await options(reader.editor);
  assert.deepEqual([readerOptions.viewMode, readerOptions.canComments, readerOptions.canViewComments], [true, false, false], JSON.stringify(readerOptions));
  await reader.page.close();
  console.log('Reader: view only without comments');
} finally {
  await browser.close();
  await new Promise(resolve => fixture.close(resolve));
}
