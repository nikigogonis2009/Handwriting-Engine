'use strict';
/*
 * The handwriting samples, locked with a password so the file can sit on a public site. Gzip, then AES-256-GCM with a key
 * from PBKDF2 (the same recipe as the protected page, scripts/build-protected.js). The file is JSON with "kind" first, so
 * isSealed can tell it from a plain samples file without parsing all of it.
 *
 * The password is the only protection: anyone can download the file and try passwords offline, so use a long one.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const ITERATIONS = 600000;
const MIN_LENGTH = 12;

const keyFor = (password, salt, iter) => crypto.pbkdf2Sync(Buffer.from(String(password).normalize('NFKC'), 'utf8'), salt, iter, 32, 'sha256');

function seal(plain, password, opts) {
  if (!password) throw new Error('A password is needed to seal the handwriting.');
  if (String(password).length < MIN_LENGTH && !(opts && opts.allowShort)) throw new Error(`The password is under ${MIN_LENGTH} characters. The sealed file is public, so a short one can be cracked offline.`);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(password, salt, ITERATIONS), iv);
  const ct = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ kind: 'handwriting-samples', v: 1, iter: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), data: ct.toString('base64') });
}

function isSealed(buf) {
  return /^\s*\{\s*"kind"\s*:\s*"handwriting-samples"/.test(Buffer.from(buf).subarray(0, 120).toString('utf8'));
}

function unseal(buf, password) {
  if (!password) throw new Error('The handwriting file is locked. Give the password with --password or the HANDWRITING_PASSWORD environment variable.');
  const o = JSON.parse(Buffer.from(buf).toString('utf8'));
  const data = Buffer.from(o.data, 'base64');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(password, Buffer.from(o.salt, 'base64'), o.iter), Buffer.from(o.iv, 'base64'));
    d.setAuthTag(data.subarray(data.length - 16));
    return zlib.gunzipSync(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]));
  } catch {
    throw new Error('Wrong password for the handwriting file, or the file is damaged.');
  }
}

module.exports = { seal, unseal, isSealed, MIN_LENGTH };
