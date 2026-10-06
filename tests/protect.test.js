'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildProtected, inlineApp, partId } = require('../scripts/build-protected');

const PASSWORD = 'unit-test-password-12345';

/** The blobs and slots in the published page. */
function partsOf(page) {
  const b = page.match(/var B = (\[.*?\]);\s+\/\//s);
  const sl = page.match(/var S = (\[.*?\]);\s+\/\//s);
  assert.ok(b && sl, 'payload present');
  return { blobs: JSON.parse(b[1]), slots: JSON.parse(sl[1]) };
}

const gcmOpen = (key, iv, data) => {
  data = Buffer.from(data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
};

/** Open the way the browser does: PBKDF2 unlocks the blob's key (AES-GCM over key||tag), the key unlocks the page. Throws on a wrong password. */
function decryptSlot(parts, slot, password) {
  const key = crypto.pbkdf2Sync(Buffer.from(password.normalize('NFKC'), 'utf8'), Buffer.from(slot.salt, 'base64'), slot.iter, 32, 'sha256');
  const blobKey = gcmOpen(key, slot.wrapIv, slot.wrapped);
  const blob = parts.blobs[slot.blob];
  return gcmOpen(blobKey, blob.iv, blob.data).toString('utf8');
}
/** The main part's page, for the password given. */
const decrypt = (page, password) => {
  const parts = partsOf(page);
  return decryptSlot(parts, parts.slots[0], password);
};

test('the right password decrypts to the complete, self-contained app', () => {
  const page = buildProtected(PASSWORD);
  const html = decrypt(page, PASSWORD);
  assert.ok(html.includes('id="btnNext"') && html.includes('HW_APP') && html.includes('function mulberry32'));
  assert.ok(!/<script src=|<link rel="stylesheet"/.test(html), 'everything is inlined');
  assert.equal(html, inlineApp());
});

test('a wrong password cannot decrypt', () => {
  const page = buildProtected(PASSWORD);
  assert.throws(() => decrypt(page, PASSWORD + 'x'));
});

test('the published page reveals nothing about the app or the password', () => {
  const page = buildProtected(PASSWORD);
  for (const secret of [PASSWORD, 'btnNext', 'HW_APP', 'mulberry32', 'alignWord', 'liquor jugs', 'Pack my box']) {
    assert.ok(!page.includes(secret), 'page leaks: ' + secret);
  }
  assert.match(page, /noindex/);
});

test('every build uses a fresh salt, iv and key', () => {
  const a = partsOf(buildProtected(PASSWORD));
  const b = partsOf(buildProtected(PASSWORD));
  assert.notEqual(a.slots[0].salt, b.slots[0].salt);
  assert.notEqual(a.slots[0].wrapped, b.slots[0].wrapped);
  assert.notEqual(a.blobs[0].iv, b.blobs[0].iv);
  assert.notEqual(a.blobs[0].data, b.blobs[0].data);
});

test('short or missing passwords are refused unless explicitly allowed', () => {
  assert.throws(() => buildProtected(''), /Set SITE_PASSWORD/);
  assert.throws(() => buildProtected(undefined), /Set SITE_PASSWORD/);
  assert.throws(() => buildProtected('short'), /under 12/);
  const page = buildProtected('short-pw', { allowShort: true });
  assert.equal(decrypt(page, 'short-pw').includes('HW_APP'), true);
});

test('three passwords open three parts of the site, and none opens another', () => {
  const NIKO = 'niko-password-12345';
  const SEBA = 'seba-password-12345';
  const page = buildProtected(PASSWORD, { extra: [{ password: NIKO, profile: 'niko' }, { password: SEBA, profile: 'seba' }] });
  const parts = partsOf(page);
  assert.equal(parts.slots.length, 3);
  assert.equal(new Set(parts.slots.map((q) => q.id)).size, 3, 'told apart by id, for "remember on this device"');
  assert.equal(parts.blobs.length, 2, 'the main and the full part share one locked copy; the small part has its own');
  assert.deepEqual(parts.slots.map((q) => [q.profile, q.kind, q.blob]), [[null, 'full', 0], [partId('niko'), 'full', 0], [partId('seba'), 'ai', 1]]);
  assert.ok(partId('niko') !== partId('seba') && /^[0-9a-f]{6}$/.test(partId('niko')));
  const [main, niko, seba] = parts.slots;
  const mainHtml = decryptSlot(parts, main, PASSWORD);
  assert.equal(decryptSlot(parts, niko, NIKO), mainHtml, 'the same full app');
  const sebaHtml = decryptSlot(parts, seba, SEBA);
  assert.ok(sebaHtml.includes('id="guestNote"') && sebaHtml.includes('HW_APP'));
  assert.notEqual(sebaHtml, mainHtml, 'the small part carries the small package');
  assert.ok(sebaHtml.length < mainHtml.length);
  const all = [[main, PASSWORD], [niko, NIKO], [seba, SEBA]];
  for (const [i, [slot]] of all.entries()) for (const [j, [, pw]] of all.entries()) if (i !== j) assert.throws(() => decryptSlot(parts, slot, pw), `password ${j} must not open part ${i}`);
  for (const secret of [PASSWORD, NIKO, SEBA, 'btnNext']) assert.ok(!page.includes(secret), 'page leaks: ' + secret);
  // the people's names are not in the page either (checked outside the base64, where four letters can match by chance)
  const meta = page.replace(/"(data|wrapped|iv|wrapIv|salt)":"[^"]*"/g, '');
  for (const name of ['niko', 'seba']) assert.ok(!meta.toLowerCase().includes(name), 'page names ' + name);
  assert.ok(page.length < 1.2 * buildProtected(PASSWORD).length + 6e6, 'a part that shares the full app adds almost nothing');
  // the button of the small part gives the small zip, with no project source
  const { buildPack } = require('../scripts/pack');
  assert.deepEqual(buildPack([], 'ai').map((e) => e.name), ['handwriting-for-ai/FOR-THE-AI.txt', 'handwriting-for-ai/docs/handwriting-engine-guide.pdf', 'handwriting-for-ai/handwriting-mcp-pdf.js', 'handwriting-for-ai/handwriting-mcp.js']);
  assert.ok(buildPack([], 'full').some((e) => e.name === 'handwriting-engine/src/synth.js'), 'a full part gets the full package');
  assert.throws(() => buildProtected(PASSWORD, { extra: [{ password: PASSWORD, profile: 'niko' }] }), /cannot share a password/);
  assert.throws(() => buildProtected(PASSWORD, { extra: [{ password: NIKO, profile: 'niko' }, { password: NIKO, profile: 'seba' }] }), /cannot share a password/);
  assert.throws(() => buildProtected(PASSWORD, { extra: [{ password: 'short', profile: 'seba' }] }), /SEBA_PASSWORD is under 12/);
  assert.throws(() => buildProtected(PASSWORD, { extra: [{ password: NIKO, profile: 'nobody' }] }), /Unknown part/);
});

test('the pack for the Download button holds the project, the servers and the guide, and never samples or secrets', () => {
  const { buildPack, packScript } = require('../scripts/pack');
  const { readZip } = require('./zip-reader');
  const pack = buildPack();
  const names = pack.map((e) => e.name);
  const top = 'handwriting-engine/';
  for (const need of ['README.md', 'CLAUDE.md', 'package.json', 'index.html', 'src/synth.js', 'mcp/server.js', 'handwriting-mcp.js', 'handwriting-mcp-pdf.js', 'docs/handwriting-engine-guide.pdf', 'scripts/build-mcp.js']) assert.ok(names.includes(top + need), need);
  assert.ok(!names.some((n) => /my-handwriting|node_modules|dist\/|\.handwriting-cache|package-lock|\.git\//.test(n)), 'nothing private or generated');
  // every entry inflates back to what its CRC says, and none of them mention a password this project has used
  const zlib = require('zlib');
  const { crc32 } = require('../scripts/pack');
  for (const e of pack) {
    const data = zlib.inflateRawSync(e.deflated);
    assert.equal(data.length, e.size);
    assert.equal(crc32(data), e.crc, e.name);
    // passwords are never kept in the project, so this reads them from the environment when you want the check run:
    //   HW_SECRETS='one,two' npm test
    for (const secret of (process.env.HW_SECRETS || '').split(',').filter(Boolean)) assert.ok(!data.includes(secret), 'a secret is in ' + e.name);
  }
  const script = packScript();
  assert.ok(script.startsWith('window.HW_PACK = ['));
  assert.ok(!script.includes('</script'), 'safe inside a script tag');
  assert.ok(readZip); // the reader is exercised against the real zip in the browser test
});

