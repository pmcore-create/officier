'use strict';
// Builds the signed Document Server config for one user opening one QMS document version.
const crypto = require('crypto');
const path = require('path');
const {GatewayError} = require('./errors');
const {resolvePolicy} = require('./policy');
const jwt = require('./jwt');

const DOCUMENT_TYPES = {docx: 'word', xlsx: 'cell', pptx: 'slide', pdf: 'pdf'};
// Same panel, docked right (editing modes) or left (comment-only and view modes have no right panel).
const REVIEW_PANELS = {
  right: {plugin: 'qms-review', guid: 'asc.{8D3B2A54-0C1E-4F6A-9B7D-2E5F1C3A9D60}'},
  left: {plugin: 'qms-review-left', guid: 'asc.{8D3B2A54-0C1E-4F6A-9B7D-2E5F1C3A9D61}'}
};

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function httpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validate(request) {
  const {document = {}, user = {}, access = {}} = request || {};
  const errors = [];
  if (!text(document.id)) errors.push('document.id is required');
  if (!Number.isInteger(document.versionNo) || document.versionNo < 1) errors.push('document.versionNo must be a positive integer');
  if (!text(document.revision)) errors.push('document.revision is required (changes whenever the stored file changes)');
  if (!text(document.title)) errors.push('document.title is required');
  if (!httpUrl(document.url)) errors.push('document.url must be an http(s) URL reachable by the document server');
  if (document.callbackUrl !== undefined && !httpUrl(document.callbackUrl)) errors.push('document.callbackUrl must be an http(s) URL');
  if (!text(user.id)) errors.push('user.id is required');
  if (!text(user.name)) errors.push('user.name is required');
  if (user.lang !== undefined && !['ru', 'kk'].includes(user.lang)) errors.push('user.lang must be ru or kk');
  if (!text(access.status)) errors.push('access.status is required');
  if (!text(access.role)) errors.push('access.role is required');
  if (errors.length) throw new GatewayError(422, 'GW-422-INVALID', 'Invalid editor config request', errors);
  return {document, user, access};
}

function fileTypeOf(document) {
  const fileType = (document.fileType || path.extname(document.title).slice(1)).toLowerCase();
  if (!DOCUMENT_TYPES[fileType]) {
    throw new GatewayError(422, 'GW-422-INVALID', 'Invalid editor config request', [`file type ${fileType || '(none)'} is not supported; use ${Object.keys(DOCUMENT_TYPES).join(', ')}`]);
  }
  return fileType;
}

// All users of the same stored file must share the key; any change of the stored file must change it.
function documentKey({id, versionNo, revision}) {
  return 'qms_' + crypto.createHash('sha256').update(`${id}\n${versionNo}\n${revision}`).digest('hex');
}

function buildEditorConfig(request, settings) {
  const {document, user, access} = validate(request);
  const fileType = fileTypeOf(document);
  const policy = resolvePolicy({...access, fileType});
  if (policy.editorMode === 'edit' && !document.callbackUrl) {
    throw new GatewayError(422, 'GW-422-INVALID', 'Invalid editor config request', ['document.callbackUrl is required when the user can change the document']);
  }

  // There is no Kazakh interface translation: Russian UI with Kazakh regional settings.
  const kazakh = user.lang === 'kk';
  const editorUser = {id: user.id, name: user.name};
  if (policy.stamp) editorUser.group = policy.stamp;

  const config = {
    documentType: DOCUMENT_TYPES[fileType],
    document: {
      fileType,
      key: documentKey(document),
      title: document.title,
      url: document.url,
      permissions: policy.permissions
    },
    editorConfig: {
      mode: policy.editorMode,
      lang: 'ru',
      region: kazakh ? 'kk-KZ' : 'ru-RU',
      user: editorUser,
      // Real-time co-editing: others' changes appear as they type; users cannot switch to strict mode.
      coEditing: {mode: 'fast', change: false},
      customization: {...policy.customization, forcesave: true}
    }
  };
  if (document.callbackUrl) config.editorConfig.callbackUrl = document.callbackUrl;
  if (policy.reviewPanel && config.documentType === 'word') {
    // The panel opens with the document; the plugins tab (and its external marketplace) stays hidden.
    const panel = REVIEW_PANELS[policy.reviewPanel];
    config.editorConfig.plugins = {
      pluginsData: [`${settings.publicUrl}/sdkjs-plugins/${panel.plugin}/config.json`],
      autostart: [panel.guid]
    };
    Object.assign(config.editorConfig.customization, {plugins: true, layout: {toolbar: {plugins: false}}});
  }

  return {
    config: {...config, token: jwt.sign(config, settings.jwtSecret, settings.tokenTtlSeconds)},
    policy: {mode: policy.mode, stamp: policy.stamp, readOnly: policy.editorMode === 'view', reviewVisible: policy.reviewVisible, reviewPanel: config.editorConfig.plugins ? policy.reviewPanel : null},
    apiUrl: `${settings.publicUrl}/web-apps/apps/api/documents/api.js`
  };
}

module.exports = {buildEditorConfig, documentKey};
