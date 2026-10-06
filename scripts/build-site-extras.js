#!/usr/bin/env node
/*
 * The plain files published next to the protected page, so an AI assistant can fetch the MCP server (and, locked with the
 * password, the handwriting) by address instead of the user uploading them each time:
 *
 *   handwriting-mcp.js        the server, one file, no dependencies          (+ .sha256)
 *   handwriting-mcp-pdf.js    the same with inspect_pdf and fill_pdf          (+ .sha256)
 *   handwriting.enc.json      the user's samples, sealed with the password (only when there is one to publish)
 *   handwriting-engine.zip    everything for someone starting from scratch: the project, both servers, the guide (+ .sha256)
 *   mcp.txt                   how to fetch and run it all, in plain text
 *
 * The program files hold none of the user's handwriting. The samples are only ever published sealed (mcp/sealed.js).
 * When a sealed file is there, the published servers know its address, so they need only the password.
 *
 *   SITE_PASSWORD=... HANDWRITING_FILE=my-handwriting.json node scripts/build-site-extras.js <outDir> [site address]
 *
 * Without HANDWRITING_FILE, a handwriting.enc.json already in <outDir> is kept and used.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { build } = require('./build-mcp');
const { seal, unseal } = require('../mcp/sealed');
const { buildZip } = require('./pack');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ENC = 'handwriting.enc.json';

function instructions(base, hashes, hasSamples) {
  const url = (f) => (base ? base.replace(/\/?$/, '/') + f : f);
  const run = hasSamples
    ? `Run it (speaks MCP over stdin/stdout). The owner's handwriting is published on the site, locked with a password, and this copy
already knows where it is, so all it needs is the password, which the owner gives you:
  HANDWRITING_PASSWORD='<the password>' node handwriting-mcp.js
  (put the password in the environment, not on the command line, so it stays out of process lists and logs)
If this computer cannot reach the site from Node (a proxy), download the sealed file with curl and point at it:
  curl -fsSLO ${url(ENC)}
  HANDWRITING_PASSWORD='<the password>' node handwriting-mcp.js --samples handwriting.enc.json
If the owner gives you an unlocked my-handwriting.json instead:  node handwriting-mcp.js --samples my-handwriting.json`
    : `Run it (speaks MCP over stdin/stdout). It needs the owner's samples file:
  node handwriting-mcp.js --samples /path/to/my-handwriting.json
  (without --samples it looks for my-handwriting.json in the current folder, then next to the file)`;
  return `Handwriting MCP server
======================

Writes text or math in the owner's own handwriting and returns it as a PNG or an SVG. One file of plain Node.js (18 or newer),
no npm packages. The program contains no handwriting. ${hasSamples ? "The handwriting is in a separate sealed file on this site (AES-256, password needed) or in the owner's own unlocked export." : 'The handwriting is in a separate file the owner exports from the Teach tab of the app.'}
It is read into memory and never sent anywhere.

Everything, for someone starting from scratch (no password): the whole project, both servers and a setup guide.
Give this to an AI assistant and tell it to read START-HERE.txt inside:
  curl -fsSLO ${url('handwriting-engine.zip')}
  sha256sum handwriting-engine.zip     # should be ${hashes['handwriting-engine.zip']}
  unzip handwriting-engine.zip

Just the server
  curl -fsSLO ${url('handwriting-mcp.js')}
  sha256sum handwriting-mcp.js     # should be ${hashes['handwriting-mcp.js']}

A version that can also read and fill PDFs (2 MB) is ${url('handwriting-mcp-pdf.js')}
  sha256 ${hashes['handwriting-mcp-pdf.js']}

${run}

As a web address instead of a program (add to the command above)
  --http 8787 --token <a secret of 16+ characters>
  then POST http://127.0.0.1:8787/mcp with the header  Authorization: Bearer <token>

Tools
  handwriting_status   is the handwriting loaded, which characters have no sample
  write_text           {text, kind: "text"|"math", width_pt, letter_height_pt, ink, seed, format, include_base64}
                       format "png" (default): a PNG as MCP image content (include_base64 also gives it as text)
                       format "svg": the SVG markup itself as text, transparent, sized in points
                       format "both": both. Start with --format svg to make SVG the default.
  write_batch          {items: [{text, kind, seed, ...}], format, return_images}   many at once, handwriting loaded once
  inspect_pdf, fill_pdf   (PDF version only) find where answers go on a PDF, and write them in

Math input: x^2, \\frac{a}{b}, \\sqrt{x} or sqrt(x), \\sqrt[3]{x} or cubert(x), \\int_0^1, \\sum_{i=1}^{n},
\\text{ words }, and "\\ " for a space that stays (plain spaces are ignored, as in TeX). Digits are the weakest part:
check numbers by looking at the picture. Write only what the owner asked for.

The first call after a fresh start builds the handwriting (about 7 seconds) and caches it in a .handwriting-cache
folder (next to the samples file, or in the current folder when it came from the site), so later starts take under
half a second. That cache holds the handwriting unlocked, so keep it private and do not commit it.
`;
}

function buildExtras(outDir, base, opts) {
  const o = opts || {};
  fs.mkdirSync(outDir, { recursive: true });
  if (o.sealFrom) {
    const plain = fs.readFileSync(o.sealFrom);
    const sealed = seal(plain, o.password, { allowShort: o.allowShort });
    if (!unseal(Buffer.from(sealed), o.password).equals(plain)) throw new Error('the sealed file did not open back to the original, so it was not written'); // prove it opens before publishing it
    fs.writeFileSync(path.join(outDir, ENC), sealed);
  }
  const hasSamples = fs.existsSync(path.join(outDir, ENC));
  const samplesUrl = hasSamples && base ? base.replace(/\/?$/, '/') + ENC : undefined;
  const hashes = {};
  for (const [name, pdf] of [['handwriting-mcp.js', false], ['handwriting-mcp-pdf.js', true]]) {
    const code = build({ pdf, samplesUrl });
    hashes[name] = sha(code);
    fs.writeFileSync(path.join(outDir, name), code);
    fs.writeFileSync(path.join(outDir, name + '.sha256'), `${hashes[name]}  ${name}\n`);
  }
  const zip = buildZip();
  hashes['handwriting-engine.zip'] = sha(zip);
  fs.writeFileSync(path.join(outDir, 'handwriting-engine.zip'), zip);
  fs.writeFileSync(path.join(outDir, 'handwriting-engine.zip.sha256'), `${hashes['handwriting-engine.zip']}  handwriting-engine.zip\n`);
  fs.writeFileSync(path.join(outDir, 'mcp.txt'), instructions(base, hashes, hasSamples));
  return hashes;
}

if (require.main === module) {
  const [, , out, base] = process.argv;
  if (!out) {
    console.error('usage: node scripts/build-site-extras.js <outDir> [site address]');
    process.exit(2);
  }
  try {
    const h = buildExtras(path.resolve(out), base, { sealFrom: process.env.HANDWRITING_FILE, password: process.env.SITE_PASSWORD, allowShort: process.env.ALLOW_SHORT_PASSWORD === '1' });
    console.log('Wrote ' + Object.keys(h).join(', ') + ', mcp.txt' + (fs.existsSync(path.join(out, ENC)) ? ', ' + ENC : ''));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { buildExtras, ENC };
