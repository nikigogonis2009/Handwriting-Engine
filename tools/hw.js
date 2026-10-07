#!/usr/bin/env node
/*
 * Calls one tool of the handwriting MCP server from the command line, for an assistant that can run commands but
 * cannot connect an MCP server (a cloud session, say). Same tools, same arguments, same engine.
 *
 *   node tools/hw.js --samples my-handwriting.json <tool> '<arguments as JSON>'
 *   HANDWRITING_PASSWORD=... node tools/hw.js --samples handwriting.enc.json fill_pdf @answers.json
 *
 * Tools: handwriting_status, write_text, write_batch, inspect_pdf, fill_pdf (see mcp/tools.js). Arguments can be given as
 * @file to read them from a JSON file. Prints the tool's text; a picture it returns is saved as a PNG in the output
 * folder (--out, default handwriting-out) and its path printed. A sealed samples file needs HANDWRITING_PASSWORD in the
 * environment: never pass the password as an argument (it would show in the process list and the shell history).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createServer } = require('../mcp/server');

const USAGE = "usage: node tools/hw.js --samples <my-handwriting.json | handwriting.enc.json> [--out DIR] [--no-cache] <tool> ['<json>' | @file.json]";

function parseArgs(argv) {
  const opts = { samples: process.env.HANDWRITING_FILE, out: process.env.HANDWRITING_OUT };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--samples') opts.samples = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--no-cache') opts.cache = false;
    else if (argv[i] === '--password') throw new Error('Give the password in HANDWRITING_PASSWORD, not as an argument.');
    else rest.push(argv[i]);
  }
  const [tool, json] = rest;
  if (!tool) throw new Error(USAGE);
  let args = {};
  if (json) args = JSON.parse(json.startsWith('@') ? fs.readFileSync(json.slice(1), 'utf8') : json);
  return { opts, tool, args };
}

/** Runs one tool and returns {text, images, isError}: the text blocks joined, and the paths of the saved pictures. */
async function run(opts, tool, args) {
  const out = path.resolve(opts.out || 'handwriting-out');
  const handle = createServer({ samples: opts.samples, out, password: process.env.HANDWRITING_PASSWORD, cache: opts.cache });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  if (r.error) return { text: r.error.message, images: [], isError: true };
  const texts = [];
  const images = [];
  r.result.content.forEach((c, i) => {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image') {
      fs.mkdirSync(out, { recursive: true });
      const file = path.join(out, `${tool}-${Date.now()}-${i}.png`);
      fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      images.push(file);
    }
  });
  return { text: texts.join('\n'), images, isError: !!r.result.isError };
}

async function main() {
  // the engine's libraries may print; keep stdout for the answer only
  const say = console.log;
  console.log = console.info = console.warn = (...a) => console.error(...a);
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const res = await run(parsed.opts, parsed.tool, parsed.args);
  if (res.text) say(res.text);
  for (const f of res.images) say('Picture: ' + f);
  process.exit(res.isError ? 1 : 0);
}

if (require.main === module) main();
module.exports = { run, parseArgs };
