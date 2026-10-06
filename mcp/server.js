#!/usr/bin/env node
/*
 * An MCP server (Model Context Protocol, over stdio) so an AI assistant can write in the user's handwriting and fill
 * worksheets for them. It runs the same engine as the web app, here in Node, from the file the Teach tab's Export button
 * saves. The handwriting file is read from disk and never sent anywhere; only the pictures and text the tools return
 * go back to the assistant.
 *
 *   node mcp/server.js --samples /path/to/my-handwriting.json [--out /folder/for/results]
 *   node mcp/server.js --samples ... --http 8787 --token <secret>      (a web address instead of stdin/stdout)
 *
 * --format svg (or HANDWRITING_FORMAT=svg) makes write_text return SVG markup instead of a PNG unless a call asks otherwise.
 *
 * Samples can also be the sealed file the site publishes: --samples-url <address> (or --samples with a downloaded copy)
 * and --password <password> (or HANDWRITING_PASSWORD, which keeps it out of the process list).
 *
 * The built handwriting is cached in a .handwriting-cache folder next to the samples file (--cache DIR to move it,
 * --no-cache to turn it off), so starting the server again for each call is fast after the first time.
 *
 * (or HANDWRITING_FILE and HANDWRITING_OUT in the environment). No dependencies: the protocol is a few lines of JSON-RPC.
 */
'use strict';
const { createTools } = require('./tools');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Returns handle(message) -> response object, or null for a notification. */
function createServer(config) {
  const tools = createTools(config);
  return async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // notifications (initialized, cancelled) need no answer
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOLS.includes(params && params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'handwriting', version: '1.0.0' },
          instructions: "Writes in the user's own handwriting. Use inspect_pdf to see where things are on a worksheet, write_text to preview an answer, and fill_pdf to put answers on the PDF. Only write what the user asked you to write.",
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.list() });
      case 'tools/call':
        try {
          return reply({ content: await tools.call(params && params.name, params && params.arguments) });
        } catch (e) {
          if (/^Unknown tool/.test(e.message)) return fail(-32602, e.message);
          return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
        }
      default:
        return fail(-32601, 'Method not found: ' + method);
    }
  };
}

const fs = require('fs');
const path = require('path');

/** The handwriting file: --samples, then HANDWRITING_FILE, then my-handwriting.json in the current folder or next to this script. */
function findSamples(argv) {
  const given = argValue(argv, '--samples') || process.env.HANDWRITING_FILE;
  if (given) return given;
  return [path.resolve('my-handwriting.json'), path.join(__dirname, 'my-handwriting.json')].find((p) => fs.existsSync(p));
}

function serveStdio(handle) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      handle(msg).then(
        (res) => res && process.stdout.write(JSON.stringify(res) + '\n'),
        (e) => msg.id !== undefined && process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }) + '\n')
      );
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

/**
 * MCP over HTTP (the "streamable HTTP" transport, JSON replies only): POST /mcp with a JSON-RPC message. Needs a bearer
 * token, because anyone who can reach the port could otherwise write in the user's hand. Listens on this computer only
 * unless --host says otherwise; to use it from elsewhere, put a tunnel or a reverse proxy with HTTPS in front.
 */
function serveHttp(handle, port, host, token) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    if (req.url.split('?')[0] !== '/mcp') return send(404, { error: 'not found' });
    if (req.headers.authorization !== 'Bearer ' + token) return send(401, { error: 'missing or wrong token' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20e6) req.destroy();
    });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(msg);
      const replies = (await Promise.all((batch ? msg : [msg]).map((m) => handle(m).catch((e) => ({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }))))).filter(Boolean);
      if (!replies.length) return send(202);
      send(200, batch ? replies : replies[0]);
    });
  });
  server.listen(port, host, () => console.error(`Handwriting MCP server on http://${host}:${server.address().port}/mcp (send the header "Authorization: Bearer <token>")`));
  return server;
}

function main() {
  // stdout carries the protocol; anything a library prints must go to stderr
  console.log = console.info = console.warn = (...a) => console.error(...a);
  const argv = process.argv.slice(2);
  const handle = createServer({
    samples: findSamples(argv),
    // the sealed file on the site: given, or the address this copy of the server was published with (see build-site-extras.js)
    samplesUrl: argValue(argv, '--samples-url') || process.env.HANDWRITING_URL || globalThis.__HW_DEFAULT_SAMPLES_URL__,
    format: argValue(argv, '--format') || process.env.HANDWRITING_FORMAT, // png (default), svg or both: what write_text returns unless asked
    password: argValue(argv, '--password') || process.env.HANDWRITING_PASSWORD,
    out: argValue(argv, '--out') || process.env.HANDWRITING_OUT,
    cache: argv.includes('--no-cache') ? false : argValue(argv, '--cache') || process.env.HANDWRITING_CACHE,
  });
  const port = argValue(argv, '--http');
  if (port === undefined) return serveStdio(handle);
  const token = argValue(argv, '--token') || process.env.HANDWRITING_TOKEN;
  if (!token || token.length < 16) {
    console.error('--http needs a secret of at least 16 characters: --token <secret> (or HANDWRITING_TOKEN). For example: ' + require('crypto').randomBytes(18).toString('base64url'));
    process.exit(2);
  }
  serveHttp(handle, Number(port), argValue(argv, '--host') || '127.0.0.1', token);
}

if (require.main === module) main();
module.exports = { createServer, PROTOCOLS, serveHttp };
