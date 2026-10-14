const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const {branding, renderApiDefaults} = require('../docker/branding/apply.js');
const template = fs.readFileSync(path.join(__dirname, '../docker/branding/api-defaults.js'), 'utf8');
// As served after the container start script replaced {{HASH_POSTFIX}} with the cache tag.
const source = renderApiDefaults(template, branding.api, '/9.4.0-{{HASH_POSTFIX}}').replace('{{HASH_POSTFIX}}', 'abc123');

// Objects created inside the vm context have their own prototypes; compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

// Run the appended api.js block against a stub of the upstream DocsAPI constructor.
function load(code = source) {
  const calls = [];
  function DocEditor(placeholderId, config) {
    calls.push({placeholderId, config, self: this});
    return {destroyEditor() {}};
  }
  DocEditor.defaultConfig = {type: 'desktop'};
  DocEditor.version = () => '9.4.0';
  const window = {DocsAPI: {DocEditor}};
  const document = {currentScript: {src: 'https://docs.example.kz/web-apps/apps/api/documents/api.js'}};
  vm.runInNewContext(code, {window, document, URL});
  return {DocsAPI: window.DocsAPI, Original: DocEditor, calls};
}

test('Branding is forced even when the integrator asks for ONLYOFFICE defaults', () => {
  const {DocsAPI, calls} = load();
  const editor = new DocsAPI.DocEditor('host', {
    editorConfig: {customization: {logo: {image: 'onlyoffice.svg'}, help: true, about: false, features: {spellcheck: false}}}
  });
  assert.equal(typeof editor.destroyEditor, 'function');
  const customization = calls[0].config.editorConfig.customization;
  assert.deepEqual(plain(customization.logo), {visible: false});
  assert.equal(customization.loaderName, undefined);
  assert.equal(customization.about, true);
  assert.equal(customization.help, false);
  assert.equal(customization.feedback, false);
  assert.equal(customization.suggestFeature, false);
  assert.deepEqual(plain(customization.features), {spellcheck: false, featuresTips: false});
  assert.equal(customization.customer.info, branding.api.legalNotice);
  assert.match(customization.customer.info, /ONLYOFFICE.*Ascensio System SIA/);
  assert.equal(customization.customer.www, 'https://docs.example.kz/welcome/officier.html');
});

test('Corporate defaults stay overridable and the caller config is not mutated', () => {
  const {DocsAPI, calls} = load();
  const config = {editorConfig: {customization: {plugins: true}}};
  new DocsAPI.DocEditor('host', config);
  const customization = calls[0].config.editorConfig.customization;
  assert.equal(customization.plugins, true);
  assert.equal(customization.macros, false);
  assert.equal(customization.integrationMode, 'embed');
  assert.deepEqual(config, {editorConfig: {customization: {plugins: true}}});
});

test('Kazakh users get the Russian interface with Kazakh regional settings', () => {
  const {DocsAPI, calls} = load();
  new DocsAPI.DocEditor('host', {editorConfig: {lang: 'kk'}});
  assert.equal(calls[0].config.editorConfig.lang, 'ru');
  assert.equal(calls[0].config.editorConfig.region, 'kk-KZ');
});

test('Injected api.js code is ASCII so any host page encoding keeps Cyrillic intact', () => {
  assert.match(source, /^[\x00-\x7f]*$/);
  const {calls, DocsAPI} = load();
  new DocsAPI.DocEditor('host', {});
  assert.equal(calls[0].config.editorConfig.customization.customer.name, branding.api.productName);
});

test('Plugins of this server load through the cache-tagged path, others stay untouched', () => {
  const plugins = {
    pluginsData: ['https://docs.example.kz/sdkjs-plugins/qms-review/config.json', 'https://other.example.kz/sdkjs-plugins/x/config.json'],
    autostart: ['asc.{guid}']
  };
  const {DocsAPI, calls} = load();
  new DocsAPI.DocEditor('host', {editorConfig: {plugins}});
  assert.deepEqual(plain(calls[0].config.editorConfig.plugins), {
    pluginsData: ['https://docs.example.kz/9.4.0-abc123/sdkjs-plugins/qms-review/config.json', 'https://other.example.kz/sdkjs-plugins/x/config.json'],
    autostart: ['asc.{guid}']
  });

  const unstarted = load(renderApiDefaults(template, branding.api, '/9.4.0-{{HASH_POSTFIX}}'));
  new unstarted.DocsAPI.DocEditor('host', {editorConfig: {plugins}});
  assert.deepEqual(plain(unstarted.calls[0].config.editorConfig.plugins.pluginsData), plugins.pluginsData);
});

test('Upstream statics are preserved and the wrapper installs once', () => {
  const {DocsAPI, Original} = load();
  assert.equal(DocsAPI.DocEditor.defaultConfig, Original.defaultConfig);
  assert.equal(DocsAPI.DocEditor.version(), '9.4.0');
  assert.equal(DocsAPI.DocEditor.officierBranding, true);
});
