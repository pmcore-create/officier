'use strict';
// Approval snapshot (QMS logic, section 6.1): from the final DOCX of the editor, after the portal has
// closed the editing session, build the frozen source and the PDF the signer signs, with SHA-256 of both.
const {GatewayError} = require('./errors');
const {extractReview} = require('./review');
const {prepareApproval, sha256} = require('./docx');
const {convertToPdf} = require('./docserver');

const SUGGESTIONS_IN_DETAILS = 20;

const text = value => typeof value === 'string' && value.trim() !== '';

function httpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validate(request) {
  const {document = {}, approvals, options = {}} = request || {};
  const errors = [];
  const sources = ['url', 'base64'].filter(field => document[field] !== undefined);
  if (sources.length !== 1) errors.push('document needs exactly one of url (the stored final DOCX) or base64');
  if (document.url !== undefined && !httpUrl(document.url)) errors.push('document.url must be an http(s) URL');
  if (document.base64 !== undefined && (!text(document.base64) || !/^[A-Za-z0-9+/=\s]+$/.test(document.base64))) errors.push('document.base64 must be base64');
  if (!text(document.code)) errors.push('document.code is required (the reserved document code)');
  if (!text(document.name)) errors.push('document.name is required');
  if (!Number.isInteger(document.versionNo) || document.versionNo < 1) errors.push('document.versionNo must be a positive integer');
  if (!Array.isArray(approvals) || approvals.length === 0) {
    errors.push('approvals must list the route decisions for the approval sheet');
  } else {
    approvals.forEach((item, index) => {
      if (!item || !text(item.name)) errors.push(`approvals[${index}].name is required`);
      if (!item || !text(item.decision)) errors.push(`approvals[${index}].decision is required`);
      if (!item || !text(item.date) || Number.isNaN(Date.parse(item.date))) errors.push(`approvals[${index}].date must be an ISO date`);
      for (const field of ['position', 'stage', 'comment']) {
        if (item && item[field] !== undefined && typeof item[field] !== 'string') errors.push(`approvals[${index}].${field} must be a string`);
      }
    });
  }
  for (const field of ['keepComments', 'keepLocks']) {
    if (options[field] !== undefined && typeof options[field] !== 'boolean') errors.push(`options.${field} must be true or false`);
  }
  if (errors.length) throw new GatewayError(422, 'GW-422-INVALID', 'Invalid finalize request', errors);
  return {document, approvals, options};
}

const describe = buffer => ({sha256: sha256(buffer), size: buffer.length, base64: buffer.toString('base64')});

// download(url) fetches the source; publish(buffer) makes a file reachable for the document server.
async function finalize(request, settings, {download, publish}) {
  if (!settings.gatewayInternalUrl) throw new GatewayError(503, 'GW-503-NOT-CONFIGURED', 'GATEWAY_INTERNAL_URL is not set: the document server cannot fetch the print copy');
  const {document, approvals, options} = validate(request);
  const original = document.url ? await download(document.url) : Buffer.from(document.base64, 'base64');

  // Section 5.8: no suggestion may stay undecided when the document goes to the signer.
  const review = extractReview(original);
  if (review.summary.openSuggestions > 0) {
    throw new GatewayError(409, 'GW-409-OPEN-SUGGESTIONS', `${review.summary.openSuggestions} tracked changes have no decision`, {
      openSuggestions: review.summary.openSuggestions,
      suggestions: review.suggestions.slice(0, SUGGESTIONS_IN_DETAILS).map(item => ({id: item.id, type: item.type, author: item.author.name, stamp: item.author.stamp, textBefore: item.textBefore, textAfter: item.textAfter}))
    });
  }

  const {source, print, removed} = prepareApproval(original, {
    keepComments: options.keepComments,
    keepLocks: options.keepLocks,
    sheet: {code: document.code.trim(), name: document.name.trim(), versionNo: document.versionNo, approvals, timeZone: settings.timeZone}
  });
  const file = publish(print);
  let pdf;
  try {
    pdf = await convertToPdf(settings, {url: file.url, key: `qmsfin_${sha256(print).slice(0, 40)}`, title: `${document.code.trim()}.docx`});
  } finally {
    file.release();
  }
  return {source: describe(source), pdf: describe(pdf), removed, review};
}

module.exports = {finalize};
