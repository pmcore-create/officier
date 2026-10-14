const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Runs after `npm ci`: parses the overrides with the same libraries the server uses.
const server = path.join(__dirname, '../server');
const load = name => require(require.resolve(name, {paths: [path.join(server, 'DocService')]}));
const ms = load('ms');
const bytes = load('bytes');
const defaults = require(path.join(server, 'Common/config/default.json'));
const overrides = require(path.join(__dirname, '../docker/config/local-production-linux.json'));

function leaves(value, prefix = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...prefix, key]));
}

test('Every overridden setting exists in the server defaults', () => {
  for (const [keys] of leaves(overrides)) {
    const known = keys.reduce((node, key) => (node && Object.hasOwn(node, key) ? node[key] : undefined), defaults);
    assert.notEqual(known, undefined, `${keys.join('.')} is not a server setting`);
  }
});

test('Expiry durations parse the way DocsCoServer reads them; idle sessions never expire', () => {
  for (const [key, value] of Object.entries(overrides.services.CoAuthoring.expire)) {
    assert.equal(Number.isFinite(ms(value)), true, `expire.${key} = ${JSON.stringify(value)}`);
  }
  assert.equal(ms(overrides.services.CoAuthoring.expire.sessionidle), 0);
});

test('Size limits parse as bytes', () => {
  assert.equal(bytes.parse(overrides.services.CoAuthoring.editor.maxChangesSize), 80 * 1024 * 1024);
  for (const limit of overrides.FileConverter.converter.inputLimits) {
    assert.equal(bytes.parse(limit.zip.uncompressed) > 0, true, limit.type);
  }
});
