'use strict';
// Ends the editing session of a document version: everybody who has it open is disconnected, and the
// document server saves the result through the portal callback (status 2 with changes, 4 without).
// The portal calls it on every status or stage change, so nobody keeps the rights of the previous one.
const {GatewayError} = require('./errors');
const {documentKey} = require('./editorConfig');
const {command, COMMAND_ERRORS} = require('./docserver');

function validate(request) {
  const {document = {}} = request || {};
  const errors = [];
  if (typeof document.id !== 'string' || !document.id.trim()) errors.push('document.id is required');
  if (!Number.isInteger(document.versionNo) || document.versionNo < 1) errors.push('document.versionNo must be a positive integer');
  if (typeof document.revision !== 'string' || !document.revision.trim()) errors.push('document.revision is required');
  if (errors.length) throw new GatewayError(422, 'GW-422-INVALID', 'Invalid close request', errors);
  return document;
}

async function closeSessions(request, settings) {
  const key = documentKey(validate(request));
  // "info" tells whether the document server knows the key; it also re-sends the current status
  // (1 = being edited, 4 = closed without changes) to the portal callback.
  const info = await command(settings, {c: 'info', key, userdata: 'qms-close'});
  if (info.error === 1) return {key, session: 'none', users: []};
  if (info.error) throw new GatewayError(502, 'GW-502-DOCSERVER', `Command info failed: ${COMMAND_ERRORS[info.error] || info.error}`);
  const drop = await command(settings, {c: 'drop', key});
  if (drop.error) throw new GatewayError(502, 'GW-502-DOCSERVER', `Command drop failed: ${COMMAND_ERRORS[drop.error] || drop.error}`);
  return {key, session: 'closing', users: info.users || []};
}

module.exports = {closeSessions};
