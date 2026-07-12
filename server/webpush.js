// Web Push (RFC 8291 message encryption + RFC 8188 aes128gcm + VAPID/RFC 8292).
// Zero dependencies — Node's crypto has every primitive. Lets the server send a
// notification to a locked phone when a show is leaving a platform.

'use strict';
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const b64uDec = (s) => Buffer.from(s, 'base64url');
const b64uEnc = (b) => Buffer.from(b).toString('base64url');

// ---- key encoding: raw uncompressed EC point (0x04|X|Y) <-> KeyObject via JWK ----

function jwkFromRaw(rawPub, rawPriv) {
  const jwk = { kty: 'EC', crv: 'P-256', x: b64uEnc(rawPub.subarray(1, 33)), y: b64uEnc(rawPub.subarray(33, 65)) };
  if (rawPriv) jwk.d = b64uEnc(rawPriv);
  return jwk;
}

// ---- VAPID application-server keypair (persisted) ----

function loadOrCreateVapid(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* create below */ }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: b64uEnc(ecdh.getPublicKey()), privateKey: b64uEnc(ecdh.getPrivateKey()) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys));
  return keys;
}

// ---- VAPID JWT (ES256, signature must be raw R||S, not DER) ----

function vapidHeaders(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64uEnc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64uEnc(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || 'mailto:showtrack@example.com',
  }));
  const signingInput = `${header}.${payload}`;
  const privKey = crypto.createPrivateKey({
    key: jwkFromRaw(b64uDec(vapid.publicKey), b64uDec(vapid.privateKey)), format: 'jwk',
  });
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key: privKey, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${b64uEnc(sig)}`;
  return { Authorization: `vapid t=${jwt}, k=${vapid.publicKey}` };
}

// ---- RFC 8291 payload encryption (aes128gcm) ----

function encryptPayload(uaPublicRaw, authSecret, plaintext, opts = {}) {
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();                 // 65-byte uncompressed
  const shared = ecdh.computeSecret(uaPublicRaw);       // ECDH shared secret

  const salt = opts.salt || crypto.randomBytes(16);
  // key_info = "WebPush: info" \0 ua_public as_public  (recipient key BEFORE sender key)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublicRaw, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]); // single, last-record delimiter
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  const rs = opts.rs || 4096;
  const rsBuf = Buffer.alloc(4); rsBuf.writeUInt32BE(rs);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body, tag]);
}

// decrypt: only used by the local self-test (a real UA does this)
function decryptPayload(fullBody, uaPublicRaw, uaPrivateRaw, authSecret) {
  const salt = fullBody.subarray(0, 16);
  const idlen = fullBody[20];
  const asPublic = fullBody.subarray(21, 21 + idlen);
  const ct = fullBody.subarray(21 + idlen);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateRaw);
  const shared = ecdh.computeSecret(asPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublicRaw, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(data), d.final()]);
  return out.subarray(0, out.length - 1).toString(); // strip 0x02
}

// ---- send one notification; resolves { status } ----

function sendNotification(subscription, payloadStr, vapid, subject) {
  return new Promise((resolve) => {
    const uaPublic = b64uDec(subscription.keys.p256dh);
    const auth = b64uDec(subscription.keys.auth);
    const body = encryptPayload(uaPublic, auth, payloadStr);
    const url = new URL(subscription.endpoint);
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        TTL: 86400,
        ...vapidHeaders(subscription.endpoint, vapid, subject),
      },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0 }); });
    req.end(body);
  });
}

module.exports = { loadOrCreateVapid, encryptPayload, decryptPayload, sendNotification, jwkFromRaw, b64uEnc, b64uDec };
