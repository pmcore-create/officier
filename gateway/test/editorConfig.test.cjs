const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {buildEditorConfig, documentKey} = require('../src/editorConfig');

const settings = {jwtSecret: 's'.repeat(32), tokenTtlSeconds: 3600, publicUrl: 'https://docs.example.kz'};
const request = (overrides = {}) => ({
  document: {id: 'doc-1', versionNo: 2, revision: 'etag-7', title: 'Регламент.docx', url: 'https://portal.example.kz/files/1', callbackUrl: 'https://portal.example.kz/qms/callback', status: 'x', ...overrides.document},
  user: {id: 'u-101', name: 'Иванов И. И.', lang: 'ru', ...overrides.user},
  access: {status: 'ON_REVIEW', role: 'REVIEWER', round: 1, stageNo: 2, ...overrides.access}
});

function verify(token) {
  const [header, payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', settings.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected);
  return JSON.parse(Buffer.from(payload, 'base64url'));
}

test('Reviewer config is signed and carries the policy', () => {
  const {config, policy, apiUrl} = buildEditorConfig(request(), settings);
  assert.equal(apiUrl, 'https://docs.example.kz/web-apps/apps/api/documents/api.js');
  assert.deepEqual(policy, {mode: 'REVIEW', stamp: 'R1.S2', readOnly: false, reviewVisible: true, reviewPanel: 'right'});
  assert.deepEqual(config.editorConfig.plugins, {
    pluginsData: ['https://docs.example.kz/sdkjs-plugins/qms-review/config.json'],
    autostart: ['asc.{8D3B2A54-0C1E-4F6A-9B7D-2E5F1C3A9D60}']
  });
  assert.equal(config.editorConfig.customization.plugins, true);
  assert.deepEqual(config.editorConfig.customization.layout, {toolbar: {plugins: false}});
  assert.equal(config.documentType, 'word');
  assert.equal(config.editorConfig.mode, 'edit');
  assert.deepEqual(config.editorConfig.user, {id: 'u-101', name: 'Иванов И. И.', group: 'R1.S2'});
  assert.equal(config.editorConfig.customization.forcesave, true);
  assert.deepEqual(config.editorConfig.coEditing, {mode: 'fast', change: false});
  assert.equal(config.document.permissions.review, true);

  const payload = verify(config.token);
  const {token, ...unsigned} = config;
  assert.deepEqual({documentType: payload.documentType, document: payload.document, editorConfig: payload.editorConfig}, unsigned);
  assert.equal(payload.exp - payload.iat, 3600);
});

test('All users of one stored file share the key; a new revision changes it', () => {
  const reviewer = buildEditorConfig(request(), settings).config.document.key;
  const owner = buildEditorConfig(request({user: {id: 'u-1', name: 'Автор'}, access: {role: 'OWNER'}}), settings).config.document.key;
  assert.equal(reviewer, owner);
  assert.notEqual(reviewer, documentKey({id: 'doc-1', versionNo: 2, revision: 'etag-8'}));
  assert.match(reviewer, /^[0-9a-zA-Z_]{1,128}$/);
});

test('Kazakh users get the Russian interface with Kazakh regional settings', () => {
  const {config} = buildEditorConfig(request({user: {lang: 'kk'}}), settings);
  assert.deepEqual([config.editorConfig.lang, config.editorConfig.region], ['ru', 'kk-KZ']);
});

test('Readers get a view-only config without a callback or stamp', () => {
  const {config, policy} = buildEditorConfig(request({document: {callbackUrl: undefined}, access: {status: 'ACTIVE', role: 'READER'}}), settings);
  assert.equal(policy.readOnly, true);
  assert.equal(config.editorConfig.mode, 'view');
  assert.equal(config.editorConfig.callbackUrl, undefined);
  assert.equal(config.editorConfig.user.group, undefined);
  assert.equal(config.editorConfig.customization.comments, false);
  assert.equal(config.editorConfig.plugins, undefined);
  assert.equal(policy.reviewPanel, null);
});

test('Review panel is only for documents on the route, docked where the editor has room', () => {
  const draft = buildEditorConfig(request({access: {status: 'DRAFT', role: 'OWNER'}}), settings);
  assert.equal(draft.config.editorConfig.plugins, undefined);
  const owner = buildEditorConfig(request({access: {role: 'OWNER'}}), settings);
  assert.equal(owner.policy.reviewPanel, 'left');
  assert.deepEqual(owner.config.editorConfig.plugins, {
    pluginsData: ['https://docs.example.kz/sdkjs-plugins/qms-review-left/config.json'],
    autostart: ['asc.{8D3B2A54-0C1E-4F6A-9B7D-2E5F1C3A9D61}']
  });
  assert.equal(owner.config.editorConfig.customization.officier.openComments, false);
  const supervisor = buildEditorConfig(request({document: {callbackUrl: undefined}, access: {status: 'ON_APPROVAL', role: 'SUPERVISOR'}}), settings);
  assert.equal(supervisor.policy.reviewPanel, 'left');
});

test('Requests are validated before anything is signed', () => {
  assert.throws(() => buildEditorConfig({}, settings), error => error.code === 'GW-422-INVALID' && error.details.length >= 7);
  assert.throws(() => buildEditorConfig(request({document: {url: 'file:///etc/passwd'}}), settings), {code: 'GW-422-INVALID'});
  assert.throws(() => buildEditorConfig(request({document: {title: 'scan.jpg'}}), settings), {code: 'GW-422-INVALID'});
  assert.throws(() => buildEditorConfig(request({document: {callbackUrl: undefined}}), settings),
    error => error.code === 'GW-422-INVALID' && /callbackUrl is required/.test(error.details[0]));
});
