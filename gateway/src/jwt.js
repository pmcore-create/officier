'use strict';
// HS256 tokens in the format Document Server expects for signed editor configs.
const crypto = require('crypto');

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(payload, secret, expiresInSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = expiresInSeconds ? {...payload, iat: now, exp: now + expiresInSeconds} : payload;
  const unsigned = `${encode({alg: 'HS256', typ: 'JWT'})}.${encode(body)}`;
  return `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

module.exports = {sign};
