'use strict';
// Server-to-server calls to the document server: Command API and DOCX -> PDF conversion.
// Requests carry a JWT of their own body in "token", as the document server expects with JWT on.
const {GatewayError} = require('./errors');
const jwt = require('./jwt');

const COMMAND_TIMEOUT_MS = 30000;
const CONVERT_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_TTL_SECONDS = 600;
// Command API codes (DocsCoServer c_oAscServerCommandErrors).
const COMMAND_ERRORS = {0: 'no error', 1: 'document key not found', 2: 'callback url not correct', 3: 'internal server error', 4: 'not modified', 5: 'command not correct', 6: 'invalid token'};

async function post(settings, path, body, timeoutMs) {
  const signed = {...body, token: jwt.sign(body, settings.jwtSecret, TOKEN_TTL_SECONDS)};
  let response;
  try {
    response = await fetch(settings.officierInternalUrl + path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new GatewayError(502, 'GW-502-DOCSERVER', `Document server is unreachable: ${err.message}`);
  }
  if (!response.ok) throw new GatewayError(502, 'GW-502-DOCSERVER', `Document server answered HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new GatewayError(502, 'GW-502-DOCSERVER', 'Document server answered with a non-JSON body');
  }
}

async function command(settings, body) {
  const result = await post(settings, '/command', body, COMMAND_TIMEOUT_MS);
  if (result.error === 6) throw new GatewayError(502, 'GW-502-DOCSERVER', 'Document server rejected the gateway token: JWT secrets differ');
  return result;
}

// Synchronous conversion; the document server answers when done or after its own wait, then we ask again.
async function convertToPdf(settings, {url, key, title}) {
  const body = {async: false, filetype: 'docx', outputtype: 'pdf', key, title, url};
  const deadline = Date.now() + CONVERT_TIMEOUT_MS;
  for (;;) {
    const result = await post(settings, '/converter', body, Math.max(1000, deadline - Date.now()));
    if (result.error) throw new GatewayError(502, 'GW-502-PDF', `PDF conversion failed with document server error ${result.error}`);
    if (result.endConvert && result.fileUrl) return download(result.fileUrl);
    if (Date.now() >= deadline) throw new GatewayError(504, 'GW-502-PDF', 'PDF conversion did not finish in time');
  }
}

async function download(url) {
  let response;
  try {
    response = await fetch(url, {signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS)});
  } catch (err) {
    throw new GatewayError(502, 'GW-502-PDF', `Cannot download the converted PDF: ${err.message}`);
  }
  if (!response.ok) throw new GatewayError(502, 'GW-502-PDF', `Converted PDF download failed with HTTP ${response.status}`);
  const pdf = Buffer.from(await response.arrayBuffer());
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new GatewayError(502, 'GW-502-PDF', 'Document server returned something other than a PDF');
  return pdf;
}

module.exports = {command, convertToPdf, COMMAND_ERRORS};
