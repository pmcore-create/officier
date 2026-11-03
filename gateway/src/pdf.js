'use strict';
// PDF of a QMS document for the portal (the version's MAIN_PDF): the print copy without review
// markup (revisions.js) converted by the document server. The approval snapshot is finalize.js.
const {GatewayError} = require('./errors');
const {printCopy} = require('./revisions');
const {sha256} = require('./docx');
const {convertToPdf} = require('./docserver');

// publish(buffer) makes a file reachable for the document server.
async function printPdf(source, settings, {publish}) {
  if (!settings.gatewayInternalUrl) throw new GatewayError(503, 'GW-503-NOT-CONFIGURED', 'GATEWAY_INTERNAL_URL is not set: the document server cannot fetch the print copy');
  const copy = printCopy(source);
  const file = publish(copy.buffer);
  try {
    const pdf = await convertToPdf(settings, {url: file.url, key: `qmspdf_${sha256(copy.buffer).slice(0, 40)}`, title: 'document.docx'});
    return {pdf, accepted: copy.accepted, rejected: copy.rejected};
  } finally {
    file.release();
  }
}

module.exports = {printPdf};
