#!/usr/bin/env node
/*
 * Locks a samples export with a password, so the file can be kept somewhere that is not private. Nothing is uploaded: this
 * only writes a file next to your own.
 *
 *   SEAL_PASSWORD='a long password' node scripts/seal-samples.js my-handwriting.json handwriting.enc.json
 *
 * The MCP server opens it with --samples handwriting.enc.json (or --samples-url <address>) and --password / HANDWRITING_PASSWORD.
 * Passwords under 12 characters are refused (ALLOW_SHORT_PASSWORD=1 to override): a public sealed file can be guessed at offline.
 */
'use strict';
const fs = require('fs');
const { seal, unseal } = require('../mcp/sealed');

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: SEAL_PASSWORD=... node scripts/seal-samples.js <my-handwriting.json> <out.enc.json>');
  process.exit(2);
}
try {
  const plain = fs.readFileSync(input);
  const sealed = seal(plain, process.env.SEAL_PASSWORD, { allowShort: process.env.ALLOW_SHORT_PASSWORD === '1' });
  if (!unseal(Buffer.from(sealed), process.env.SEAL_PASSWORD).equals(plain)) throw new Error('the sealed file did not open back to the original, so it was not written');
  fs.writeFileSync(output, sealed, { mode: 0o600 });
  console.log(`Wrote ${output} (${(sealed.length / 1024).toFixed(0)} KB)`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
