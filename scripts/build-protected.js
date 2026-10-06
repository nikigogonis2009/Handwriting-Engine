#!/usr/bin/env node
/*
 * Builds the password-protected site for GitHub Pages.
 *
 * Pages has no server, so the app is encrypted (PBKDF2-SHA256 + AES-256-GCM) and the login page
 * decrypts it in the browser. Only the login page and the ciphertext get published.
 *
 *   SITE_PASSWORD='...' node scripts/build-protected.js [outDir]
 *
 * The encrypted file is public, so a weak password can be cracked offline. Passwords under 12
 * characters are refused unless ALLOW_SHORT_PASSWORD=1 is set.
 */
'use strict';
const fs = require('fs');
const { packScript, PROFILES } = require('./pack');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ITERATIONS = 600000;
const MIN_LENGTH = 12;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** index.html with its stylesheet and scripts inlined, so it is one self-contained document. */
function inlineApp(opts) {
  const kind = (opts && opts.kind) || 'full'; // 'ai' is the small part of the site (see PROFILES in pack.js)
  let html = read('index.html');
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}\n</style>`);
  // Big libraries (vendor/) go in as plain text and only run when the app asks for them (loadLib in src/sheetui.js), so
  // they cost nothing at start-up. In a plain checkout loadLib fetches the same files by name instead.
  const libs = fs.readdirSync(path.join(ROOT, 'vendor')).filter((f) => f.endsWith('.js')).sort();
  const table = libs.map((f) => `${JSON.stringify('vendor/' + f)}: ${JSON.stringify(read('vendor/' + f)).replace(/<\//g, '<\\/')}`);
  // The Download button's package (project files, the servers, the guide): deflated here, put into a .zip by src/download.js
  // (it goes just before download.js, which looks for it when it starts)
  const pack = opts && opts.pack === false ? '' : `<script>${packScript(kind)}</script>\n`;
  html = html.replace('</body>', () => `<script>window.HW_LIBS = {${table.join(',\n')}};</script>\n</body>`);
  html = html.replace('<script src="src/download.js"></script>', () => `${pack}<script src="src/download.js"></script>`);
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => `<script>\n${read(src).replace(/<\/script/gi, '<\\/script')}\n</script>`);
  if (/<(link|script)[^>]+(href|src)="[^"]+"/.test(html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, ''))) {
    throw new Error('index.html still references an external file after inlining');
  }
  return html;
}

const pbkdf2 = (password, salt, iter) => crypto.pbkdf2Sync(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, iter, 32, 'sha256');

/** AES-256-GCM, WebCrypto style: the tag goes on the end of the ciphertext. Returns {iv, data} as base64. */
function gcm(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), data: Buffer.concat([ct, cipher.getAuthTag()]).toString('base64') };
}

/** The page's contents, locked once with a random key. Several passwords can then each unlock that one key (wrap). */
function sealBlob(plaintext) {
  const key = crypto.randomBytes(32);
  return { key, blob: gcm(key, Buffer.from(plaintext, 'utf8')) };
}

/** A password's way to the blob's key: PBKDF2(password) locks the key. */
function wrap(key, password) {
  const salt = crypto.randomBytes(16);
  const locked = gcm(pbkdf2(password, salt, ITERATIONS), key);
  return {
    id: salt.toString('base64').slice(0, 8), // lets a browser tell "remembered key is for an older password"
    iter: ITERATIONS,
    salt: salt.toString('base64'),
    wrapIv: locked.iv,
    wrapped: locked.data,
  };
}

/** What the page calls a part: a stable, meaningless id (it names the part's data in the browser), so a name is never in the page. */
const partId = (name) => crypto.createHash('sha256').update('hw-part:' + name).digest('hex').slice(0, 6);

function checkPassword(password, what, allowShort) {
  if (!password) throw new Error(`Set ${what}.`);
  if (password.length < MIN_LENGTH && !allowShort) {
    throw new Error(`${what} is under ${MIN_LENGTH} characters. The encrypted file is public, so a short password can be cracked offline. Set ALLOW_SHORT_PASSWORD=1 to use it anyway.`);
  }
  if (password.length < MIN_LENGTH) console.warn(`Warning: ${what} is under ${MIN_LENGTH} characters, so it could be cracked offline.`);
}

/**
 * Returns the protected page as a string. Throws on a missing or short password.
 * opts.extra: [{password, profile}], more passwords, each opening its own part of the site (see PROFILES in pack.js). They
 * share the main app's locked contents when their package is the same, so the page does not grow with each one.
 */
function buildProtected(password, opts) {
  const allowShort = !!(opts && opts.allowShort);
  checkPassword(password, 'SITE_PASSWORD', allowShort);
  const parts = [{ password, profile: null, kind: 'full' }];
  const seen = new Set([password]);
  for (const e of (opts && opts.extra) || []) {
    if (!PROFILES[e.profile]) throw new Error('Unknown part of the site: ' + e.profile);
    checkPassword(e.password, e.profile.toUpperCase() + '_PASSWORD', allowShort);
    if (seen.has(e.password)) throw new Error('Two parts of the site cannot share a password.');
    seen.add(e.password);
    parts.push({ password: e.password, profile: e.profile, kind: PROFILES[e.profile].kind });
  }
  const blobs = []; // one per package kind: [{kind, key, blob}]
  for (const kind of new Set(parts.map((p) => p.kind))) blobs.push(Object.assign({ kind }, sealBlob(inlineApp({ kind }))));
  const slots = parts.map((p) => Object.assign(wrap(blobs.find((b) => b.kind === p.kind).key, p.password), { blob: blobs.findIndex((b) => b.kind === p.kind), profile: p.profile && partId(p.profile), kind: p.kind }));
  const page = read('scripts/login.template.html').replace('__BLOBS__', () => JSON.stringify(blobs.map((b) => b.blob))).replace('__SLOTS__', () => JSON.stringify(slots));
  for (const pw of seen) if (page.includes(pw)) throw new Error('refusing to write a page that contains a password');
  return page;
}

if (require.main === module) {
  try {
    const out = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
    // other people's parts of the site, each with its own password from the environment: NIKO_PASSWORD, SEBA_PASSWORD
    const extra = Object.keys(PROFILES).filter((name) => process.env[name.toUpperCase() + '_PASSWORD']).map((name) => ({ password: process.env[name.toUpperCase() + '_PASSWORD'], profile: name }));
    const page = buildProtected(process.env.SITE_PASSWORD, { allowShort: process.env.ALLOW_SHORT_PASSWORD === '1', extra });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'index.html'), page);
    fs.writeFileSync(path.join(out, '.nojekyll'), '');
    console.log(`Wrote ${path.join(out, 'index.html')} (${(page.length / 1024).toFixed(0)} KB, encrypted)`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { buildProtected, inlineApp, partId, ITERATIONS, MIN_LENGTH };
