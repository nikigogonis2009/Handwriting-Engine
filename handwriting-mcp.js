#!/usr/bin/env node
// Handwriting MCP server, one file. Built by scripts/build-mcp.js (without PDF tools). Run: node handwriting-mcp.js --samples my-handwriting.json
'use strict';
globalThis.__HW_NO_PDF__ = true;

const __defs = {
"mcp/server.js": function (module, exports, __req) {
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
const { createTools } = __req("mcp/tools.js");

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

if (__req.main === module) main();
module.exports = { createServer, PROTOCOLS, serveHttp };

},
"mcp/tools.js": function (module, exports, __req) {
'use strict';
/*
 * The tools the MCP server offers. Each one takes the arguments object from the model and returns MCP content:
 * a list of {type: 'text', text} and {type: 'image', data, mimeType}. A thrown Error becomes a tool error the model
 * can read and act on, so messages say what to do next.
 */
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
// Plain relative requires, so scripts/build-mcp.js can fold everything into one file. The PDF parts are required only
// when a PDF tool is used, and a build without PDF support (globalThis.__HW_NO_PDF__) leaves them out altogether.
const S = __req("src/style.js");
const R = __req("src/render.js");
const Sheet = __req("src/sheet.js");
const { renderPng } = __req("mcp/raster.js");
const { isSealed, unseal } = __req("mcp/sealed.js");
const PDF = !globalThis.__HW_NO_PDF__;
const pdfLib = () => __req("vendor/pdf-lib.min.js");
const inspectPdf = (bytes, o) => __req("mcp/pdfinfo.js").inspect(bytes, o);

const LOOK = { messiness: 0.3, variation: 0.4, neatness: 0.5, wordReuse: 0.25, slantDelta: 0, wordSpacing: 1 }; // the Write tab's defaults
const DEFAULT_INK = '#1749b3';

function createTools(config) {
  const source = config.samples || config.samplesUrl; // a path, or an address (the sealed file the site publishes)
  const isUrl = /^https?:\/\//i.test(source || '');
  const REFRESH_MS = 10 * 60 * 1000; // a server that stays up looks for newer samples this often
  const outDir = path.resolve(config.out || 'handwriting-out');
  let cache = null; // {mtime, style, words}

  // Building the style (cutting every recorded word into letters) takes several seconds for a full set of samples, and a
  // client that starts this program for every call would pay that every time. So the built style is kept on disk, next to the
  // samples, keyed by a hash of the samples and of the engine code. It holds the same strokes as the samples file, so it gets
  // the same care: a private folder, and .gitignore skips it.
  const stamp = (() => {
    const own = ['../src/align.js', '../src/style.js', '../src/geometry.js'].map((f) => path.join(__dirname, f));
    const files = own.every((f) => fs.existsSync(f)) ? own : [__filename]; // in the one-file build, the file itself is the engine
    return crypto.createHash('sha256').update(files.map((f) => fs.readFileSync(f)).join('\n')).digest('hex');
  })();
  const cacheDir = config.cache === false ? null : path.resolve(config.cache || (isUrl || !source ? path.resolve('.handwriting-cache') : path.join(path.dirname(path.resolve(source)), '.handwriting-cache')));

  function readCache(key) {
    if (!cacheDir) return null;
    try {
      return v8.deserialize(fs.readFileSync(path.join(cacheDir, 'style-' + key.slice(0, 32) + '.v8')));
    } catch {
      return null; // none, or an unreadable one: build again
    }
  }
  function writeCache(key, value) {
    if (!cacheDir) return;
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const file = path.join(cacheDir, 'style-' + key.slice(0, 32) + '.v8');
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, v8.serialize(value), { mode: 0o600 });
      fs.renameSync(tmp, file); // whole or not at all, so another call starting now never reads half a file
      for (const f of fs.readdirSync(cacheDir)) if (/^style-.*\.v8$/.test(f) && f !== path.basename(file)) fs.unlinkSync(path.join(cacheDir, f));
    } catch {
      /* a read-only folder: it just stays slow */
    }
  }

  /** GET an address (http or https), following redirects. */
  function fetchBytes(url, hops) {
    return new Promise((resolve, reject) => {
      const req = (/^https:/i.test(url) ? https : http).get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 5) {
          res.resume();
          return resolve(fetchBytes(new URL(res.headers.location, url).href, (hops || 0) + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Could not download the handwriting from ${url} (HTTP ${res.statusCode}).`));
        }
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve(Buffer.concat(parts)));
      });
      req.on('timeout', () => req.destroy(new Error('Timed out downloading ' + url)));
      req.on('error', (e) => reject(new Error(`Could not download the handwriting from ${url}: ${e.message}. If this computer needs a proxy, download the file with curl and give its path with --samples instead.`)));
    });
  }

  async function load() {
    if (!source) throw new Error('No handwriting is set. Start the server with --samples /path/to/my-handwriting.json (the file the Export button in the Teach tab saves), or --samples-url <address of the sealed file> with --password, or set HANDWRITING_FILE.');
    let stamp2 = null;
    if (!isUrl) {
      try {
        stamp2 = fs.statSync(source).mtimeMs;
      } catch {
        throw new Error('Cannot read the handwriting file at ' + source + '. Check the path.');
      }
    }
    if (cache && (isUrl ? Date.now() - cache.at < REFRESH_MS : cache.mtime === stamp2)) return cache;
    let bytes = isUrl ? await fetchBytes(source) : fs.readFileSync(source);
    if (isSealed(bytes)) bytes = unseal(bytes, config.password); // the plain samples are only ever in memory
    const key = crypto.createHash('sha256').update(stamp).update(bytes).digest('hex');
    let built = readCache(key);
    if (!built) {
      const words = S.fromJSON(bytes.toString('utf8'));
      built = { style: S.buildStyle(words), words: words.length };
      writeCache(key, built);
    }
    cache = { mtime: stamp2, at: Date.now(), style: built.style, words: built.words };
    return cache;
  }

  const clampNum = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.max(lo, Math.min(hi, Number(v))) : d);
  const lookFrom = (a) => ({
    messiness: clampNum(a.messiness, 0, 1, LOOK.messiness),
    variation: clampNum(a.variation, 0, 1, LOOK.variation),
    neatness: clampNum(a.neatness, 0, 1, LOOK.neatness),
    wordReuse: clampNum(a.word_reuse, 0, 1, LOOK.wordReuse),
    slantDelta: LOOK.slantDelta,
    wordSpacing: LOOK.wordSpacing,
  });
  const inkOf = (a) => (/^#[0-9a-f]{6}$/i.test(a.ink || '') ? a.ink : DEFAULT_INK);
  const text = (t) => ({ type: 'text', text: t });
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'out';
  function outPath(name) {
    fs.mkdirSync(outDir, { recursive: true });
    return path.join(outDir, name);
  }

  let counter = 0;
  const formatOf = (a) => (['png', 'svg', 'both'].includes(a.format) ? a.format : ['png', 'svg', 'both'].includes(config.format) ? config.format : 'png');
  async function renderOne(a) {
    if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('text is required.');
    const { style } = await load();
    const box = { page: 0, x: 0, y: 0, w: clampNum(a.width_pt, 40, 1200, 400), h: 1e4, text: a.text, kind: a.kind === 'math' ? 'math' : 'text', xhPt: clampNum(a.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT), seed: Math.round(clampNum(a.seed, 1, 1e6, 1)), auto: false };
    const placed = Sheet.layoutBox(style, box, lookFrom(a));
    const ink = inkOf(a);
    const format = formatOf(a);
    const base = safeName(a.text.slice(0, 24)) + '-' + Date.now().toString(36) + (counter++).toString(36);
    const pt = (v) => Math.round(v * placed.K * 100) / 100;
    // the SVG is sized in points, so it comes out at the letter height that was asked for when it is placed at its own size
    const svg = R.toSVG(placed.layout, { ink, pen: 1, constant: true, paper: 'none' }).replace(/ width="[^"]*" height="[^"]*"/, ` width="${pt(placed.layout.width)}pt" height="${pt(Math.ceil(placed.layout.height))}pt"`);
    const svgPath = outPath(base + '.svg');
    fs.writeFileSync(svgPath, svg);
    let png = null;
    let pngPath = null;
    if (format !== 'svg') {
      const d = R.layoutToPath(placed.layout, 1, true);
      const rgb = Sheet.hexToRgb(ink).map((v) => Math.round(v * 255));
      png = renderPng(d, placed.layout.width, Math.ceil(placed.layout.height), placed.K * 4, rgb).png; // 4 pixels per point
      pngPath = outPath(base + '.png');
      fs.writeFileSync(pngPath, png);
    }
    const notes = [`Written at letter height ${placed.xhPt} pt, ${Math.round(placed.layout.width * placed.K)} x ${Math.round(placed.layout.height * placed.K)} pt. SVG: ${svgPath}${pngPath ? '  PNG: ' + pngPath : ''}`];
    if (placed.missing.length) notes.push('No sample for: ' + placed.missing.join(' ') + ' (skipped or drawn as a stand-in).');
    return { svg, format, b64: png && png.toString('base64'), notes: notes.join('\n') };
  }

  /** What goes back for one rendered item: the PNG as an image, the SVG as text (MCP has no SVG image type), or both. */
  function blocks(r, label, a, images) {
    const out = [];
    const tag = label ? label + '. ' : '';
    if (r.b64 && images !== false) out.push({ type: 'image', data: r.b64, mimeType: 'image/png' });
    if (r.svg && r.format !== 'png' && images !== false) out.push(text(r.svg));
    out.push(text(tag + r.notes));
    if (r.b64 && a.include_base64) out.push(text(tag + 'image/png base64:\n' + r.b64));
    return out;
  }

  const defs = [
    {
      name: 'handwriting_status',
      description: "Says whether the user's handwriting is loaded and which characters it has no sample for yet. Characters without a sample are skipped when writing, so check this before writing anything with unusual symbols or digits.",
      inputSchema: { type: 'object', properties: { check: { type: 'string', description: 'Optional text to check: lists the characters in it that have no sample.' } } },
      async run(a) {
        const { style, words } = await load();
        const missing = S.missingChars(style, a.check || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?()+-=/\'"');
        return [text(`Handwriting loaded: ${words} recorded words, ${style.count} letters and symbols cut out. ${missing.length ? 'No sample for: ' + missing.join(' ') : 'Every character checked has a sample.'}`)];
      },
    },
    {
      name: 'write_text',
      description: "Writes text, or TeX-style math, in the user's own handwriting and returns a picture of it (blue ink on white). It also saves a transparent SVG (and the PNG) and gives their paths; ask for format \"svg\" to get the SVG markup itself back instead of a picture. Use it to check how an answer looks before putting it on a worksheet, or to produce a handwritten snippet.",
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'What to write. For math, TeX-style: x^2, \\frac{a}{b}, \\sqrt{x}, \\int_0^1 f(x)\\,dx.' },
          kind: { type: 'string', enum: ['text', 'math'], description: 'Default text.' },
          width_pt: { type: 'number', description: 'Line width in points before it wraps. Default 400.' },
          letter_height_pt: { type: 'number', description: 'Height of a lowercase letter in points. Default 9.5, which looks like handwriting on a letter-size page.' },
          ink: { type: 'string', description: 'Pen colour as #rrggbb. Default #1749b3 (blue).' },
          seed: { type: 'integer', description: 'Another number gives another take of the same text.' },
          neatness: { type: 'number', description: '0 to 1, higher is easier to read. Default 0.5.' },
          messiness: { type: 'number', description: '0 to 1. Default 0.3.' },
          format: { type: 'string', enum: ['png', 'svg', 'both'], description: 'png (default) comes back as an image. svg comes back as text: the SVG markup itself, transparent, sized in points, ready to save as a .svg file or place on a page. both gives both. The files are saved either way.' },
          include_base64: { type: 'boolean', description: 'Also put the PNG, base64 encoded, in the text of the reply (for a client that cannot show images). It is long, so leave it off otherwise.' },
        },
      },
      async run(a) {
        return blocks(await renderOne(a), '', a);
      },
    },
    {
      name: 'write_batch',
      description: "Writes several pieces of text or math in the user's handwriting in one call, so the handwriting is loaded once. Takes a list of items, each like write_text's arguments (text, kind, seed, ...); options given at the top level are the default for every item. Returns each in order (as a PNG image, SVG text, or both, see format) and saves each as a PNG and SVG. An item that fails is reported by its number and the others still come back. Use this instead of calling write_text many times.",
      inputSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: { type: 'array', maxItems: 100, items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['text', 'math'] }, seed: { type: 'integer' }, width_pt: { type: 'number' }, letter_height_pt: { type: 'number' }, ink: { type: 'string' } } } },
          width_pt: { type: 'number' },
          letter_height_pt: { type: 'number' },
          ink: { type: 'string' },
          neatness: { type: 'number' },
          messiness: { type: 'number' },
          format: { type: 'string', enum: ['png', 'svg', 'both'], description: 'As in write_text. Default png.' },
          return_images: { type: 'boolean', description: 'Default true. False returns only the saved file paths, which is much smaller.' },
          include_base64: { type: 'boolean', description: 'Also give each PNG as base64 text.' },
        },
      },
      async run(a) {
        if (!Array.isArray(a.items) || !a.items.length) throw new Error('items must be a list with at least one item.');
        if (a.items.length > 100) throw new Error('At most 100 items per call.');
        const { items, return_images: images, ...shared } = a;
        const out = [];
        for (const [i, item] of a.items.entries()) {
          try {
            out.push(...blocks(await renderOne(Object.assign({}, shared, item)), String(i + 1), a, images));
          } catch (e) {
            out.push(text(`${i + 1}. FAILED: ${e.message}`));
          }
        }
        return out;
      },
    },
    {
      name: 'inspect_pdf',
      description: 'Reads a PDF and tells you where things are, so you can choose where answers go. For each page: its size in points, the printed text as lines with their position, and the ruled lines (answer lines and box edges). All positions are in points from the top-left corner of the page, the same as fill_pdf. Look at the PDF itself too if you can, since this lists only text and lines, not pictures.',
      inputSchema: { type: 'object', required: ['pdf'], properties: { pdf: { type: 'string', description: 'Path to the PDF.' }, min_rule_pt: { type: 'number', description: 'Shortest line to report, in points. Default 36.' } } },
      async run(a) {
        const bytes = readPdf(a.pdf);
        const pages = await inspectPdf(bytes, { minRule: clampNum(a.min_rule_pt, 5, 600, 36) });
        const lines = [];
        for (const p of pages) {
          lines.push(`Page ${p.page}: ${p.width} x ${p.height} pt${p.rotated ? ' (rotated: fill_pdf cannot write on it)' : ''}`);
          for (const t of p.text) lines.push(`  text  x=${t.x} y=${t.y} w=${t.w} h=${t.h}  "${t.text}"`);
          for (const r of p.rules) lines.push(`  line  x=${r.x} y=${r.y} w=${r.w}`);
        }
        return [text(lines.join('\n'))];
      },
    },
    {
      name: 'fill_pdf',
      description: "Writes answers in the user's handwriting onto a PDF and saves a new PDF (the original is not changed). Each answer goes in a box: x and y are the box's top-left corner in points from the page's top-left, width is how wide it may be. Give height (the box's height), or line_y instead of y to have the writing sit on a printed line at that y (use the y of a 'line' from inspect_pdf). An answer too long for its box is written smaller, down to 5 pt letters, and the report says so. Pages are numbered from 1. Do not invent answers for the user; write only what you were asked to write.",
      inputSchema: {
        type: 'object',
        required: ['pdf', 'answers'],
        properties: {
          pdf: { type: 'string', description: 'Path to the PDF.' },
          out: { type: 'string', description: 'Where to save. Default: <name>-filled.pdf in the output folder.' },
          ink: { type: 'string', description: 'Pen colour as #rrggbb. Default #1749b3.' },
          neatness: { type: 'number' },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['page', 'x', 'width', 'text'],
              properties: {
                page: { type: 'integer', description: 'From 1.' },
                x: { type: 'number' },
                y: { type: 'number', description: 'Top of the box.' },
                line_y: { type: 'number', description: 'Instead of y: the y of the printed line the writing sits on.' },
                width: { type: 'number' },
                height: { type: 'number', description: 'Default 28 (one line) when line_y is used, otherwise 40.' },
                text: { type: 'string' },
                kind: { type: 'string', enum: ['text', 'math'] },
                letter_height_pt: { type: 'number' },
                seed: { type: 'integer' },
                shrink_to_fit: { type: 'boolean', description: 'Default true.' },
              },
            },
          },
        },
      },
      async run(a) {
        const { style } = await load();
        const bytes = readPdf(a.pdf);
        if (!Array.isArray(a.answers) || !a.answers.length) throw new Error('answers must be a list with at least one answer.');
        const PDFLib = pdfLib();
        const probe = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const sizes = probe.getPages().map((p) => {
          const v = p.getCropBox ? p.getCropBox() : p.getMediaBox();
          return { w: v.width, h: v.height };
        });
        const look = lookFrom(a);
        const items = [];
        const report = [];
        a.answers.forEach((ans, i) => {
          const where = `answer ${i + 1}`;
          const page = Math.round(Number(ans.page)) - 1;
          if (!(page >= 0 && page < sizes.length)) throw new Error(`${where}: page ${ans.page} does not exist (the PDF has ${sizes.length}).`);
          if (typeof ans.text !== 'string' || !ans.text.trim()) throw new Error(`${where}: text is empty.`);
          for (const k of ['x', 'width']) if (!Number.isFinite(Number(ans[k]))) throw new Error(`${where}: ${k} must be a number.`);
          if (!Number.isFinite(Number(ans.y)) && !Number.isFinite(Number(ans.line_y))) throw new Error(`${where}: give y (top of the box) or line_y (the printed line it sits on).`);
          const h = clampNum(ans.height, 8, 800, Number.isFinite(Number(ans.line_y)) ? 28 : 40);
          const y = Number.isFinite(Number(ans.line_y)) ? Number(ans.line_y) - h : Number(ans.y);
          const box = { page, x: Number(ans.x), y, w: Number(ans.width), h, text: ans.text, kind: ans.kind === 'math' ? 'math' : 'text', xhPt: ans.letter_height_pt ? clampNum(ans.letter_height_pt, 4, 40, Sheet.DEFAULT_XH_PT) : undefined, seed: Math.round(clampNum(ans.seed, 1, 1e6, 1)), auto: ans.shrink_to_fit !== false };
          if (box.x < 0 || box.y < -1 || box.x + box.w > sizes[page].w + 1 || box.y + box.h > sizes[page].h + 1) throw new Error(`${where}: the box (x ${box.x}, y ${box.y}, ${box.w} x ${box.h}) is outside page ${page + 1}, which is ${sizes[page].w} x ${sizes[page].h} pt.`);
          const placed = Sheet.layoutBox(style, box, look);
          items.push({ box, placed });
          const bits = [`answer ${i + 1} (page ${page + 1}): written at ${placed.xhPt.toFixed(1)} pt`];
          if (placed.overflow) bits.push('DOES NOT FIT the box, make it bigger or shorten the text');
          else if (placed.xhPt < (box.xhPt || Sheet.DEFAULT_XH_PT) - 0.05) bits.push('made smaller to fit');
          if (placed.missing.length) bits.push('no sample for ' + placed.missing.join(' '));
          report.push(bits.join('; '));
        });
        const out = await Sheet.writeInk(PDFLib, bytes, items, { ink: inkOf(a), pen: 1, constant: true });
        const dest = a.out ? path.resolve(a.out) : outPath(safeName(path.basename(a.pdf).replace(/\.pdf$/i, '')) + '-filled.pdf');
        if (path.resolve(a.pdf) === dest) throw new Error('out is the same file as pdf. Choose another name; the original is never overwritten.');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, out);
        return [text(`Saved ${dest}\n` + report.join('\n'))];
      },
    },
  ];

  const available = PDF ? defs : defs.filter((d) => d.name !== 'inspect_pdf' && d.name !== 'fill_pdf');

  function readPdf(p) {
    if (typeof p !== 'string' || !p) throw new Error('pdf (a path) is required.');
    let b;
    try {
      b = fs.readFileSync(p);
    } catch {
      throw new Error('Cannot read ' + p);
    }
    if (b.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(p + ' is not a PDF.');
    return new Uint8Array(b);
  }

  return {
    list: () => available.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async call(name, args) {
      const t = available.find((d) => d.name === name);
      if (!t) throw new Error('Unknown tool ' + name);
      return t.run(args || {});
    },
  };
}

module.exports = { createTools };

},
"src/style.js": function (module, exports, __req) {
/*
 * What the app knows about one person's handwriting: the aligned letters, coverage, slant.
 * It is rebuilt from the raw captured words, so only those need to be saved.
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? __req("src/geometry.js") : root.HW.geometry;
  const A = typeof require !== 'undefined' ? __req("src/align.js") : root.HW.align;

  /** Pressure / speed statistics over every captured point. */
  function computeStats(rawWords) {
    const ps = [];
    const speeds = [];
    for (const w of rawWords) {
      for (const s of w.strokes) {
        for (let i = 0; i < s.length; i++) {
          if (s[i][3] != null) ps.push(s[i][3]);
          if (i > 0) {
            const dt = s[i][2] - s[i - 1][2];
            if (dt > 0) {
              const d = Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]) / w.xh;
              speeds.push((d / dt) * 1000);
            }
          }
        }
      }
    }
    let hasPressure = false;
    let pMean = 0.5;
    if (ps.length > 20) {
      const m = ps.reduce((a, b) => a + b, 0) / ps.length;
      const v = ps.reduce((a, b) => a + (b - m) * (b - m), 0) / ps.length;
      const distinct = new Set(ps.map((p) => Math.round(p * 50))).size;
      hasPressure = v > 0.003 && distinct > 5;
      pMean = m || 0.5;
    }
    const vMed = speeds.length ? A.median(speeds) : 1;
    return { hasPressure, pMean, vMed };
  }

  // Per-word work is cached (keyed by the raw word object) so adding one word to a large set
  // only costs one alignment. The cache is invalidated when the pressure / speed statistics
  // or the writer's overall slant move noticeably.
  const cache = new WeakMap();

  function statsKey(stats) {
    return [stats.hasPressure ? 1 : 0, Math.round((stats.pMean || 0.5) * 20), Math.round(Math.log(stats.vMed || 1) * 5)].join('|');
  }

  // Words that use none of the writer's ascender / descender proportions (only a, c, e, m, n, o,
  // r, s, u, v, w, x, z) are sized from their own x-height alone, so a new profile can't change them.
  const needsProfile = (text) => /[^acemnorsuvwxz\s.,]/.test(text);
  const symbolOnly = (text) => !/[A-Za-z0-9]/.test(text);

  function alignAll(rawWords, stats) {
    const sk = statsKey(stats);
    const entries = rawWords.map((raw) => {
      let e = cache.get(raw);
      if (!e) {
        e = {};
        cache.set(raw, e);
      }
      if (e.sk !== sk) {
        e.sk = sk;
        e.fit1 = null;
        e.pk = null;
        e.aligned = null;
      }
      return e;
    });

    // Pass 1: size each word from its own letters, then learn this writer's proportions
    // (how tall their b/d/h/k/l are, how deep their descenders go).
    entries.forEach((e, i) => {
      if (!e.fit1) e.fit1 = A.fitView(rawWords[i], stats);
    });
    const profile = A.learnProfile(entries.map((e) => e.fit1.res));
    // coarse key, so adding one word doesn't re-size every word that was already done
    const pk = [profile.asc, profile.tee, profile.tall, profile.desc].map((v) => v.toFixed(1)).join('|') + '|' + (profile.s === undefined ? 'x' : profile.s.toFixed(2) + '|' + profile.dy.toFixed(1));

    // Pass 2: re-size words that depend on those proportions.
    entries.forEach((e, i) => {
      if (e.pk !== pk) {
        const text = rawWords[i].text;
        if (profile.s !== undefined && symbolOnly(text)) e.fit2 = A.fitFixed(rawWords[i], stats, { s: profile.s, dy: profile.dy });
        else e.fit2 = needsProfile(text) ? A.fitView(rawWords[i], stats, profile) : e.fit1;
        e.pk = pk;
        e.aligned = null;
      }
    });

    const slants = entries.filter((e) => e.fit2.prep.slant !== null).map((e) => e.fit2.prep.slant);
    const slantHint = slants.length >= 3 ? A.median(slants) : undefined;
    const hk = slantHint === undefined ? 'none' : Math.round(slantHint / 0.02);
    const aligned = rawWords.map((raw, i) => {
      const e = entries[i];
      if (!e.aligned || e.hk !== hk) {
        const own = e.fit2.prep.slant;
        const sameAsFit = e.fit2.res && e.fit2.res.ok && own !== null && (slantHint === undefined || Math.abs(own - slantHint) <= 0.1);
        let res = e.fit2.res;
        if (!sameAsFit) {
          try {
            res = A.alignWord(raw, { stats, slantHint, prepared: e.fit2.prep });
          } catch (err) {
            res = { ok: false, reason: String(err && err.message ? err.message : err) };
          }
        }
        e.aligned = Object.assign({ text: raw.text, ownSlant: own }, res);
        e.hk = hk;
      }
      return e.aligned;
    });
    return { aligned, profile };
  }

  /** ~20 points spread along all of a unit's ink, left edge at x = 0 (baseline stays at y = 0). */
  function shapeSample(u) {
    if (u._shape) return u._shape;
    const strokes = u.strokes.map((s) => s.pts).concat(u.marks.map((m) => m.pts));
    const lens = strokes.map((pts) => G.pathLength(pts));
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    const out = [];
    strokes.forEach((pts, i) => {
      const n = Math.max(2, Math.round((20 * lens[i]) / total));
      for (const p of G.resample(pts, Math.max(lens[i] / n, 1e-3))) out.push([p.x - u.box.minX, p.y]);
    });
    u._shape = out;
    return out;
  }

  /** Mean nearest-point distance both ways between two point sets. */
  function shapeDistance(a, b) {
    const oneWay = (p, q) => {
      let sum = 0;
      for (const [x, y] of p) {
        let best = Infinity;
        for (const [u, v] of q) {
          const d = (x - u) * (x - u) + (y - v) * (y - v);
          if (d < best) best = d;
        }
        sum += Math.sqrt(best);
      }
      return sum / p.length;
    };
    return 0.5 * (oneWay(a, b) + oneWay(b, a));
  }

  /** The shape of a unit alone: its ink stretched to fill a 1 x 1 box, so size doesn't matter. */
  function shapeOnly(u) {
    if (u._shapeOnly) return u._shapeOnly;
    const pts = shapeSample(u);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = Math.max(maxX - minX, 0.15);
    const h = Math.max(maxY - minY, 0.15);
    u._shapeOnly = pts.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
    return u._shapeOnly;
  }

  /** How different two units look: shape first, then how far apart their sizes are. */
  function lookDistance(a, b) {
    const ha = Math.max(a.box.maxY - a.box.minY, 0.15);
    const hb = Math.max(b.box.maxY - b.box.minY, 0.15);
    const wa = Math.max(a.box.maxX - a.box.minX, 0.15);
    const wb = Math.max(b.box.maxX - b.box.minX, 0.15);
    return shapeDistance(shapeOnly(a), shapeOnly(b)) + 0.1 * Math.abs(Math.log(ha / hb)) + 0.06 * Math.abs(Math.log(wa / wb));
  }

  /**
   * Letters written on their own are always cut correctly, so they are a clean reference for what
   * each letter looks like. A cut-out letter (from a word) that looks clearly more like a
   * *different* letter's reference than its own was probably cut in the wrong place, and gets
   * u.wrong = 1. Only letters with at least two references can be judged.
   */
  // Letters that have the same shape once size is removed (a stem is a stem at any height), so a
  // letter that looks like one of these is not a sign it was cut wrongly.
  const LOOKALIKES = ['il1|!jI', 'oO0', ".,'`"];
  // Plain strokes and punctuation: their shape alone says too little (and two isolated examples
  // can't show how they look when written in a word), so they are never called wrong.
  const NO_SHAPE_CHECK = "il1|!jI.,'`:;";
  function lookAlike(a, b) {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    return LOOKALIKES.some((g) => g.includes(a) && g.includes(b));
  }

  function markWrongOnes(byChar) {
    const refs = [];
    for (const [ch, list] of byChar) {
      const iso = list.filter((u) => u.iso);
      if (iso.length >= 2 && /[A-Za-z0-9]/.test(ch)) refs.push({ ch, units: iso });
    }
    // recompute only when a new letter gets references, or every few more references, not for each one added
    const sig = refs.map((r) => r.ch).join('') + ':' + Math.floor(refs.reduce((n, r) => n + r.units.length, 0) / 6);
    if (refs.length < 6) {
      for (const list of byChar.values()) for (const u of list) u.wrong = 0;
      return;
    }
    for (const [ch, list] of byChar) {
      const own = refs.find((r) => r.ch === ch);
      for (const u of list) {
        if (u.iso || !own || NO_SHAPE_CHECK.includes(ch)) {
          u.wrong = 0;
          continue;
        }
        if (u._wrongSig === sig) continue;
        u._wrongSig = sig;
        const dist = (units) => (units.length ? Math.min(...units.map((v) => lookDistance(u, v))) : Infinity);
        const dOwn = dist(own.units);
        let dOther = Infinity;
        for (const r of refs) if (!lookAlike(ch, r.ch)) dOther = Math.min(dOther, dist(r.units));
        u._dOwn = dOwn;
        u.wrong = dOther < 0.6 * dOwn && dOwn - dOther > 0.03 ? 1 : 0;
      }
    }
    // Safety valve: if this would call more than one letter in ten wrong, the references and the
    // words probably look too different (neat single letters against quick writing) for the
    // comparison to mean anything for this writer, so don't act on it.
    const cut = [];
    for (const list of byChar.values()) for (const u of list) if (!u.iso) cut.push(u);
    if (cut.length >= 30 && cut.filter((u) => u.wrong).length > 0.1 * cut.length) for (const u of cut) u.wrong = 0;
  }

  const oddCache = new Map(); // char -> the units it was last computed for

  /**
   * Flag examples of a letter that look unlike the writer's other examples of it. A letter that
   * was cut in the wrong place (half of a neighbour, a stray loop) differs from its siblings, so
   * u.odd gets large and the synthesizer avoids it. Needs a few examples of the letter. Groups
   * that haven't changed since the last build are skipped.
   */
  function markOddOnes(byChar) {
    for (const [ch, list] of byChar) {
      const prev = oddCache.get(ch);
      if (prev && prev.length === list.length && prev.every((u, i) => u === list[i])) continue;
      oddCache.set(ch, list.slice());
      for (const u of list) u.odd = 0;
      if (list.length < 4) continue;
      const shapes = list.map(shapeSample);
      // compare each example with at most 14 others, evenly spread
      const step = Math.max(1, Math.floor(list.length / 14));
      const score = list.map((_, i) => {
        const d = [];
        for (let j = 0; j < list.length; j += step) if (j !== i) d.push(shapeDistance(shapes[i], shapes[j]));
        return A.median(d);
      });
      const med = A.median(score);
      const mad = A.median(score.map((v) => Math.abs(v - med)));
      list.forEach((u, i) => {
        u.odd = Math.min(4, Math.max(0, (score[i] - med) / (mad * 1.5 + 0.03)));
      });
    }
  }

  // ---- rhythm: how this writer's lines behave -------------------------------------------

  /** Robust standard deviation (median absolute deviation), 0 for fewer than 3 values. */
  function robustSd(v) {
    if (v.length < 3) return 0;
    const m = A.median(v);
    return 1.4826 * A.median(v.map((x) => Math.abs(x - m)));
  }

  /** Lag-1 correlation within lines, pooled; series is a list of arrays. */
  function pooledRho(series) {
    let num = 0;
    let den = 0;
    for (const s of series) {
      for (let i = 0; i < s.length; i++) den += s[i] * s[i];
      for (let i = 1; i < s.length; i++) num += s[i] * s[i - 1];
    }
    return den > 1e-12 ? Math.max(0, Math.min(0.9, num / den)) : 0;
  }

  /**
   * Measure how the writer's full lines behave, from words written as part of a line:
   * gaps between words, how the baseline wanders and slopes, how size and slant drift.
   * Distances are in the writer's own x-heights. Returns {learned: false} until there are
   * enough lines, in which case the synthesizer uses generic values.
   */
  function computeRhythm(rawWords, aligned) {
    const lines = new Map();
    rawWords.forEach((raw, i) => {
      const a = aligned[i];
      if (!raw.line || !a || !a.ok || !a.view) return;
      let left = Infinity;
      let right = -Infinity;
      for (const st of raw.strokes) for (const p of st) {
        if (p[0] < left) left = p[0];
        if (p[0] > right) right = p[0];
      }
      if (!lines.has(raw.line)) lines.set(raw.line, []);
      lines.get(raw.line).push({
        pos: raw.pos || 0,
        left,
        right,
        xh: raw.xh * a.view.s,
        base: raw.baseline + a.view.dy * raw.xh,
        slant: a.ownSlant,
      });
    });
    const gaps = [];
    const baseSeries = [];
    const sizeSeries = [];
    const slopes = [];
    const slantDev = [];
    let nLines = 0;
    for (const words of lines.values()) {
      if (words.length < 3) continue;
      words.sort((p, q) => p.pos - q.pos);
      nLines++;
      const xhLine = A.median(words.map((w) => w.xh));
      for (let k = 1; k < words.length; k++) gaps.push((words[k].left - words[k - 1].right) / xhLine);
      // baseline: straight-line fit across the line, then what is left over
      const cx = words.map((w) => (w.left + w.right) / 2);
      const n = words.length;
      const mx = cx.reduce((a, b) => a + b, 0) / n;
      const my = words.reduce((a, w) => a + w.base, 0) / n;
      let sxx = 0;
      let sxy = 0;
      cx.forEach((x, i) => {
        sxx += (x - mx) * (x - mx);
        sxy += (x - mx) * (words[i].base - my);
      });
      const slope = sxx > 1e-9 ? sxy / sxx : 0;
      slopes.push(Math.atan(slope));
      baseSeries.push(words.map((w, i) => (w.base - (my + slope * (cx[i] - mx))) / xhLine));
      const logs = words.map((w) => Math.log(w.xh / xhLine));
      const lm = logs.reduce((a, b) => a + b, 0) / n;
      sizeSeries.push(logs.map((v) => v - lm));
      const sl = words.filter((w) => w.slant !== null && w.slant !== undefined).map((w) => w.slant);
      if (sl.length >= 3) {
        const med = A.median(sl);
        sl.forEach((v) => slantDev.push(v - med));
      }
    }
    if (nLines < 3 || gaps.length < 10) return { learned: false, lines: nLines };
    // Each word's size / baseline / slant is itself an estimate, and a noisy one for short words
    // or ambiguous letters, so measured drift is partly measurement noise (on real handwriting it
    // comes out several times larger than people actually vary). Keep it within human ranges,
    // and assume drift is smooth along a line, since noise also hides the correlation.
    const gapMean = Math.max(0.2, A.median(gaps));
    return {
      learned: true,
      lines: nLines,
      gapMean,
      gapSd: Math.min(robustSd(gaps), 0.35 * gapMean),
      baseSd: Math.min(robustSd(baseSeries.flat()), 0.1),
      baseRho: Math.max(0.4, pooledRho(baseSeries)),
      sizeSd: Math.min(robustSd(sizeSeries.flat()), 0.1),
      sizeRho: Math.max(0.4, pooledRho(sizeSeries)),
      slopeSd: Math.min(robustSd(slopes), 0.03),
      slantSd: Math.min(robustSd(slantDev), 0.07),
    };
  }

  /**
   * 0..1 for how far a cut-out letter is from this writer's own single-letter version of it,
   * relative to the other cut-outs of that letter (0 = typical, 1 = among the furthest).
   */
  function markFarOnes(byChar) {
    for (const list of byChar.values()) {
      const cut = list.filter((u) => !u.iso && typeof u._dOwn === 'number' && isFinite(u._dOwn));
      if (cut.length < 6) {
        for (const u of list) u.far = 0;
        continue;
      }
      const d = cut.map((u) => u._dOwn).sort((a, b) => a - b);
      const q50 = d[d.length >> 1];
      const q90 = d[Math.floor(d.length * 0.9)];
      const span = Math.max(q90 - q50, 1e-6);
      for (const u of list) u.far = u.iso || typeof u._dOwn !== 'number' ? 0 : Math.min(1, Math.max(0, (u._dOwn - q50) / span));
    }
  }

  // ---- closed bowls -------------------------------------------------------------------------
  function segCross(a, b, c, d) {
    const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return o(a, b, c) > 0 !== o(a, b, d) > 0 && o(c, d, a) > 0 !== o(c, d, b) > 0;
  }

  /** Does a pen stroke of this letter close on itself (cross itself, or come back to where it was)? */
  function hasBowl(u) {
    if (u._bowl !== undefined) return u._bowl;
    let found = false;
    for (const s of u.strokes) {
      const p = s.pts;
      const n = p.length;
      if (n < 8 || found) continue;
      const len = [0];
      for (let i = 1; i < n; i++) len.push(len[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y));
      for (let i = 0; i < n - 1 && !found; i++) {
        for (let j = i + 6; j < n - 1; j++) {
          if (segCross(p[i], p[i + 1], p[j], p[j + 1])) {
            found = true;
            break;
          }
        }
      }
      for (let i = 0; i < n && !found; i++) {
        for (let j = i + 1; j < n; j++) {
          if (len[j] - len[i] > 0.9 && Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y) < 0.1) {
            found = true;
            break;
          }
        }
      }
    }
    u._bowl = found;
    return found;
  }

  /**
   * For letters this writer's single-letter version closes (a, e, o, d, ...) and which they close
   * in most of their words too, a cut-out copy that stays open is probably cut wrongly (an "a" that
   * reads as a "u"). Flag those.
   */
  function markOpenOnes(byChar) {
    for (const list of byChar.values()) {
      const iso = list.filter((u) => u.iso);
      const cut = list.filter((u) => !u.iso);
      const refsClosed = iso.length >= 2 && iso.every(hasBowl);
      const closedShare = cut.length ? cut.filter(hasBowl).length / cut.length : 0;
      const applies = refsClosed && cut.length >= 6 && closedShare >= 0.6;
      for (const u of list) u.open = applies && !u.iso && !hasBowl(u) ? 1 : 0;
    }
  }

  // ---- stray scraps ---------------------------------------------------------------------------
  function pieceLength(piece) {
    let n = 0;
    for (let i = 1; i < piece.pts.length; i++) n += Math.hypot(piece.pts[i].x - piece.pts[i - 1].x, piece.pts[i].y - piece.pts[i - 1].y);
    return n;
  }

  /**
   * A cut-out letter that has more pen pieces than this writer's single-letter version, where the extra
   * ones are tiny, has picked up a scrap of its neighbour (the dot of an i, the end of a comma): the
   * "or" that turns into "ori". Flag those.
   */
  function markStrayOnes(byChar) {
    for (const list of byChar.values()) {
      const iso = list.filter((u) => u.iso).map((u) => u.strokes.length + u.marks.length);
      const k = iso.length >= 2 && iso.every((n) => n === iso[0]) ? iso[0] : 0;
      for (const u of list) {
        u.stray = 0;
        if (!k || u.iso) continue;
        const pieces = u.strokes.concat(u.marks);
        if (pieces.length <= k) continue;
        const lens = pieces.map(pieceLength).sort((a, b) => a - b);
        const extra = lens.slice(0, pieces.length - k).reduce((a, b) => a + b, 0);
        if (extra < 0.6) u.stray = 1;
      }
    }
  }

  function inkExtent(u) {
    let a = Infinity;
    let b = -Infinity;
    let c = Infinity;
    let d = -Infinity;
    for (const s of u.strokes) {
      for (const p of s.pts) {
        if (p.x < a) a = p.x;
        if (p.x > b) b = p.x;
        if (p.y < c) c = p.y;
        if (p.y > d) d = p.y;
      }
    }
    return { w: b - a, h: d - c };
  }

  /**
   * Letters written on their own come out wider and taller than the same letters inside a word.
   * Replace each single letter by a copy shrunk by how this writer's in-word versions compare
   * (never enlarged). The originals are left alone, so this can run on every rebuild.
   */
  /** A copy of a unit scaled by f.fx across and f.fy up, from its left edge and the baseline. The original is untouched. */
  function scaleUnit(u, f) {
    const x0 = u.box.minX;
    const mapPt = (p) => ({ ...p, x: x0 + (p.x - x0) * f.fx, y: p.y * f.fy });
    const dir = (e) => {
      const dx = e.dx * f.fx;
      const dy = e.dy * f.fy;
      const l = Math.hypot(dx, dy) || 1;
      return { ...e, x: x0 + (e.x - x0) * f.fx, y: e.y * f.fy, dx: dx / l, dy: dy / l };
    };
    return {
      ...u,
      strokes: u.strokes.map((st) => ({ ...st, pts: st.pts.map(mapPt) })),
      marks: u.marks.map((m) => ({ ...m, pts: m.pts.map(mapPt) })),
      entry: dir(u.entry),
      exit: dir(u.exit),
      box: { minX: x0, maxX: x0 + (u.box.maxX - x0) * f.fx, minY: u.box.minY * f.fy, maxY: u.box.maxY * f.fy },
    };
  }

  /**
   * A slash written on the pad is often far taller than anything else the writer makes (three x-heights against
   * letters that top out around two), which looks wrong in "9/5". Scale it down, evenly, to the writer's own
   * ascender height. Copies replace the originals, so this can run on every rebuild.
   */
  function tidyTallSymbols(byChar, allByChar, profile) {
    const top = (profile && profile.asc ? profile.asc : 1.85) + 0.25;
    for (const ch of ['/']) {
      const list = allByChar.get(ch);
      if (!list) continue;
      const pool = byChar.get(ch);
      list.forEach((u, i) => {
        const h = u.box.maxY - Math.min(0, u.box.minY);
        if (h <= top) return;
        const c = scaleUnit(u, { fx: top / h, fy: top / h });
        list[i] = c;
        if (pool) pool.forEach((p, k) => p === u && (pool[k] = c));
      });
    }
  }

  /**
   * A letter written on its own often starts with a short, nearly flat run-in stroke before it turns down into the
   * letter (the little tail on an "m"), which the writer does not make inside a word. Cut that run-in off: a copy
   * of the unit without it. Anything else is returned as it is.
   */
  function trimRunIn(u) {
    const st0 = u.strokes[0];
    if (!st0 || st0.pts.length < 8) return u;
    const pts = st0.pts;
    const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
    // the opening direction, from the first few points
    const a0 = ang(pts[0], pts[Math.min(3, pts.length - 1)]);
    if (Math.abs(Math.sin(a0)) > 0.55 || Math.cos(a0) < 0) return u; // not an opening that runs to the right, flat-ish
    let len = 0;
    let k = -1;
    for (let i = 1; i < pts.length - 2; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (len > 0.45) break;
      const next = ang(pts[i], pts[Math.min(i + 3, pts.length - 1)]);
      if (next < -1.0 && next > -2.4 && len > 0.04) {
        // now heading steeply down (y is up, so a negative angle is down): the run-in ends here
        k = i;
        break;
      }
    }
    if (k < 0) return u;
    const rest = pts.slice(k);
    const strokes = [{ ...st0, pts: rest }].concat(u.strokes.slice(1));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const piece of strokes.concat(u.marks)) {
      for (const p of piece.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const d = Math.hypot(rest[2].x - rest[0].x, rest[2].y - rest[0].y) || 1;
    const entry = { ...u.entry, x: rest[0].x, y: rest[0].y, dx: (rest[2].x - rest[0].x) / d, dy: (rest[2].y - rest[0].y) / d };
    return { ...u, strokes, entry, box: { minX, maxX, minY, maxY }, trimmed: true };
  }

  function shrinkSingleLetters(byChar, allByChar) {
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const kind = (ch) => (/[a-z]/.test(ch) ? 'l' : /[A-Z]/.test(ch) ? 'u' : /[0-9]/.test(ch) ? 'd' : null);
    const per = new Map();
    const pooled = { l: { x: [], y: [] }, u: { x: [], y: [] }, d: { x: [], y: [] } };
    for (const [ch, list] of allByChar) {
      const k = kind(ch);
      if (!k) continue;
      const iso = list.filter((u) => u.iso && !u.skipped).map(inkExtent);
      const cut = list.filter((u) => !u.iso && !u.skipped).map(inkExtent);
      if (!iso.length || cut.length < 3) continue;
      const fx = med(cut.map((e) => e.w)) / med(iso.map((e) => e.w));
      const fy = med(cut.map((e) => e.h)) / med(iso.map((e) => e.h));
      if (!isFinite(fx) || !isFinite(fy)) continue;
      per.set(ch, { fx, fy, n: cut.length });
      pooled[k].x.push(fx);
      pooled[k].y.push(fy);
    }
    const clamp = (v) => Math.min(1, Math.max(0.6, v));
    const factorFor = (ch) => {
      const k = kind(ch);
      if (!k || pooled[k].x.length < 3) return null;
      const px = med(pooled[k].x);
      const py = med(pooled[k].y);
      const own = per.get(ch);
      if (!own) return { fx: clamp(px), fy: clamp(py) };
      const wgt = own.n / (own.n + 1); // a few examples are enough to go on; none at all falls back to the pooled ratio
      return { fx: clamp(wgt * own.fx + (1 - wgt) * px), fy: clamp(wgt * own.fy + (1 - wgt) * py) };
    };
    for (const [ch, list] of allByChar) {
      const f = factorFor(ch);
      const swap = new Map();
      if (!f || (f.fx > 0.98 && f.fy > 0.98)) {
        // no shrinking needed, but a run-in stroke is still trimmed
        list.forEach((u, i) => {
          if (!u.iso) return;
          const c = trimRunIn(u);
          if (c === u) return;
          swap.set(u, c);
          list[i] = c;
        });
        const pool = byChar.get(ch);
        if (pool) pool.forEach((u, i) => swap.has(u) && (pool[i] = swap.get(u)));
        continue;
      }
      list.forEach((u, i) => {
        if (!u.iso) return;
        const c = scaleUnit(trimRunIn(u), f);
        swap.set(u, c);
        list[i] = c;
      });
      const inPool = byChar.get(ch);
      if (inPool) inPool.forEach((u, i) => swap.has(u) && (inPool[i] = swap.get(u)));
    }
  }

  function buildStyle(rawWords) {
    const words = rawWords.filter((w) => w && w.strokes && w.strokes.length && w.text);
    const stats = computeStats(words);
    const { aligned, profile } = alignAll(words, stats);

    const byChar = new Map();
    const allByChar = new Map();
    const slants = [];
    const gaps = [];
    let joinsMid = 0;
    let joins = 0;
    const failed = [];
    const suspect = [];

    aligned.forEach((w, wi) => {
      if (!w.ok) {
        failed.push({ index: wi, text: w.text, reason: w.reason });
        return;
      }
      slants.push(w.slant);
      w.units.forEach((u, idx) => {
        u.wid = wi;
        u.idx = idx;
        u.id = wi + ':' + idx;
        u.word = w;
        u.iso = !!(words[wi] && words[wi].iso); // written on its own, so never mis-cut
        u.dev = A.deviation(u, profile);
        // letters the writer has crossed out in the letter check stay out of the pool
        const crossed = words[wi] && words[wi].skip;
        u.skipped = !!(crossed && crossed.some((c) => c.i === idx && c.ch === u.ch));
        if (!allByChar.has(u.ch)) allByChar.set(u.ch, []);
        allByChar.get(u.ch).push(u);
        if (!u.skipped) {
          if (!byChar.has(u.ch)) byChar.set(u.ch, []);
          byChar.get(u.ch).push(u);
        }
        if (idx > 0) {
          const p = w.units[idx - 1];
          joins++;
          if (p.exit.mid && u.entry.mid) joinsMid++;
          else if (!p.exit.mid && !u.entry.mid) gaps.push(u.box.minX - p.box.maxX);
        }
      });
    });

    // Words worth a second look: alignment cost that is an outlier against this writer's own
    // words, or a letter whose shape contradicts its character (e.g. a descender on an "s").
    const qs = aligned.filter((w) => w.ok && w.units.length > 1).map((w) => w.quality);
    const qMed = A.median(qs);
    const qMad = A.median(qs.map((q) => Math.abs(q - qMed)));
    const qLimit = Math.max(qMed + 4 * qMad, qMed * 2, 0.8);
    aligned.forEach((w, wi) => {
      if (!w.ok) return;
      const badShape = w.units.some((u) => u.hc > 0.8);
      if ((w.units.length > 1 && qs.length >= 5 && w.quality > qLimit) || badShape) {
        suspect.push({ index: wi, text: w.text, quality: w.quality });
        w.suspect = true;
      }
    });

    markOddOnes(byChar);
    markWrongOnes(byChar);
    markFarOnes(byChar);
    markOpenOnes(byChar);
    markStrayOnes(byChar);
    shrinkSingleLetters(byChar, allByChar);
    tidyTallSymbols(byChar, allByChar, profile);

    // how close this writer lets neighbouring (unjoined) letters get, by nearest ink
    const clears = [];
    for (const w of aligned) {
      if (!w.ok) continue;
      for (let i = 1; i < w.units.length; i++) {
        const p = w.units[i - 1];
        const u = w.units[i];
        if (p.exit.mid || u.entry.mid || /[^a-zA-Z]/.test(p.ch + u.ch)) continue;
        const c = A.inkBase(p, u);
        if (c !== null) clears.push(c);
      }
    }
    const clearance = clears.length >= 20 ? { median: A.median(clears), sd: robustSd(clears) } : null;

    const liftGap = gaps.length ? Math.min(0.5, Math.max(-0.05, A.median(gaps))) : 0.1;
    const unitById = new Map();
    for (const list of allByChar.values()) for (const u of list) unitById.set(u.id, u);
    // Words the writer actually wrote, by their letters, so a typed word they have written can be written back
    // from their own strokes. Single letters, words the aligner was unsure of, and words with a crossed-out or
    // implausible letter are left out.
    const wholeWords = new Map();
    for (const w of aligned) {
      if (!w.ok || w.suspect || !w.units.length || w.units.some((u) => u.iso || u.skipped || (u.hc || 0) > 0.8)) continue;
      const core = w.units.map((u) => u.ch).join('').replace(/[.,!?;:]+$/, '');
      if (core.length < 2) continue;
      if (!wholeWords.has(core)) wholeWords.set(core, []);
      wholeWords.get(core).push(w);
    }
    return {
      words: aligned,
      byChar,
      allByChar,
      unitById,
      wholeWords,
      profile,
      clearance,
      rhythm: computeRhythm(words, aligned),
      slant: slants.length ? A.median(slants) : 0,
      liftGap,
      connectivity: joins ? joinsMid / joins : 0,
      hasPressure: stats.hasPressure,
      stats,
      failed,
      suspect,
      count: aligned.filter((w) => w.ok).length,
    };
  }

  /** Characters (from `text`) we have no sample for. */
  function missingChars(style, text) {
    const miss = new Set();
    for (const ch of Array.from(text)) {
      if (/\s/.test(ch)) continue;
      if (!style.byChar.has(normalizeChar(ch)) && !fallbackFor(style, normalizeChar(ch))) miss.add(ch);
    }
    return Array.from(miss);
  }

  const CHAR_MAP = {
    '‘': "'", '’': "'", '‚': ',', '‛': "'", '“': '"', '”': '"',
    '„': '"', '–': '-', '—': '-', '−': '-', '…': '...', ' ': ' ',
  };

  function normalizeChar(ch) {
    return CHAR_MAP[ch] || ch;
  }

  /** {ch, scale} to use when there is no sample for `ch`, or null. */
  function fallbackFor(style, ch) {
    if (style.byChar.has(ch)) return { ch, scale: 1 };
    if (ch >= 'A' && ch <= 'Z' && style.byChar.has(ch.toLowerCase())) return { ch: ch.toLowerCase(), scale: 1.55 };
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base !== ch && base.length === 1) return fallbackFor(style, base);
    return null;
  }

  function coverage(style) {
    const out = {};
    for (const [ch, list] of style.byChar) out[ch] = list.length;
    return out;
  }

  function toJSON(rawWords) {
    return JSON.stringify({ version: 1, words: rawWords });
  }

  function fromJSON(str) {
    const o = JSON.parse(str);
    if (!o || !Array.isArray(o.words)) throw new Error('Not a handwriting style file');
    return o.words;
  }

  const api = { buildStyle, computeRhythm, missingChars, coverage, normalizeChar, fallbackFor, toJSON, fromJSON, computeStats, lookDistance, hasBowl, trimRunIn };
  root.HW = root.HW || {};
  root.HW.style = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

},
"src/geometry.js": function (module, exports, __req) {
/*
 * Small geometry helpers: resampling, smoothing, bridges between points, seeded noise.
 * Points are {x, y} plus optional t, p, w channels that are interpolated along with them.
 */
(function (root) {
  'use strict';

  const CHANNELS = ['t', 'p', 'w'];

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pathLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
    return s;
  }

  function lerpPt(a, b, u) {
    const o = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    for (const c of CHANNELS) {
      if (a[c] !== undefined && b[c] !== undefined) o[c] = a[c] + (b[c] - a[c]) * u;
      else if (a[c] !== undefined) o[c] = a[c];
    }
    return o;
  }

  function copyPt(p) {
    return Object.assign({}, p);
  }

  /** Re-sample a polyline at (almost) equal arc-length spacing. Keeps both end points. */
  function resample(pts, step) {
    if (pts.length === 0) return [];
    if (pts.length === 1) return [copyPt(pts[0]), copyPt(pts[0])];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    if (total < 1e-9) return [copyPt(pts[0]), copyPt(pts[pts.length - 1])];
    const n = Math.max(1, Math.round(total / step));
    const out = [];
    let seg = 1;
    for (let k = 0; k <= n; k++) {
      const s = (total * k) / n;
      while (seg < cum.length - 1 && cum[seg] < s) seg++;
      const span = cum[seg] - cum[seg - 1];
      const u = span > 1e-12 ? (s - cum[seg - 1]) / span : 0;
      out.push(lerpPt(pts[seg - 1], pts[seg], Math.min(1, Math.max(0, u))));
    }
    return out;
  }

  function gaussKernel(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v);
      sum += v;
    }
    return { k: k.map((v) => v / sum), r };
  }

  /**
   * Gaussian smoothing of evenly spaced points. Uses odd reflection at the ends so the
   * end points stay exactly where they are (strokes never shrink).
   * `fields` lists the channels to smooth in addition to x / y ('x','y' are always done).
   */
  function smooth(pts, sigma, fields) {
    const n = pts.length;
    if (n < 3 || sigma <= 0) return pts.map(copyPt);
    const { k, r } = gaussKernel(sigma);
    const chans = ['x', 'y'].concat(fields || []);
    const out = pts.map(copyPt);
    for (const c of chans) {
      if (pts[0][c] === undefined) continue;
      const odd = c === 'x' || c === 'y';
      const get = (i) => {
        if (i < 0) {
          const j = Math.min(n - 1, -i);
          return odd ? 2 * pts[0][c] - pts[j][c] : pts[j][c];
        }
        if (i > n - 1) {
          const j = Math.max(0, 2 * (n - 1) - i);
          return odd ? 2 * pts[n - 1][c] - pts[j][c] : pts[j][c];
        }
        return pts[i][c];
      };
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let d = -r; d <= r; d++) acc += k[d + r] * get(i + d);
        out[i][c] = acc;
      }
    }
    return out;
  }

  /** Unit direction of travel around index i using +-m samples. */
  function dirAt(pts, i, m) {
    const a = pts[Math.max(0, i - m)];
    const b = pts[Math.min(pts.length - 1, i + m)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) return { dx: 1, dy: 0 };
    return { dx: dx / l, dy: dy / l };
  }

  /** Cubic Hermite from (p0, t0) to (p1, t1); returns the interior points only. */
  function hermite(p0, t0, p1, t1, spacing) {
    const d = dist(p0, p1);
    const n = Math.max(1, Math.round(d / spacing));
    const m = d; // tangent magnitude == chord length gives an unhurried S-curve
    const out = [];
    for (let i = 1; i < n; i++) {
      const u = i / n;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      const pt = {
        x: h00 * p0.x + h10 * m * t0.dx + h01 * p1.x + h11 * m * t1.dx,
        y: h00 * p0.y + h10 * m * t0.dy + h01 * p1.y + h11 * m * t1.dy,
      };
      for (const c of CHANNELS) {
        if (p0[c] !== undefined && p1[c] !== undefined) pt[c] = p0[c] + (p1[c] - p0[c]) * u;
      }
      out.push(pt);
    }
    return out;
  }

  /** Catmull-Rom subdivision (k points per span); keeps original points. */
  function catmull(pts, k) {
    if (k <= 1 || pts.length < 3) return pts;
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      for (let j = 0; j < k; j++) {
        const u = j / k;
        const u2 = u * u;
        const u3 = u2 * u;
        const f = (a, b, c, d) =>
          0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
        const pt = { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
        for (const c of CHANNELS) {
          if (p1[c] !== undefined && p2[c] !== undefined) pt[c] = p1[c] + (p2[c] - p1[c]) * u;
        }
        out.push(pt);
      }
    }
    out.push(copyPt(pts[n - 1]));
    return out;
  }

  /** Largest change of direction (degrees) between consecutive segments. */
  function maxTurnDeg(pts) {
    let worst = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x;
      const by = pts[i + 1].y - pts[i].y;
      if (Math.hypot(ax, ay) < 1e-9 || Math.hypot(bx, by) < 1e-9) continue;
      let d = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      d = Math.abs(d) * (180 / Math.PI);
      if (d > worst) worst = d;
    }
    return worst;
  }

  // ---- randomness -------------------------------------------------------------------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rng) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Smooth 1-D value noise in [-1, 1]; lattice spacing 1. */
  function makeNoise(rng) {
    const lattice = [];
    for (let i = 0; i < 64; i++) lattice.push(rng() * 2 - 1);
    return function (x) {
      const i = Math.floor(x);
      const f = x - i;
      const a = lattice[((i % 64) + 64) % 64];
      const b = lattice[(((i + 1) % 64) + 64) % 64];
      const u = f * f * (3 - 2 * f);
      return a + (b - a) * u;
    };
  }

  const api = {
    dist,
    pathLength,
    lerpPt,
    copyPt,
    resample,
    smooth,
    dirAt,
    hermite,
    catmull,
    maxTurnDeg,
    mulberry32,
    gaussian,
    makeNoise,
  };

  root.HW = root.HW || {};
  root.HW.geometry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

},
"src/align.js": function (module, exports, __req) {
/*
 * Cuts one captured word into letters.
 * Coordinates: y up, baseline at 0, x-height = 1, slant removed.
 * The cuts follow the pen path instead of a vertical line, so loops and joins stay with the
 * right letter. It is a small DP over candidate cut points, using how cheap a place is to cut,
 * the expected letter widths, and whether a letter's height fits (ascender, x-height, descender).
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? __req("src/geometry.js") : root.HW.geometry;

  const STEP = 0.03; // resampling step, in x-heights
  // Gaussian smoothing of raw pen data, in samples. Small, quick handwriting has pen tremor that
  // shows up as jagged strokes once it is enlarged, so this is fairly strong.
  const SMOOTH_SIGMA = 2.4;

  // ---- priors ---------------------------------------------------------------------------

  const LOWER = {
    a: 0.95, b: 0.9, c: 0.8, d: 0.95, e: 0.85, f: 0.7, g: 0.95, h: 0.95, i: 0.45, j: 0.5,
    k: 0.9, l: 0.5, m: 1.4, n: 0.95, o: 0.9, p: 0.95, q: 0.95, r: 0.75, s: 0.75, t: 0.7,
    u: 0.95, v: 0.85, w: 1.3, x: 0.9, y: 0.9, z: 0.8,
  };
  const PUNCT = {
    '.': 0.3, ',': 0.3, "'": 0.25, '"': 0.5, '-': 0.6, '!': 0.3, '?': 0.75, ':': 0.3, ';': 0.35,
    '(': 0.45, ')': 0.45, '/': 0.6, '&': 1.1, '@': 1.3, '#': 1.0, '%': 1.3, '+': 0.8, '=': 0.8,
    '*': 0.6, $: 0.8,
  };

  function defaultWidth(ch) {
    if (LOWER[ch] !== undefined) return LOWER[ch];
    if (PUNCT[ch] !== undefined) return PUNCT[ch];
    if (ch >= 'A' && ch <= 'Z') {
      if (ch === 'M') return 1.6;
      if (ch === 'W') return 1.7;
      if (ch === 'I') return 0.45;
      if (ch === 'J') return 0.8;
      return 1.2;
    }
    if (ch >= '0' && ch <= '9') return ch === '1' ? 0.6 : 0.9;
    return 0.9;
  }

  const classCache = new Map();
  function heightClass(ch) {
    let c = classCache.get(ch);
    if (!c) {
      c = {
        asc: 'bdfhkl'.includes(ch),
        tee: ch === 't',
        tall: /[A-Z0-9]/.test(ch),
        low: 'acemnorsuvwxz'.includes(ch),
        desc: 'gjpqy'.includes(ch),
        noDesc: 'abcdehiklmnorstuvwx'.includes(ch),
      };
      classCache.set(ch, c);
    }
    return c;
  }

  let boxBuf = new Float64Array(0);

  function heightCostK(k, minY, maxY) {
    let c = 0;
    if (k.asc) c += Math.max(0, 1.45 - maxY) * 2;
    else if (k.tee) c += Math.max(0, 0.95 - maxY) * 2 + Math.max(0, maxY - 1.8) * 1.5;
    else if (k.tall) c += Math.max(0, 1.35 - maxY) * 2;
    else if (k.low) c += Math.max(0, maxY - 1.3) * 2 + Math.max(0, 0.7 - maxY) * 2;
    if (k.desc) c += Math.max(0, minY + 0.35) * 2;
    else if (k.noDesc) c += Math.max(0, -0.4 - minY) * 1.5;
    return c;
  }

  /** How badly a letter's vertical extent contradicts what the character should look like. */
  function heightCost(ch, b) {
    return heightCostK(heightClass(ch), b.minY, b.maxY);
  }

  // ---- normalisation --------------------------------------------------------------------

  const IDENTITY = { s: 1, dy: 0 };
  // How tall / deep letters usually are, in x-heights. learnProfile() replaces these with the
  // writer's own numbers once enough words have been measured.
  const DEFAULT_PROFILE = { asc: 1.85, tee: 1.35, tall: 1.8, dot: 1.55, desc: -0.85 };

  /**
   * raw = {text, strokes:[[ [x,y,t,p], ... ]], xh, baseline}; canvas pixels, y down.
   * view = {s, dy}: the writer's real x-height as a fraction of the guide's, and how far below
   * the guide baseline their real baseline sits (in guide x-heights). Words are normalised to
   * their own baseline and x-height, since people rarely write exactly at the guide size.
   */
  function normalize(raw, view) {
    const v = view || IDENTITY;
    const xh = raw.xh * v.s;
    const base = raw.baseline + v.dy * raw.xh;
    let minX = Infinity;
    for (const s of raw.strokes) for (const pt of s) minX = Math.min(minX, pt[0]);
    const out = [];
    for (const s of raw.strokes) {
      const pts = [];
      for (const pt of s) {
        const q = {
          x: (pt[0] - minX) / xh,
          y: (base - pt[1]) / xh,
          t: pt[2] || 0,
          p: pt[3] == null ? 0.5 : pt[3],
        };
        const last = pts[pts.length - 1];
        if (last && Math.abs(last.x - q.x) < 1e-9 && Math.abs(last.y - q.y) < 1e-9) continue;
        pts.push(q);
      }
      if (pts.length) out.push(pts);
    }
    return out;
  }

  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /** Resample + smooth one stroke and attach a width factor `w` per point. */
  function cleanStroke(s, stats) {
    const rs = G.resample(s, STEP);
    const sm = rs.length >= 8 ? G.smooth(rs, SMOOTH_SIGMA, ['p']) : rs;
    if (stats && stats.hasPressure) {
      const pm = stats.pMean || 0.5;
      for (const pt of sm) pt.w = clamp(0.5 + 0.5 * (pt.p / pm), 0.4, 1.8);
    } else {
      // speed based: faster -> thinner, like a real pen
      const v = [];
      for (let i = 0; i < sm.length; i++) {
        const a = sm[Math.max(0, i - 1)];
        const b = sm[Math.min(sm.length - 1, i + 1)];
        const dt = Math.max(1, b.t - a.t);
        v.push((G.dist(a, b) / dt) * 1000);
      }
      const vs = sm.length >= 8 ? G.smooth(v.map((x) => ({ x, y: 0 })), 3).map((q) => q.x) : v;
      const vm = (stats && stats.vMed) || median(vs) || 1;
      for (let i = 0; i < sm.length; i++) sm[i].w = clamp(1.12 - 0.2 * (vs[i] / vm - 1), 0.7, 1.3);
    }
    return sm;
  }

  function estimateSlant(strokes) {
    const sx = [];
    const sy = [];
    const sw = [];
    let total = 0;
    for (const s of strokes) {
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1];
        const b = s[i];
        const ym = (a.y + b.y) / 2;
        if (ym < 0.05 || ym > 1.25) continue;
        const dy = Math.abs(b.y - a.y);
        sx.push((a.x + b.x) / 2);
        sy.push(ym);
        sw.push(dy);
        total += dy;
      }
    }
    if (total < 0.8) return null;
    const BINS = 512;
    const hist = new Float64Array(BINS);
    let best = 0;
    let bestScore = -1;
    for (let th = -0.45; th <= 0.65; th += 0.025) {
      const tn = Math.tan(th);
      hist.fill(0);
      for (let i = 0; i < sx.length; i++) {
        const bin = Math.floor((sx[i] - sy[i] * tn) / 0.05) + 64;
        if (bin >= 0 && bin < BINS) hist[bin] += sw[i];
      }
      let score = 0;
      for (let i = 0; i < BINS; i++) score += hist[i] * hist[i];
      score *= 1 - 0.15 * Math.abs(th); // mild preference for upright on ties
      if (score > bestScore) {
        bestScore = score;
        best = th;
      }
    }
    return best;
  }

  /** Clean strokes + raw slant estimate (null when there is too little to judge from). */
  function preprocess(raw, stats, view) {
    const v = view || IDENTITY;
    const strokes = normalize(raw, v).map((s) => cleanStroke(s, stats));
    return { strokes, slant: strokes.length ? estimateSlant(strokes) : null, view: v };
  }

  /**
   * First guess at a word's baseline and x-height. The word's text says roughly how tall and
   * how deep its ink should be (a "b" reaches ~1.9 x-heights, a "g" drops ~0.85, an "o" only
   * fills the x-height), so the ink extent gives the size and the ink bottom gives the baseline.
   */
  function initialView(raw, prof) {
    const P = prof || DEFAULT_PROFILE;
    let top = Infinity;
    let bottom = -Infinity;
    for (const s of raw.strokes) {
      for (const p of s) {
        top = Math.min(top, p[1]);
        bottom = Math.max(bottom, p[1]);
      }
    }
    if (!isFinite(top) || bottom - top < 1) return IDENTITY;
    let up = 1.0; // nominal top of the tallest letter, in x-heights
    let down = 0; // nominal depth of the deepest letter
    for (const ch of Array.from(raw.text)) {
      const k = heightClass(ch);
      if (k.asc) up = Math.max(up, P.asc);
      else if (k.tall) up = Math.max(up, P.tall);
      else if (ch === 'i' || ch === 'j') up = Math.max(up, P.dot);
      else if (k.tee) up = Math.max(up, P.tee);
      if (k.desc) down = Math.min(down, P.desc);
      else if (ch === ',' || ch === ';') down = Math.min(down, -0.3);
    }
    const s = clamp((bottom - top) / raw.xh / (up - down), 0.25, 1.6);
    // baseline (canvas y) = ink bottom raised by the nominal depth
    const baselinePx = bottom + down * s * raw.xh;
    return { s, dy: (baselinePx - raw.baseline) / raw.xh };
  }

  /**
   * Correct a word's baseline and x-height using its own aligned letters. The bottoms of
   * letters that don't descend should sit at 0; the tops of x-height letters at 1, and the tops
   * of tall letters at the writer's usual ascender height. Every letter votes, using medians so
   * a few badly cut ones don't matter.
   */
  function refinedView(view, units, prof) {
    const P = prof || DEFAULT_PROFILE;
    const bottoms = [];
    for (const u of units) {
      const k = heightClass(u.ch);
      if (k.low || k.asc || k.tee || k.tall) bottoms.push(u.box.minY);
    }
    if (bottoms.length < 2) return view;
    const b = median(bottoms);
    const votes = [];
    for (const u of units) {
      const k = heightClass(u.ch);
      const h = u.box.maxY - b;
      if (k.low) votes.push(h);
      else if (k.asc) votes.push(h / P.asc);
      else if (k.tall) votes.push(h / P.tall);
    }
    if (votes.length < 2) return view;
    const h = median(votes);
    if (!(h > 0.2)) return view;
    return { s: clamp(view.s * h, 0.2, 2), dy: view.dy - b * view.s };
  }

  // Letter spacing is judged by nearest ink, like a writer does by eye, not by bounding boxes: a
  // loop, tail or crossbar shouldn't push the next letter away. The ink of a letter is summarised
  // as its rightmost and leftmost x in each horizontal band.
  const PB = 0.1; // band height, x-heights
  const PY0 = -1.4;
  const PN = 40;

  function inkProfile(u) {
    if (u._prof) return u._prof;
    const R = new Float64Array(PN).fill(-Infinity);
    const L = new Float64Array(PN).fill(Infinity);
    const add = (pts) => {
      for (const p of pts) {
        const b = Math.floor((p.y - PY0) / PB);
        if (b < 0 || b >= PN) continue;
        if (p.x > R[b]) R[b] = p.x;
        if (p.x < L[b]) L[b] = p.x;
      }
    };
    for (const s of u.strokes) add(s.pts);
    for (const m of u.marks) add(m.pts);
    u._prof = { R, L };
    return u._prof;
  }

  /**
   * How much the translation of B must exceed A's so the nearest ink of the two is exactly 0 apart;
   * i.e. "base": placing B at tx_B = tx_A + clearance - base leaves `clearance` between them.
   * Bands next to each other count, so a diagonal approach is seen. null if they never overlap
   * vertically (a comma beside a t, say).
   */
  function inkBase(a, b) {
    const pa = inkProfile(a);
    const pb = inkProfile(b);
    let base = Infinity;
    for (let i = 0; i < PN; i++) {
      if (!isFinite(pa.R[i])) continue;
      for (let d = -1; d <= 1; d++) {
        const j = i + d;
        if (j < 0 || j >= PN || !isFinite(pb.L[j])) continue;
        base = Math.min(base, pb.L[j] - pa.R[i]);
      }
    }
    return isFinite(base) ? base : null;
  }

  /** How far a letter's height is from this writer's usual for that letter (0 = typical). */
  function deviation(u, prof) {
    const k = heightClass(u.ch);
    if (k.low) return Math.abs(u.box.maxY - 1);
    if (k.asc) return Math.abs(u.box.maxY - prof.asc) / prof.asc;
    if (k.tall) return Math.abs(u.box.maxY - prof.tall) / prof.tall;
    if (k.tee) return Math.abs(u.box.maxY - prof.tee) / prof.tee;
    if (k.desc) return Math.abs(u.box.minY - prof.desc) / Math.abs(prof.desc);
    return 0;
  }

  /**
   * The writer's own letter proportions, measured on words whose size is reliably known (those
   * with several x-height letters, so the x-height itself can be read off them).
   * aligned: [{units, ...}] as returned by alignWord for a fitted word.
   */
  function learnProfile(aligned) {
    const pick = (test, val) => {
      const v = [];
      for (const w of aligned) {
        if (!w.ok) continue;
        if (w.units.filter((u) => heightClass(u.ch).low).length < 3) continue;
        for (const u of w.units) if (test(u.ch)) v.push(val(u));
      }
      return v.length >= 6 ? median(v) : null;
    };
    const P = Object.assign({}, DEFAULT_PROFILE);
    const asc = pick((c) => heightClass(c).asc, (u) => u.box.maxY);
    const tee = pick((c) => c === 't', (u) => u.box.maxY);
    const tall = pick((c) => heightClass(c).tall, (u) => u.box.maxY);
    const desc = pick((c) => heightClass(c).desc, (u) => u.box.minY);
    // how big, and where on the pad's baseline, this writer's x-height is (read off the same words)
    const views = aligned.filter((w) => w.ok && w.view && w.units.filter((u) => heightClass(u.ch).low).length >= 3).map((w) => w.view);
    if (views.length >= 5) {
      P.s = median(views.map((v) => v.s));
      P.dy = median(views.map((v) => v.dy));
    }
    if (asc) P.asc = clamp(asc, 1.3, 2.6);
    if (tee) P.tee = clamp(tee, 1.0, 2.0);
    if (tall) P.tall = clamp(tall, 1.3, 2.6);
    if (desc) P.desc = clamp(desc, -1.4, -0.4);
    return P;
  }

  /**
   * Find the baseline and x-height of a word: start from the text-based guess, align, measure
   * the result against what the letters should look like, and repeat until it settles.
   * Returns {prep, res}: the prepared word (strokes normalised to that baseline and x-height)
   * and its alignment.
   */
  function fitView(raw, stats, prof) {
    let view = initialView(raw, prof);
    let best = null;
    for (let round = 0; round < 4; round++) {
      const prep = preprocess(raw, stats, view);
      let res;
      try {
        res = alignWord(raw, { stats, prepared: prep });
      } catch {
        res = { ok: false };
      }
      const q = res.ok ? res.quality : Infinity;
      if (!best || q < best.q) best = { prep, res, q };
      if (!res.ok) break;
      const next = refinedView(view, res.units, prof);
      const moved = Math.abs(next.s / view.s - 1) + Math.abs(next.dy - view.dy) / view.s;
      view = next;
      if (moved < 0.04) break;
    }
    if (best) return { prep: best.prep, res: best.res };
    return { prep: preprocess(raw, stats, initialView(raw, prof)), res: { ok: false } };
  }

  /** Words made only of symbols have nothing to size them by, so they take the writer's usual size and baseline. */
  function fitFixed(raw, stats, view) {
    const prep = preprocess(raw, stats, view);
    let res;
    try {
      res = alignWord(raw, { stats, prepared: prep });
    } catch {
      res = { ok: false };
    }
    return { prep, res };
  }

  function strokeInfo(s) {
    let minX = Infinity;
    let maxX = -Infinity;
    let sx = 0;
    let sy = 0;
    for (const p of s) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      sx += p.x;
      sy += p.y;
    }
    return { minX, maxX, cx: sx / s.length, cy: sy / s.length, len: G.pathLength(s) };
  }

  /** Small strokes written *after* something further right (i-dots, t-bars written late). */
  function splitDelayed(strokes) {
    const primary = [];
    const delayed = [];
    let maxX = -Infinity;
    for (const s of strokes) {
      const info = strokeInfo(s);
      if (primary.length && info.len < 2.2 && info.cy > 0.25 && info.cx < maxX - 0.4) delayed.push(s);
      else {
        primary.push(s);
        maxX = Math.max(maxX, info.maxX);
      }
    }
    return { primary, delayed };
  }

  // ---- cut costs ------------------------------------------------------------------------

  /** Do two polylines cross each other? (bounding-box pruned segment intersection) */
  function polylinesCross(a, b) {
    const ccw = (p, q, r) => (r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x);
    for (let i = 1; i < a.length; i++) {
      const a0 = a[i - 1];
      const a1 = a[i];
      const ax0 = Math.min(a0.x, a1.x);
      const ax1 = Math.max(a0.x, a1.x);
      const ay0 = Math.min(a0.y, a1.y);
      const ay1 = Math.max(a0.y, a1.y);
      for (let j = 1; j < b.length; j++) {
        const b0 = b[j - 1];
        const b1 = b[j];
        if (Math.max(b0.x, b1.x) < ax0 || Math.min(b0.x, b1.x) > ax1 || Math.max(b0.y, b1.y) < ay0 || Math.min(b0.y, b1.y) > ay1) continue;
        if (ccw(a0, a1, b0) * ccw(a0, a1, b1) < 0 && ccw(b0, b1, a0) * ccw(b0, b1, a1) < 0) return true;
      }
    }
    return false;
  }

  /** 0..1: how much of the narrower of two strokes' x-ranges lies inside the other's. */
  function xOverlap(a, b) {
    const w = Math.max(0.15, Math.min(a.maxX - a.minX, b.maxX - b.minX));
    return clamp((Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) / w, 0, 1);
  }

  function computeCutCosts(P, first, sStart, sEnd, sId, strokeMaxX, strokeDot, together) {
    const N = P.length;
    const cost = new Float64Array(N + 1).fill(Infinity);
    const W = 4;
    for (let k = 1; k < N; k++) {
      if (first[k]) {
        const prevMax = strokeMaxX[sId[k] - 1];
        const over = prevMax - P[k].x;
        cost[k] = clamp((over - 0.25) * 1.5, 0, 2) + (strokeDot[sId[k]] ? 2.5 : 0); // a dot belongs to the letter before it
        cost[k] += together[sId[k]]; // strokes that cross or sit on top of each other are one letter (x, a t and its bar)
        continue;
      }
      const si = sId[k];
      if (k - sStart[si] < W || sEnd[si] - k < W) continue;
      const a = P[k - W];
      const b = P[k + W];
      const m = P[k];
      const v1x = m.x - a.x;
      const v1y = m.y - a.y;
      const v2x = b.x - m.x;
      const v2y = b.y - m.y;
      const turn = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
      const cx = b.x - a.x;
      const cl = Math.hypot(cx, b.y - a.y) || 1e-9;
      const dxn = cx / cl;
      let c = 0.5;
      const y = m.y;
      if (y >= -0.05 && y <= 0.6) c += 0;
      else if (y > 0.6 && y <= 1.15) c += 0.4;
      else c += 3;
      c += 2.5 * Math.max(0, 0.15 - dxn) * 4;
      c += 1.5 * (turn / (Math.PI / 2));
      cost[k] = c;
    }
    return cost;
  }

  // ---- main entry -----------------------------------------------------------------------

  /**
   * @param raw   {text, strokes, xh, baseline}
   * @param opts  {stats: {hasPressure, pMean, vMed}, slantHint (rad), prepared (from preprocess), widths}
   * @returns {ok, units, slant, quality, reason}
   */
  function alignWord(raw, opts) {
    opts = opts || {};
    const chars = Array.from(raw.text);
    const n = chars.length;
    const prep = opts.prepared || preprocess(raw, opts.stats);
    const strokes = prep.strokes.map((s) => s.map(G.copyPt)); // deslanting below edits in place
    if (!strokes.length || n === 0) return { ok: false, reason: 'empty' };

    // de-slant. A single short word has too few upright strokes to judge slant from, so when
    // the caller knows the writer's overall slant, a word may only deviate a little from it.
    const hint = opts.slantHint;
    let slant = prep.slant;
    if (slant === null) slant = hint !== undefined ? hint : 0;
    else if (hint !== undefined) slant = clamp(slant, hint - 0.1, hint + 0.1);
    const tn = Math.tan(slant);
    for (const s of strokes) for (const p of s) p.x -= p.y * tn;
    // shift so the word starts at x = 0
    let minX = Infinity;
    for (const s of strokes) for (const p of s) minX = Math.min(minX, p.x);
    for (const s of strokes) for (const p of s) p.x -= minX;

    if (n === 1) {
      const unit = buildUnit(chars[0], strokes.map((pts) => ({ pts, entryMid: false, exitMid: false })), []);
      return { ok: true, units: [unit], slant, quality: 0, view: prep.view };
    }

    const { primary, delayed } = splitDelayed(strokes);

    // path
    const P = [];
    const sId = [];
    const first = [];
    const sStart = [];
    const sEnd = [];
    const strokeMaxX = [];
    const strokeDot = [];
    const strokeInfos = [];
    primary.forEach((s, si) => {
      sStart.push(P.length);
      let mx = -Infinity;
      s.forEach((pt, k) => {
        P.push(pt);
        sId.push(si);
        first.push(k === 0);
        mx = Math.max(mx, pt.x);
      });
      sEnd.push(P.length - 1);
      strokeMaxX.push(mx);
      const inf = strokeInfo(s);
      strokeDot.push(inf.len < 0.35 && inf.cy > 1.0);
      strokeInfos.push(inf);
    });
    const N = P.length;
    if (N < n * 3) return { ok: false, reason: 'too short' };

    // how strongly each stroke belongs with the one before it
    const together = primary.map((st, si) => {
      if (si === 0 || strokeDot[si]) return 0;
      let c = 0;
      if (polylinesCross(primary[si - 1], st)) c += 3;
      c += 1.5 * Math.max(0, xOverlap(strokeInfos[si - 1], strokeInfos[si]) - 0.4);
      return c;
    });
    const cutCost = computeCutCosts(P, first, sStart, sEnd, sId, strokeMaxX, strokeDot, together);
    const isMid = (c) => c > 0 && c < N && !first[c];

    // expected widths
    const widths = opts.widths || {};
    const prior = chars.map((c) => (widths[c] !== undefined ? widths[c] : defaultWidth(c)));
    const priorSum = prior.reduce((a, b) => a + b, 0);
    let allMin = Infinity;
    let allMax = -Infinity;
    for (const p of P) {
      allMin = Math.min(allMin, p.x);
      allMax = Math.max(allMax, p.x);
    }
    const alpha = clamp((allMax - allMin) / priorSum, 0.6, 1.8);
    const LW = 2.0; // weight of the width term
    const HW = 2.0; // weight of the ascender / descender term
    const hk = chars.map(heightClass);
    const wMaxAll = 3 * alpha * Math.max.apply(null, prior) + 0.8;

    // candidate nodes
    const nodes = [0];
    for (let k = 1; k < N; k++) {
      if (first[k]) nodes.push(k);
      else if (k % 2 === 0 && cutCost[k] < 3.0) nodes.push(k);
    }
    nodes.push(N);
    const M = nodes.length;
    if (M - 1 < n) return { ok: false, reason: 'too few cut points' };

    // extents of every node pair, only while a segment can still have a plausible width
    const need = M * M * 4;
    if (boxBuf.length < need) boxBuf = new Float64Array(need);
    const bb = boxBuf;
    const jEnd = new Int32Array(M);
    for (let i = 0; i < M - 1; i++) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      let k = nodes[i];
      jEnd[i] = i;
      for (let j = i + 1; j < M; j++) {
        const c = nodes[j];
        while (k < c) {
          const p = P[k];
          if (p.x < x0) x0 = p.x;
          if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
          k++;
        }
        let bx0 = x0;
        let bx1 = x1;
        let by0 = y0;
        let by1 = y1;
        if (isMid(c)) {
          const p = P[c];
          if (p.x < bx0) bx0 = p.x;
          if (p.x > bx1) bx1 = p.x;
          if (p.y < by0) by0 = p.y;
          if (p.y > by1) by1 = p.y;
        }
        if (bx1 - bx0 > wMaxAll) break;
        const o = (i * M + j) * 4;
        bb[o] = bx0;
        bb[o + 1] = bx1;
        bb[o + 2] = by0;
        bb[o + 3] = by1;
        jEnd[i] = j;
      }
    }

    const segCost = (l, o) => {
      const e = alpha * prior[l];
      const r = (bb[o + 1] - bb[o] - e) / Math.max(e, 0.35);
      return LW * r * r + HW * heightCostK(hk[l], bb[o + 2], bb[o + 3]);
    };

    // DP
    const INF = 1e18;
    let prev = new Float64Array(M).fill(INF);
    prev[0] = 0;
    const back = [];
    for (let l = 0; l < n; l++) {
      const cur = new Float64Array(M).fill(INF);
      const bk = new Int32Array(M).fill(-1);
      const e = alpha * prior[l];
      const wLimit = 3 * e + 0.8; // beyond this the width term alone is > 8: never optimal
      for (let j = 1; j < M; j++) {
        const last = j === M - 1;
        if (l < n - 1 && last) continue;
        if (l === n - 1 && !last) continue;
        const cj = last ? 0 : cutCost[nodes[j]];
        if (l === 0) {
          if (jEnd[0] >= j) {
            cur[j] = segCost(l, j * 4) + cj; // starts at node 0
            bk[j] = 0;
          }
          continue;
        }
        for (let i = j - 1; i >= 1; i--) {
          if (jEnd[i] < j) break;
          const o = (i * M + j) * 4;
          if (bb[o + 1] - bb[o] > wLimit) break;
          if (prev[i] >= INF) continue;
          const v = prev[i] + segCost(l, o) + cj;
          if (v < cur[j]) {
            cur[j] = v;
            bk[j] = i;
          }
        }
      }
      back.push(bk);
      prev = cur;
    }
    if (prev[M - 1] >= INF) return { ok: false, reason: 'no alignment' };
    const seq = [M - 1];
    for (let l = n - 1; l >= 0; l--) seq.push(back[l][seq[seq.length - 1]]);
    seq.reverse(); // node indices: 0 .. M-1, length n+1
    const quality = prev[M - 1] / n;

    // units
    const units = [];
    for (let l = 0; l < n; l++) {
      const a = nodes[seq[l]];
      const c = nodes[seq[l + 1]];
      const lastIdx = isMid(c) ? c : c - 1;
      const pieces = [];
      let curPiece = null;
      for (let k = a; k <= lastIdx; k++) {
        if (!curPiece || curPiece.sid !== sId[k] || (first[k] && k !== a)) {
          curPiece = { sid: sId[k], pts: [] };
          pieces.push(curPiece);
        }
        curPiece.pts.push(G.copyPt(P[k]));
      }
      const entryMid = a > 0 && !first[a];
      const exitMid = isMid(c);
      const strokesOut = pieces.map((pc, idx) => ({
        pts: pc.pts,
        entryMid: idx === 0 ? entryMid : false,
        exitMid: idx === pieces.length - 1 ? exitMid : false,
      }));
      units.push(buildUnit(chars[l], strokesOut, []));
    }

    // attach delayed strokes (i-dots, t-bars, ...)
    for (const d of delayed) assignMark(units, d);

    return { ok: true, units, slant, quality, view: prep.view };
  }

  function boxOf(pieces) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pc of pieces) {
      for (const p of pc.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  function buildUnit(ch, strokesOut, marks) {
    const firstPiece = strokesOut[0];
    const lastPiece = strokesOut[strokesOut.length - 1];
    const f = firstPiece.pts[0];
    const l = lastPiece.pts[lastPiece.pts.length - 1];
    const fd = G.dirAt(firstPiece.pts, 0, 4);
    const ld = G.dirAt(lastPiece.pts, lastPiece.pts.length - 1, 4);
    return {
      ch,
      strokes: strokesOut,
      marks,
      entry: { x: f.x, y: f.y, dx: fd.dx, dy: fd.dy, mid: firstPiece.entryMid },
      exit: { x: l.x, y: l.y, dx: ld.dx, dy: ld.dy, mid: lastPiece.exitMid },
      box: boxOf(strokesOut),
      hc: heightCost(ch, boxOf(strokesOut)),
    };
  }

  function assignMark(units, stroke) {
    const info = strokeInfo(stroke);
    const owners = 'ijtf:;!?"\'';
    const score = (u) => {
      const lo = u.box.minX - 0.1;
      const hi = u.box.maxX + 0.1;
      let d = 0;
      if (info.cx < lo) d = lo - info.cx;
      else if (info.cx > hi) d = info.cx - hi;
      if (owners.includes(u.ch)) d -= 0.15;
      return d + 0.001 * Math.abs(info.cx - (u.box.minX + u.box.maxX) / 2);
    };
    // a long bar spanning several t/f letters is cut between them
    if (info.len > 0.9 && info.maxX - info.minX > 0.8) {
      const tu = units.filter((u) => 'tf'.includes(u.ch) && (u.box.minX + u.box.maxX) / 2 > info.minX && (u.box.minX + u.box.maxX) / 2 < info.maxX);
      if (tu.length >= 2) {
        const centers = tu.map((u) => (u.box.minX + u.box.maxX) / 2);
        const cuts = [];
        for (let i = 0; i < centers.length - 1; i++) cuts.push((centers[i] + centers[i + 1]) / 2);
        let pieces = [[]];
        let ci = 0;
        for (const p of stroke) {
          if (ci < cuts.length && p.x > cuts[ci]) {
            const prevPt = pieces[pieces.length - 1].slice(-1)[0];
            const shared = G.copyPt(p);
            if (prevPt) pieces[pieces.length - 1].push(shared);
            pieces.push([G.copyPt(p)]);
            ci++;
          } else pieces[pieces.length - 1].push(p);
        }
        pieces.forEach((pts, i) => {
          if (pts.length >= 2 && tu[i]) tu[i].marks.push({ pts });
        });
        return;
      }
    }
    let best = units[0];
    let bs = Infinity;
    for (const u of units) {
      // a late bar or dot that crosses a letter's strokes belongs to that letter
      const crosses = u.strokes.some((p) => polylinesCross(p.pts, stroke));
      const s = score(u) - (crosses ? 1 : 0);
      if (s < bs) {
        bs = s;
        best = u;
      }
    }
    best.marks.push({ pts: stroke });
  }

  const api = { alignWord, preprocess, fitView, fitFixed, initialView, learnProfile, deviation, inkBase, DEFAULT_PROFILE, heightCost, defaultWidth, normalize, cleanStroke, estimateSlant, splitDelayed, median, STEP };
  root.HW = root.HW || {};
  root.HW.align = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

},
"src/render.js": function (module, exports, __req) {
/*
 * Strokes to filled ink outlines, as SVG path data. Used for the canvas, SVG export and PNG export.
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? __req("src/geometry.js") : root.HW.geometry;

  const f2 = (v) => (Math.round(v * 100) / 100).toString();

  function smoothstep(t) {
    t = Math.min(1, Math.max(0, t));
    return t * t * (3 - 2 * t);
  }

  function dotPath(x, y, r) {
    return `M${f2(x - r)} ${f2(y)}a${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0a${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0Z`;
  }

  // The constant pen is 0.12 x-heights wide at a pen thickness of 1. That is a Notability pen at
  // thickness 3 (1.2 pt wide) against a lowercase x-height of about 10 pt, measured from a sample page.
  const CONSTANT_W = 0.12 / 0.085;

  /**
   * stroke: {pts:[{x,y,w}], taperStart, taperEnd} in px; taper values are in x-heights.
   * constant: one width all along with round ends, like a ballpoint in a note-taking app, ignoring w and the tapers.
   */
  function strokeToPath(stroke, penPx, xh, constant) {
    let pts = stroke.pts;
    if (!pts.length) return '';
    const len0 = G.pathLength(pts);
    const w0 = pts[0].w || 1;
    if (pts.length < 2 || len0 < 0.25 * penPx) {
      const c = pts[Math.floor(pts.length / 2)];
      return dotPath(c.x, c.y, 0.5 * penPx * (constant ? CONSTANT_W : (c.w || 1) * 1.05));
    }
    const spacing = len0 / (pts.length - 1);
    if (spacing > 1.4) pts = G.catmull(pts, Math.ceil(spacing / 1.2));
    const n = pts.length;
    // arc length along the stroke
    const s = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + G.dist(pts[i - 1], pts[i]));
    const total = s[n - 1];
    const tsLen = Math.max(0.5, (stroke.taperStart > 0 ? stroke.taperStart : 0.08) * xh);
    const teLen = Math.max(0.5, (stroke.taperEnd > 0 ? stroke.taperEnd : 0.08) * xh);
    const tsMin = stroke.taperStart > 0 ? 0.25 : 0.6;
    const teMin = stroke.taperEnd > 0 ? 0.25 : 0.6;

    const hw = new Array(n);
    for (let i = 0; i < n; i++) {
      if (constant) {
        hw[i] = 0.5 * penPx * CONSTANT_W;
        continue;
      }
      const w = pts[i].w !== undefined ? pts[i].w : w0;
      const a = tsMin + (1 - tsMin) * smoothstep(s[i] / tsLen);
      const b = teMin + (1 - teMin) * smoothstep((total - s[i]) / teLen);
      hw[i] = 0.5 * penPx * w * Math.min(a, b);
    }
    // never let the pen be wider than the local radius of curvature
    for (let i = 1; i < n - 1; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x;
      const by = pts[i + 1].y - pts[i].y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6) continue;
      const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      if (turn > 0.02) {
        const r = (0.5 * (la + lb)) / turn;
        if (hw[i] > 0.8 * r) hw[i] = Math.max(0.5 * hw[i], 0.8 * r);
      }
    }

    const nx = new Array(n);
    const ny = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      nx[i] = -dy;
      ny[i] = dx;
    }
    const d = [];
    const P = (x, y, first) => d.push((first ? 'M' : 'L') + f2(x) + ' ' + f2(y));
    for (let i = 0; i < n; i++) P(pts[i].x + nx[i] * hw[i], pts[i].y + ny[i] * hw[i], i === 0);
    // end cap: left -> forward -> right
    const e = n - 1;
    const edx = ny[e];
    const edy = -nx[e];
    for (let k = 1; k < 8; k++) {
      const phi = (Math.PI * k) / 8;
      P(pts[e].x + hw[e] * (Math.cos(phi) * nx[e] + Math.sin(phi) * edx), pts[e].y + hw[e] * (Math.cos(phi) * ny[e] + Math.sin(phi) * edy));
    }
    for (let i = n - 1; i >= 0; i--) P(pts[i].x - nx[i] * hw[i], pts[i].y - ny[i] * hw[i]);
    // start cap: right -> backward -> left
    const sdx = ny[0];
    const sdy = -nx[0];
    for (let k = 1; k < 8; k++) {
      const phi = (Math.PI * k) / 8;
      P(pts[0].x - hw[0] * (Math.cos(phi) * nx[0] + Math.sin(phi) * sdx), pts[0].y - hw[0] * (Math.cos(phi) * ny[0] + Math.sin(phi) * sdy));
    }
    // round joins: stamp a disc on every tight vertex (hides mitre / inner-loop artefacts)
    let discs = '';
    for (let i = 1; i < n - 1; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x;
      const by = pts[i + 1].y - pts[i].y;
      if (Math.hypot(ax, ay) < 1e-6 || Math.hypot(bx, by) < 1e-6) continue;
      const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      if (turn > 0.35) discs += dotPath(pts[i].x, pts[i].y, hw[i]);
    }
    return d.join('') + 'Z' + discs;
  }

  function layoutToPath(layout, penMult, constant) {
    const xh = layout.xh;
    const penPx = 0.085 * xh * (penMult || 1);
    const parts = [];
    for (const s of layout.strokes) parts.push(strokeToPath(s, penPx, xh, constant));
    return parts.join('');
  }

  function paperMarkup(layout, kind, lineColor) {
    const W = layout.width;
    const H = layout.height;
    const xh = layout.xh;
    const lh = layout.lineHeightPx;
    const base0 = layout.baselines[0];
    let out = '';
    if (kind === 'lined') {
      const y0 = base0 + 0.12 * xh;
      let y = y0 - Math.floor(y0 / lh) * lh;
      for (; y < H; y += lh) out += `<line x1="0" y1="${f2(y)}" x2="${W}" y2="${f2(y)}"/>`;
      out = `<g stroke="${lineColor}" stroke-width="1" opacity=".9">${out}</g>`;
      out += `<line x1="${f2(xh * 0.9)}" y1="0" x2="${f2(xh * 0.9)}" y2="${H}" stroke="#e58b8b" stroke-width="1.2" opacity=".8"/>`;
    } else if (kind === 'grid') {
      const g = Math.max(12, xh * 0.9);
      let s = '';
      for (let x = g; x < W; x += g) s += `<line x1="${f2(x)}" y1="0" x2="${f2(x)}" y2="${H}"/>`;
      for (let y = g; y < H; y += g) s += `<line x1="0" y1="${f2(y)}" x2="${W}" y2="${f2(y)}"/>`;
      out = `<g stroke="${lineColor}" stroke-width="1" opacity=".8">${s}</g>`;
    }
    return out;
  }

  /**
   * opts: {ink, pen (thickness multiplier), constant (one pen width all along), paper: 'white'|'plain'|'lined'|'grid'|'none',
   *        paperColor, lineColor}
   */
  function withDefaults(opts) {
    const o = Object.assign({ ink: '#1b1f3b', pen: 1, constant: false, paper: 'plain', paperColor: '#fffdf7', lineColor: '#b9c7e6' }, opts || {});
    if (o.paper === 'white') {
      o.paper = 'plain';
      o.paperColor = '#ffffff';
    }
    return o;
  }

  function toSVG(layout, opts) {
    const o = withDefaults(opts);
    const W = layout.width;
    const H = Math.ceil(layout.height);
    const d = layoutToPath(layout, o.pen, o.constant);
    let body = '';
    if (o.paper !== 'none') body += `<rect width="${W}" height="${H}" fill="${o.paperColor}"/>`;
    body += paperMarkup(layout, o.paper, o.lineColor);
    body += `<path d="${d}" fill="${o.ink}" fill-rule="nonzero"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  }

  function drawToCanvas(ctx, layout, opts, scale) {
    const o = withDefaults(opts);
    const sc = scale || 1;
    const W = layout.width;
    const H = Math.ceil(layout.height);
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (o.paper !== 'none') {
      ctx.fillStyle = o.paperColor;
      ctx.fillRect(0, 0, W, H);
    }
    const xh = layout.xh;
    const lh = layout.lineHeightPx;
    ctx.strokeStyle = o.lineColor;
    ctx.lineWidth = 1;
    if (o.paper === 'lined') {
      const y0 = layout.baselines[0] + 0.12 * xh;
      let y = y0 - Math.floor(y0 / lh) * lh;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (; y < H; y += lh) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
      ctx.strokeStyle = '#e58b8b';
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(xh * 0.9, 0);
      ctx.lineTo(xh * 0.9, H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (o.paper === 'grid') {
      const g = Math.max(12, xh * 0.9);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let x = g; x < W; x += g) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let y = g; y < H; y += g) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = o.ink;
    ctx.fill(new Path2D(layoutToPath(layout, o.pen, o.constant)));
    ctx.restore();
  }

  /**
   * Move and grow a layout so none of its ink is outside it (a tall letter on the first line, a long tail at the
   * right), with `pad` to spare on every side. Returns how far everything moved right and down, so a caller that
   * places the layout somewhere can move it back by the same amount and keep the writing where it was meant to be.
   */
  function fitLayout(layout, pad) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of layout.strokes) {
      for (const p of s.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) return { dx: 0, dy: 0 };
    const dx = Math.max(0, pad - minX);
    const dy = Math.max(0, pad - minY);
    if (dx || dy) {
      for (const s of layout.strokes) {
        for (const p of s.pts) {
          p.x += dx;
          p.y += dy;
        }
      }
      layout.baselines = layout.baselines.map((b) => b + dy);
    }
    layout.width = Math.max(layout.width + dx, maxX + dx + pad);
    layout.height = Math.max(layout.height + dy, maxY + dy + pad);
    return { dx, dy };
  }

  const api = { strokeToPath, layoutToPath, toSVG, drawToCanvas, fitLayout };
  root.HW = root.HW || {};
  root.HW.render = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

},
"src/sheet.js": function (module, exports, __req) {
/*
 * Putting handwriting onto a sheet (a PDF or a picture of a worksheet). This file is the part that needs no screen:
 * fitting an answer into the box it was given, and writing the ink into the PDF. The screen part is sheetui.js.
 *
 * Boxes are in PDF points, from the top-left corner of the page, the way a person looks at it:
 *   {page, x, y, w, h, text, kind: 'text' | 'math', xhPt, seed, auto}
 */
(function (root) {
  'use strict';

  const Y = typeof require !== 'undefined' ? __req("src/synth.js") : root.HW.synth;
  const M = typeof require !== 'undefined' ? __req("src/math.js") : root.HW.math;
  const R = typeof require !== 'undefined' ? __req("src/render.js") : root.HW.render;

  const ENGINE_XH = 34; // the engine lays out at this x-height in its own pixels; everything is scaled to points afterwards
  const DEFAULT_XH_PT = 9.5; // a lowercase letter this tall looks like handwriting on a letter-size worksheet
  const MIN_XH_PT = 5;

  function inkBounds(strokes) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of strokes) {
      for (const p of s.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  /**
   * Write `box.text` in the writer's hand to fit `box`. Text that is too long for the box is made smaller, a little at a
   * time (unless box.auto === false), down to MIN_XH_PT.
   * look: the sliders of the Write tab (messiness, variation, slantDelta, wordSpacing, neatness, wordReuse).
   * Returns {layout, K, xhPt, dx, dy, overflow, missing}: K is points per layout pixel, and the layout belongs at
   * (box.x - dx * K, box.y - dy * K) in points.
   */
  function layoutBox(style, box, look) {
    const text = String(box.text || '');
    let xhPt = box.xhPt || DEFAULT_XH_PT;
    const gen = box.kind === 'math' ? M : Y;
    const pad = 0.1 * ENGINE_XH;
    let out = null;
    for (let tries = 0; tries < 16; tries++) {
      const K = xhPt / ENGINE_XH;
      const lay = gen.layout(
        style,
        text,
        Object.assign({}, look || {}, {
          xh: ENGINE_XH,
          width: Math.max(60, Math.round(box.w / K)),
          lineHeight: box.kind === 'math' ? 3 : 2.5,
          seed: box.seed || 1,
          margin: 8,
        })
      );
      const moved = R.fitLayout(lay, pad);
      const b = inkBounds(lay.strokes);
      // A box about one line tall is an answer line: the writing sits on its bottom edge (descenders cross it, as they
      // do on paper) instead of hanging from the top with a gap above the printed line.
      const oneLine = box.kind !== 'math' && lay.baselines.length === 1 && box.h <= 3.4 * xhPt;
      let dy = moved.dy; // the layout's origin is box.y - dy * K points from the top of the page
      if (oneLine) {
        const top = b.minY - dy; // ink top, below the box top, in layout px
        const down = box.h / K - 0.45 * ENGINE_XH - (lay.baselines[0] - dy); // to put the baseline there
        dy -= Math.max(down, -top); // moving up is limited so the tops of the letters stay in the box
      }
      // where the ink ends, measured from the box's own top-left corner
      const right = (b.maxX - moved.dx) * K;
      const bottom = (b.maxY - dy) * K;
      const overflow = bottom > box.h + (oneLine ? 0.7 * xhPt : 1) || right > box.w + 1;
      out = { layout: lay, K, xhPt, dx: moved.dx, dy, overflow, missing: lay.missing || [] };
      if (!overflow || box.auto === false || xhPt <= MIN_XH_PT) break;
      xhPt = Math.max(MIN_XH_PT, xhPt * 0.93);
    }
    return out;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x1749b3;
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** The ink of a placed box as SVG path data in layout pixels. */
  function inkPath(placed, look) {
    return R.layoutToPath(placed.layout, look.pen === undefined ? 1 : look.pen, look.constant !== false);
  }

  /**
   * Write the boxes' ink into a PDF as vector shapes, on top of what is already on the pages.
   * PDFLib: the pdf-lib module. bytes: the PDF. items: [{box, placed}] with placed from layoutBox.
   * look: {ink: '#rrggbb', pen, constant}. Returns the new PDF's bytes.
   */
  async function writeInk(PDFLib, bytes, items, look) {
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = doc.getPages();
    const [r, g, b] = hexToRgb(look.ink);
    for (const { box, placed } of items) {
      const page = pages[box.page];
      if (!page) continue;
      if (page.getRotation().angle % 360 !== 0) throw new Error('Page ' + (box.page + 1) + ' is rotated, and rotated pages are not supported yet.');
      const view = page.getCropBox ? page.getCropBox() : page.getMediaBox();
      page.drawSvgPath(inkPath(placed, look), {
        x: view.x + box.x - placed.dx * placed.K,
        y: view.y + view.height - (box.y - placed.dy * placed.K),
        scale: placed.K,
        color: PDFLib.rgb(r, g, b),
        borderWidth: 0,
      });
    }
    return doc.save();
  }

  /** A PDF with one page that is the given picture (PNG or JPEG bytes), 612 pt wide, so a photo of a worksheet works like a PDF. */
  async function pdfFromImage(PDFLib, bytes, mime, width, height) {
    const doc = await PDFLib.PDFDocument.create();
    const img = mime === 'image/jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const w = 612;
    const h = (w * height) / width;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    return doc.save();
  }

  // ---- finding the blanks on a page ---------------------------------------------------------------------------------------
  //
  // Works on a picture of the page, not on the PDF's drawing commands, so a scan or a photo of a worksheet works the same
  // as a typed PDF. Two kinds of blank: an answer line (a printed rule or a row of underscores with nothing written on
  // it) and an empty box (any closed outline with nothing inside, which covers table cells too).

  /** Ink map of a page picture: 1 where a pixel is clearly darker than the paper around it. Comparing with the local
   * paper colour, not a fixed grey, is what lets a photo with a shadow across it work. */
  function inkMap(img) {
    const W = img.width;
    const H = img.height;
    const d = img.data;
    const rgba = d.length === W * H * 4;
    const g = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = rgba ? (d[j] * 3 + d[j + 1] * 6 + d[j + 2]) / 10 : d[i];
    // paper colour: the brightest pixel in each block, then the brightest of the blocks around it
    const B = 24;
    const bw = Math.ceil(W / B);
    const bh = Math.ceil(H / B);
    const blk = new Uint8Array(bw * bh);
    for (let y = 0; y < H; y++) {
      const row = ((y / B) | 0) * bw;
      for (let x = 0; x < W; x++) {
        const k = row + ((x / B) | 0);
        if (g[y * W + x] > blk[k]) blk[k] = g[y * W + x];
      }
    }
    const paper = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        for (let yy = Math.max(0, by - 1); yy <= Math.min(bh - 1, by + 1); yy++) {
          for (let xx = Math.max(0, bx - 1); xx <= Math.min(bw - 1, bx + 1); xx++) m = Math.max(m, blk[yy * bw + xx]);
        }
        paper[by * bw + bx] = m;
      }
    }
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = ((y / B) | 0) * bw;
      for (let x = 0; x < W; x++) {
        const p = paper[row + ((x / B) | 0)];
        if (g[y * W + x] < 0.78 * p && p > 90) ink[y * W + x] = 1;
      }
    }
    return ink;
  }

  /** Share of ink pixels in a rectangle of the ink map (pixel coordinates, clipped to the picture). */
  function inkShare(ink, W, H, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(W, Math.round(x1));
    y1 = Math.min(H, Math.round(y1));
    if (x1 <= x0 || y1 <= y0) return 0;
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += ink[y * W + x];
    return n / ((x1 - x0) * (y1 - y0));
  }

  /** Thin horizontal strokes at least minLen pixels long: [{x0, x1, y0, y1}] (y1 inclusive). */
  function horizontalRules(ink, W, H, minLen, gap, maxThick) {
    const open = []; // groups still being extended downwards
    const done = [];
    for (let y = 0; y < H; y++) {
      const runs = [];
      let x = 0;
      while (x < W) {
        if (!ink[y * W + x]) {
          x++;
          continue;
        }
        const start = x;
        let end = x;
        let miss = 0;
        for (x++; x < W; x++) {
          if (ink[y * W + x]) {
            end = x;
            miss = 0;
          } else if (++miss > gap) break;
        }
        if (end - start + 1 >= minLen) runs.push({ x0: start, x1: end });
      }
      const next = [];
      for (const r of runs) {
        // the same rule seen on the row above: the runs mostly overlap
        const g = open.find((o) => o.y1 === y - 1 && !o.used && Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0.8 * Math.min(o.x1 - o.x0, r.x1 - r.x0));
        if (g) {
          g.used = true;
          g.y1 = y;
          g.x0 = Math.min(g.x0, r.x0);
          g.x1 = Math.max(g.x1, r.x1);
          next.push(g);
        } else next.push({ x0: r.x0, x1: r.x1, y0: y, y1: y, used: true });
      }
      for (const o of open) if (!next.includes(o)) done.push(o);
      for (const n of next) n.used = false;
      open.length = 0;
      open.push(...next);
    }
    done.push(...open);
    return done.filter((r) => r.y1 - r.y0 + 1 <= maxThick).map(({ x0, x1, y0, y1 }) => ({ x0, x1, y0, y1 }));
  }

  /** Does ink run straight down (dir 1) or up (dir -1) from (x, y) for at least len pixels, within a couple of pixels
   * either side? */
  function stem(ink, W, H, x, y, len, dir) {
    let n = 0;
    for (let k = 0, yy = y; k < len && yy >= 0 && yy < H; k++, yy += dir) {
      let hit = false;
      for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2) && !hit; xx++) hit = ink[yy * W + xx] === 1;
      if (!hit) break;
      n++;
    }
    return n >= len;
  }

  /** Closed outlines with nothing inside: white regions that do not reach the edge of the page and fill their own
   * bounding rectangle. Returns pixel rectangles [{x0, y0, x1, y1}] of the inside. */
  function emptyBoxes(ink, W, H, s) {
    const label = new Int32Array(W * H);
    const queue = new Int32Array(W * H);
    const out = [];
    let next = 1;
    for (let start = 0; start < W * H; start++) {
      if (ink[start] || label[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      label[start] = next;
      let x0 = W;
      let x1 = 0;
      let y0 = H;
      let y1 = 0;
      let area = 0;
      let edge = false;
      while (head < tail) {
        const i = queue[head++];
        const x = i % W;
        const y = (i - x) / W;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        if (x > 0 && !ink[i - 1] && !label[i - 1]) (label[i - 1] = next), (queue[tail++] = i - 1);
        if (x < W - 1 && !ink[i + 1] && !label[i + 1]) (label[i + 1] = next), (queue[tail++] = i + 1);
        if (y > 0 && !ink[i - W] && !label[i - W]) (label[i - W] = next), (queue[tail++] = i - W);
        if (y < H - 1 && !ink[i + W] && !label[i + W]) (label[i + W] = next), (queue[tail++] = i + W);
      }
      next++;
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      if (edge || w < 36 * s || h < 14 * s) continue;
      if (w * h > 0.5 * W * H) continue; // a frame around the whole page is not an answer box
      if (area < 0.9 * w * h) continue; // not a plain rectangle, or something is written in it
      const m = 2 * s;
      if (inkShare(ink, W, H, x0 + m, y0 + m, x1 - m, y1 - m) > 0.002) continue;
      out.push({ x0, y0, x1, y1 });
    }
    return out;
  }

  /**
   * The blanks on one page. img: {data, width, height}, with data RGBA (from a canvas) or one grey byte per pixel.
   * s: pixels per point of the picture. Returns [{kind: 'line' | 'box', x, y, w, h}] in points from the top-left of the
   * page, already shaped as an answer box: a line's box sits on the line, a box's is its inside.
   */
  function findBlanks(img, s) {
    const W = img.width;
    const H = img.height;
    const ink = inkMap(img);
    const found = [];

    const boxes = emptyBoxes(ink, W, H, s);
    for (const b of boxes) {
      const inset = 3;
      found.push({ kind: 'box', x: b.x0 / s + inset, y: b.y0 / s + inset, w: (b.x1 - b.x0 + 1) / s - 2 * inset, h: (b.y1 - b.y0 + 1) / s - 2 * inset });
    }

    const rules = horizontalRules(ink, W, H, Math.round(30 * s), Math.max(1, Math.round(0.75 * s)), Math.round(3 * s) + 1);
    for (const r of rules) {
      // an edge of a box found above is already offered as that box
      const onBox = boxes.some((b) => (Math.abs(r.y0 - b.y1) <= 4 * s || Math.abs(r.y1 - b.y0) <= 4 * s) && Math.min(r.x1, b.x1) - Math.max(r.x0, b.x0) > 0.5 * (r.x1 - r.x0));
      if (onBox) continue;
      // the top or bottom of a frame or a table, not a line to write on: both its ends turn down, or both turn up
      const len = Math.round(8 * s);
      if (stem(ink, W, H, r.x0, r.y1 + 1, len, 1) && stem(ink, W, H, r.x1, r.y1 + 1, len, 1)) continue;
      if (stem(ink, W, H, r.x0, r.y0 - 1, len, -1) && stem(ink, W, H, r.x1, r.y0 - 1, len, -1)) continue;
      // something is already written on it (or it underlines a heading)
      if (inkShare(ink, W, H, r.x0, r.y0 - 18 * s, r.x1 + 1, r.y0 - 2 * s) > 0.006) continue;
      // how much room there is above it, for the height of the box
      let room = 40;
      for (let k = Math.round(2 * s); k <= 40 * s; k++) {
        if (inkShare(ink, W, H, r.x0, r.y0 - k - 1, r.x1 + 1, r.y0 - k) > 0.02) {
          room = k / s;
          break;
        }
      }
      const h = clamp(room - 3, 14, 28);
      const lineY = r.y0 / s;
      found.push({ kind: 'line', x: r.x0 / s + 1, y: lineY - h, w: (r.x1 - r.x0 + 1) / s - 2, h });
    }
    found.sort((a, b) => a.y + a.h - (b.y + b.h) || a.x - b.x);
    return found;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  const api = { layoutBox, writeInk, inkPath, pdfFromImage, hexToRgb, findBlanks, DEFAULT_XH_PT, MIN_XH_PT, ENGINE_XH };
  root.HW = root.HW || {};
  root.HW.sheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

},
"src/synth.js": function (module, exports, __req) {
/*
 * Text to pen strokes. A small beam search picks recorded letters for each word (letters that
 * were written side by side get a bonus, repeats a penalty), joins are bridged with a smooth
 * curve, and a slow deformation adds drift. Letters are only moved, never rotated or scaled
 * one by one, so the pen path stays intact.
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? __req("src/geometry.js") : root.HW.geometry;
  const S = typeof require !== 'undefined' ? __req("src/style.js") : root.HW.style;
  const A = typeof require !== 'undefined' ? __req("src/align.js") : root.HW.align;

  const STEP = A.STEP;
  const TRIM = 0.12; // how much of each half-ligature is replaced by the bridge
  const BEAM = 6;

  // ---- unit selection -------------------------------------------------------------------

  const MIN_TURN_RADIUS = 0.06; // x-heights; tightest curve a bridge may make

  function angleBetween(a, b) {
    const dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy));
    return Math.acos(dot);
  }

  function angleDiff(a, b) {
    let d = Math.abs(Math.atan2(a.dy, a.dx) - Math.atan2(b.dy, b.dx));
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  function transCost(prev, cand) {
    if (!prev) return 0;
    const p = prev.unit;
    const u = cand.unit;
    if (prev.scale === 1 && cand.scale === 1 && p.wid === u.wid && u.idx === p.idx + 1) return -0.5;
    const pm = p.exit.mid && prev.scale === 1;
    const um = u.entry.mid && cand.scale === 1;
    if (pm && um) {
      const dy = Math.abs(p.exit.y - u.entry.y);
      // an end that is heading *down* at the join can't be bridged without a hairpin
      const down = Math.max(0, -p.exit.dy - 0.15) + Math.max(0, -u.entry.dy - 0.15);
      return 1.5 * dy + 0.8 * angleDiff(p.exit, u.entry) + 4 * down + (dy > 0.6 ? 3 : 0);
    }
    if (pm || um) return 0.7;
    return 0.05;
  }

  function pickSubset(list, k, rng) {
    if (list.length <= k) return list;
    const a = list.slice();
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (a.length - i));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a.slice(0, k);
  }

  /** chars: array of single characters (already normalised). Returns [{unit, scale}] */
  /**
   * pins (optional): one unit id (or null) per character. A pinned character uses exactly that
   * example, which is how a page keeps every letter it had when only one letter is replaced.
   */
  function chooseUnits(style, chars, rng, ctx, pins) {
    const variation = ctx.variation;
    let beams = [{ cost: 0, seq: [] }];
    const n = chars.length;
    for (let j = 0; j < n; j++) {
      const fb = S.fallbackFor(style, chars[j]);
      if (!fb) {
        ctx.missing.add(chars[j]);
        continue;
      }
      const pinned = pins && pins[j] && style.unitById ? style.unitById.get(pins[j]) : null;
      const usePin = !!pinned && pinned.ch === fb.ch && !pinned.skipped;
      const base = usePin ? [pinned] : pickSubset(style.byChar.get(fb.ch), 24, rng);
      const next = [];
      for (const h of beams) {
        const prev = h.seq.length ? h.seq[h.seq.length - 1] : null;
        let list = base;
        if (!usePin && prev && prev.scale === 1 && fb.scale === 1) {
          const nat = prev.unit.word.units[prev.unit.idx + 1];
          if (nat && nat.ch === fb.ch && !nat.skipped && !list.includes(nat)) list = list.concat([nat]); // never one the writer crossed out
        }
        for (const unit of list) {
          const cand = { unit, scale: fb.scale };
          let c = h.cost + transCost(prev, cand);
          if (!prev && unit.entry.mid) c += 2;
          if (j === n - 1 && unit.exit.mid) c += 0.6;
          c += 2.5 * Math.min(unit.hc || 0, 3); // implausible shape for this character (mis-cut)
          c += 2 * (unit.odd || 0); // looks unlike the writer's other examples of this letter
          if (unit.word.suspect) c += 1.5; // taken from a word the aligner was unsure about
          if (unit.wrong) c += 2; // looks more like a different letter than this one (probably cut in the wrong place)
          if (unit.iso) {
            // Written on its own, so never mis-cut. Digits and symbols cut out of words are mis-cut far more often
            // than letters (a 9 comes out as a hook, a 1 picks up a stroke from its neighbour) and a single digit has
            // no run-in stroke to give it away, so the writer's own are strongly preferred. A lowercase letter carries
            // a run-in stroke the writer only makes when it stands alone, so it is kept to the start of a word.
            const neat = ctx.neat || 0; // 0..3: how much cleaner single letters are preferred over cut-out ones
            if (!/[A-Za-z]/.test(chars[j])) c -= 2.5;
            else if (j === 0 || n === 1) c -= 0.5 + 0.3 * neat;
            else if (/[a-z]/.test(chars[j])) c += 1.5 - neat;
          }
          if (unit.stray) c += 3; // carries a scrap of a neighbouring letter
          if (unit.open) c += 2.5; // the writer closes this letter, this copy stays open (cut wrongly?)
          c += 1.5 * (unit.far || 0); // unlike the writer's own single-letter version of it
          c += 4 * Math.min(Math.max(0, (unit.dev || 0) - 0.25), 1.5); // much taller / deeper than this writer usually writes it
          let rep = 0;
          for (const s of h.seq) if (s.unit === unit) rep++;
          c += variation * 1.2 * rep + variation * 0.12 * (ctx.usage.get(unit.id) || 0);
          c += rng() * 0.35 * variation;
          next.push({ cost: c, seq: h.seq.concat([cand]) });
        }
      }
      next.sort((a, b) => a.cost - b.cost);
      beams = next.slice(0, BEAM);
    }
    const best = beams[0].seq;
    for (const s of best) ctx.usage.set(s.unit.id, (ctx.usage.get(s.unit.id) || 0) + 1);
    return best;
  }

  // ---- assembly -------------------------------------------------------------------------

  function trimEnd(pts, len) {
    let acc = 0;
    while (pts.length > 4) {
      const d = G.dist(pts[pts.length - 1], pts[pts.length - 2]);
      if (acc + d > len) break;
      acc += d;
      pts.pop();
    }
  }

  function trimStart(pts, len) {
    let acc = 0;
    let cut = 0;
    while (pts.length - cut > 4) {
      const d = G.dist(pts[cut], pts[cut + 1]);
      if (acc + d > len) break;
      acc += d;
      cut++;
    }
    if (cut) pts.splice(0, cut);
  }

  const MAX_JOIN_TURN = 60; // degrees; a bridge that bends more than this becomes a pen lift instead

  /**
   * Join the end of stroke `aIn` to the start of `bIn` with a smooth bridge. Works on copies.
   * Returns {a, b, bridge} or null when the join would bend sharply (then the caller lifts the
   * pen, as a real writer would, instead of drawing a kink).
   */
  function bridgeJoin(aIn, bIn) {
    const a = aIn.slice();
    const b = bIn.slice();
    trimEnd(a, TRIM);
    trimStart(b, TRIM);
    // The bridge needs enough length for the pen to make its turn at a sensible radius.
    // If the two ends are too close for the direction change between them, trim further
    // back on both sides until they are not.
    let p0;
    let p1;
    let t0;
    let t1;
    for (let tries = 0; tries < 10; tries++) {
      p0 = a[a.length - 1];
      p1 = b[0];
      t0 = G.dirAt(a, a.length - 1, 3);
      t1 = G.dirAt(b, 0, 3);
      const d = G.dist(p0, p1);
      const c = d > 1e-6 ? { dx: (p1.x - p0.x) / d, dy: (p1.y - p0.y) / d } : t0;
      const turn = Math.max(angleBetween(t0, c), angleBetween(c, t1));
      if (d >= MIN_TURN_RADIUS * turn || tries === 9) break;
      trimEnd(a, 0.05);
      trimStart(b, 0.05);
    }
    const bridge = G.hermite(p0, t0, p1, t1, STEP);
    if (G.maxTurnDeg(a.slice(-2).concat(bridge, b.slice(0, 2))) > MAX_JOIN_TURN) return null;
    return { a, b, bridge };
  }

  function assemble(choices, liftGap, clearance, rng) {
    const out = [];
    const joins = []; // where letters were bridged (kept so tests can check the joins are smooth)
    const marks = [];
    let prev = null;
    const spans = []; // where each letter's ink starts and ends, along the word
    for (const ch of choices) {
      const u = ch.unit;
      const sc = ch.scale;
      let conn = !!prev && prev.unit.exit.mid && u.entry.mid && prev.sc === 1 && sc === 1;
      const natural = !!prev && prev.sc === 1 && sc === 1 && prev.unit.wid === u.wid && u.idx === prev.unit.idx + 1;
      let tx;
      let bridged = null;
      if (!prev) tx = -u.box.minX * sc;
      else if (natural) tx = prev.tx;
      else {
        if (conn) {
          tx = prev.tx + prev.unit.exit.x - u.entry.x;
          bridged = bridgeJoin(prev.lastStroke.pts, u.strokes[0].pts.map((p) => ({ x: tx + p.x * sc, y: p.y * sc, w: p.w })));
          if (!bridged) conn = false; // no clean join between these two: lift the pen
        }
        if (!conn) {
          const base = prev.sc === 1 && sc === 1 ? A.inkBase(prev.unit, u) : null;
          const byBox = prev.tx + prev.unit.box.maxX * prev.sc + liftGap - u.box.minX * sc;
          if (clearance && base !== null) {
            // nearest ink of the two letters ends up `want` apart, which varies a little like the writer's does
            let want = Math.max(0.02, clearance.median + clearance.sd * 0.5 * G.gaussian(rng));
            // a decimal point squeezed against its digits turns 71.45 into 7145
            if ((prev.unit.ch === '.' && /[0-9]/.test(u.ch)) || (u.ch === '.' && /[0-9]/.test(prev.unit.ch))) want = Math.max(want, 0.2);
            tx = prev.tx + want - base;
          } else tx = byBox;
        }
      }

      const T = (p) => ({ x: tx + p.x * sc, y: p.y * sc, w: p.w });
      let lastStroke = null;
      for (let pi = 0; pi < u.strokes.length; pi++) {
        const piece = u.strokes[pi];
        const pts = piece.pts.map(T);
        let stroke = null;
        if (pi === 0 && natural && piece.entryMid) {
          stroke = prev.lastStroke;
          for (let k = 1; k < pts.length; k++) stroke.pts.push(pts[k]);
        } else if (pi === 0 && conn) {
          stroke = prev.lastStroke;
          const at = bridged.a.length - 1;
          stroke.pts = bridged.a.concat(bridged.bridge, bridged.b);
          joins.push({ stroke, from: at, to: at + bridged.bridge.length + 1 });
        } else {
          stroke = { pts, taperStart: 0, taperEnd: 0 };
          if (pi === 0) {
            if (piece.entryMid) {
              trimStart(stroke.pts, TRIM);
              stroke.taperStart = 0.18;
            }
            if (prev && prev.unit.exit.mid && prev.lastStroke.taperEnd === 0) {
              trimEnd(prev.lastStroke.pts, TRIM);
              prev.lastStroke.taperEnd = 0.18;
            }
          }
          out.push(stroke);
        }
        lastStroke = stroke;
      }
      for (const m of u.marks) marks.push({ pts: m.pts.map(T), taperStart: 0, taperEnd: 0, delayed: true });
      let lo = Infinity;
      let hi = -Infinity;
      for (const piece of u.strokes.concat(u.marks)) {
        for (const p of piece.pts) {
          const x = tx + p.x * sc;
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      }
      spans.push([lo, hi]);
      prev = { unit: u, sc, tx, lastStroke };
    }
    // a dangling connected tail at the very end of the word
    if (prev && prev.unit.exit.mid) {
      trimEnd(prev.lastStroke.pts, TRIM);
      prev.lastStroke.taperEnd = 0.18;
    }
    const all = out.concat(marks);
    for (const s of all) {
      if (s.pts.length >= 5) s.pts = G.smooth(s.pts, 1.6, ['w']);
    }
    // safety net: extra smoothing that fades in only around each bridge
    const strokeJoins = new Map();
    for (const j of joins) {
      if (!strokeJoins.has(j.stroke)) strokeJoins.set(j.stroke, []);
      strokeJoins.get(j.stroke).push(j);
    }
    for (const [stroke, list] of strokeJoins) {
      const n = stroke.pts.length;
      if (n < 8) continue;
      const wide = G.smooth(stroke.pts, 3);
      const w = new Float64Array(n);
      const HALF = 7;
      for (const j of list) {
        for (let i = Math.max(0, j.from - HALF); i <= Math.min(n - 1, j.to + HALF); i++) {
          const d = i < j.from ? j.from - i : i > j.to ? i - j.to : 0;
          const v = 0.5 + 0.5 * Math.cos((Math.PI * d) / (HALF + 1));
          if (v > w[i]) w[i] = v;
        }
      }
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        stroke.pts[i].x += (wide[i].x - stroke.pts[i].x) * w[i];
        stroke.pts[i].y += (wide[i].y - stroke.pts[i].y) * w[i];
      }
    }
    all.joins = joins;
    all.spans = spans;
    return all;
  }

  // ---- natural imperfection -------------------------------------------------------------

  function deform(strokes, rng, m, wordLevel) {
    if (m <= 0) return;
    const nY = G.makeNoise(rng);
    const nS = G.makeNoise(rng);
    const nT = G.makeNoise(rng);
    // per-word offset and size are replaced by the writer's measured line rhythm when we have it
    const off = wordLevel === false ? 0 : (rng() * 2 - 1) * 0.05 * m;
    const gs = wordLevel === false ? 1 : 1 + G.gaussian(rng) * 0.025 * m;
    for (const s of strokes) {
      for (const p of s.pts) {
        const u = p.x;
        const size = gs * (1 + 0.035 * m * nS(u / 2.2));
        const dy = 0.05 * m * nY(u / 1.4) + off;
        const sh = 0.06 * m * nT(u / 3);
        const x = p.x;
        const y = p.y;
        p.x = x * gs + y * sh;
        p.y = y * size + dy;
      }
    }
  }

  function bounds(strokes) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const s of strokes) for (const p of s.pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    return { minX, maxX };
  }

  function expandChars(word) {
    const out = [];
    for (const c of Array.from(word)) for (const d of Array.from(S.normalizeChar(c))) out.push(d);
    return out;
  }

  /**
   * If the writer wrote this very word, pins for its letters so it is written back from their real strokes (the
   * letters of a recorded word fit each other, and none of them can have been cut wrongly out of a *different*
   * word). A word is pasted less and less willingly the more it has already been used on the page, and the
   * least-used recorded copy goes first, so a page does not repeat itself. Returns null to write the word fresh.
   */
  function wholeWordPins(style, chars, rng, ctx) {
    const reuse = ctx.wordReuse || 0;
    if (!reuse || !style.wholeWords) return null;
    const core = chars.join('').replace(/[.,!?;:]+$/, '');
    const found = style.wholeWords.get(core);
    if (!found || !found.length) return null;
    if (!ctx.wordUse) ctx.wordUse = new Map();
    let best = null;
    for (const w of found) {
      const used = ctx.wordUse.get(w) || 0;
      if (!best || used < best.used || (used === best.used && rng() < 0.5)) best = { w, used };
    }
    if (rng() >= reuse * Math.pow(0.55, best.used)) return null;
    ctx.wordUse.set(best.w, best.used + 1);
    return chars.map((_, i) => (i < core.length ? best.w.units[i].id : null));
  }

  /**
   * One word -> strokes in engine units (x from 0, baseline 0, x-height 1, no global slant).
   * A word takes one number from `rng` and makes its own streams from it, one for picking letters and
   * one for everything after (spacing, wobble), so what happens to one word cannot change another.
   * pins: see chooseUnits.
   */
  function synthWord(style, word, rng, ctx, pins) {
    const chars = expandChars(word).filter((c) => !/\s/.test(c));
    const seed = Math.floor(rng() * 4294967296) >>> 0;
    if (!chars.length) return null;
    const crng = G.mulberry32(seed);
    // a word the writer wrote is written back as they wrote it, unless the page has asked for specific letters
    const use = pins || wholeWordPins(style, chars, crng, ctx);
    const choices = chooseUnits(style, chars, crng, ctx, use);
    if (!choices.length) return null;
    const arng = G.mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const strokes = assemble(choices, style.liftGap, style.clearance, arng);
    const spans = strokes.spans;
    deform(strokes, arng, ctx.messiness, !ctx.rhythm);
    const b = bounds(strokes);
    for (const s of strokes) for (const p of s.pts) p.x -= b.minX;
    return { strokes, width: b.maxX - b.minX, joins: strokes.joins, choices, spans: spans.map(([lo, hi]) => [lo - b.minX, hi - b.minX]) };
  }

  // ---- page layout ----------------------------------------------------------------------

  /**
   * opts: {xh (px), width (px), lineHeight (x-heights), wordSpacing, messiness 0..1,
   *        neatness 0..1 (how much the writer's clean single letters are preferred over letters cut out of words),
   *        wordReuse 0..1 (how willingly a word the writer wrote is written back from their real strokes), variation 0..1, slantDelta (deg), seed, margin (px)}
   * returns {width, height, strokes:[{pts:[{x,y,w}], taperStart, taperEnd}], missing:[...], baselines:[...]}
   */
  function layout(style, text, opts) {
    const o = Object.assign(
      { xh: 34, width: 900, lineHeight: 3.1, wordSpacing: 1, messiness: 0.3, variation: 0.4, slantDelta: 0, seed: 1, wordReuse: 0.25, neatness: 0.5 },
      opts || {}
    );
    const rng = G.mulberry32(o.seed);
    // The writer's own line rhythm (word gaps, baseline / size / slant drift), when they have
    // written full lines. The Natural variation slider scales it: 30% (the default) is exactly as
    // measured, 0 is none, above 30% exaggerates.
    const R = style.rhythm && style.rhythm.learned ? style.rhythm : null;
    const k = R ? Math.min(3.5, Math.max(0, o.messiness / 0.3)) : 0;
    const ctx = { variation: o.variation, messiness: o.messiness, usage: new Map(), missing: new Set(), rhythm: !!R, wordReuse: o.wordReuse, wordUse: new Map(), neat: 4 * o.neatness };
    const xh = o.xh;
    const margin = o.margin != null ? o.margin : xh * 1.2;
    const lineH = o.lineHeight * xh;
    const tanS = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180);
    const spaceW = 0.6 * xh * o.wordSpacing;
    const firstBase = margin + 1.7 * xh;

    const strokesOut = [];
    const wordsOut = [];
    const baselines = [];
    let line = 0;
    let x = margin;
    const pickSlope = () => (R ? Math.tan(R.slopeSd * k * G.gaussian(rng)) : (rng() * 2 - 1) * 0.006 * o.messiness);
    let slope = pickSlope();
    let wordOff = 0;
    let sizeState = 0; // log scale of the current word, drifts like the writer's does
    baselines.push(firstBase);
    // AR(1): next = rho * previous + noise, so drift is smooth along the line instead of jumping
    const ar = (prev, rho, sd) => rho * prev + Math.sqrt(1 - rho * rho) * sd * G.gaussian(rng);

    const newLine = () => {
      line++;
      x = margin;
      slope = pickSlope();
      wordOff = 0;
      sizeState = 0;
      baselines.push(firstBase + line * lineH);
    };

    let wordNo = 0;
    const paragraphs = text.replace(/\r/g, '').split('\n');
    paragraphs.forEach((para, pi) => {
      if (pi > 0) newLine();
      const words = para.split(/[ \t]+/).filter(Boolean);
      for (const word of words) {
        const pinsForWord = o.pins ? o.pins[wordNo] : null;
        wordNo++;
        const w = synthWord(style, word, rng, ctx, pinsForWord);
        if (!w) {
          wordsOut.push(null); // keeps the numbering of words, so pins stay lined up
          continue;
        }
        // to pixels, with slant (and, from the writer's rhythm, this word's own size and slant)
        let sc = 1;
        let tanW = tanS;
        if (R) {
          sizeState = ar(sizeState, R.sizeRho, R.sizeSd * k);
          sc = Math.exp(sizeState);
          tanW = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180 + R.slantSd * k * G.gaussian(rng));
        }
        const pxStrokes = w.strokes.map((s) => ({
          taperStart: s.taperStart,
          taperEnd: s.taperEnd,
          pts: s.pts.map((p) => ({ x: (p.x + p.y * tanW) * xh * sc, y: -p.y * xh * sc, w: p.w })),
        }));
        const b = bounds(pxStrokes);
        const wpx = b.maxX - b.minX;
        if (x > margin && x + wpx > o.width - margin) newLine();
        if (R) wordOff = ar(wordOff / xh, R.baseRho, R.baseSd * k) * xh;
        else wordOff = wordOff * 0.7 + (rng() * 2 - 1) * 0.035 * xh * o.messiness;
        const base = baselines[line] + slope * (x - margin) + wordOff;
        const dx = x - b.minX;
        for (const s of pxStrokes) {
          for (const p of s.pts) {
            p.x += dx;
            p.y += base;
          }
          strokesOut.push(s);
        }
        // where each letter ended up on the page, so a tap can be traced back to the example that drew it
        wordsOut.push({
          text: word,
          choices: w.choices.map((c) => c.unit),
          ids: w.choices.map((c) => c.unit.id),
          spans: w.spans.map(([lo, hi]) => [(lo + 0.5 * tanW) * xh * sc + dx, (hi + 0.5 * tanW) * xh * sc + dx]),
          top: base - 2.7 * xh * sc,
          bottom: base + 1.3 * xh * sc,
        });
        // a gap is never tiny (it would read as one word), and a little wider after . , ! ? ; :
        const floor = /[.,!?;:]$/.test(word) ? 0.4 : 0.28;
        const gap = R ? Math.max(floor, R.gapMean + R.gapSd * k * G.gaussian(rng)) * xh * o.wordSpacing : spaceW * (0.85 + 0.3 * rng());
        x += wpx + gap;
      }
    });

    const height = baselines[baselines.length - 1] + 1.5 * xh + margin * 0.5;
    return { width: o.width, height, strokes: strokesOut, words: wordsOut, missing: Array.from(ctx.missing), baselines, xh, lineHeightPx: lineH };
  }

  const api = { layout, synthWord, chooseUnits, assemble, deform };
  root.HW = root.HW || {};
  root.HW.synth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

},
"src/math.js": function (module, exports, __req) {
/*
 * Math mode: lays out TeX-style input (x^2, x_1, \frac{a}{b}, \sqrt{x}, \lim_{x \to 0}, \int_0^1,
 * \sum_{i=1}^n, brackets that stretch to fit) using the writer's own letters and symbols.
 * A symbol the writer has not written yet is drawn as a plain hand-wobbled stand-in.
 *
 * Boxes are in engine units: x from 0, y up from the baseline, x-height = 1.
 */
(function (root) {
  'use strict';

  const G = typeof require !== 'undefined' ? __req("src/geometry.js") : root.HW.geometry;
  const Y = typeof require !== 'undefined' ? __req("src/synth.js") : root.HW.synth;

  // ---- reading the input ----------------------------------------------------------------------

  const COMMANDS = {
    to: '→', rightarrow: '→', infty: '∞', pi: 'π', theta: 'θ', alpha: 'α', beta: 'β', lambda: 'λ', mu: 'μ',
    sigma: 'σ', phi: 'φ', omega: 'ω', Delta: 'Δ', partial: '∂', le: '≤', leq: '≤', ge: '≥', geq: '≥',
    ne: '≠', neq: '≠', approx: '≈', pm: '±', times: '×', cdot: '·', div: '÷', prime: "'",
  };
  const TEXT_COMMANDS = new Set(['text', 'textrm', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mbox', 'operatorname']);
  // widths, in x-heights, of the spaces TeX has names for (a plain space between things is ignored, as in TeX)
  const SPACES = { ' ': 0.8, ',': 0.45, ';': 0.6, ':': 0.5, quad: 1.2, qquad: 2.4 };
  const spaceOf = (k) => (Object.prototype.hasOwnProperty.call(SPACES, k) ? SPACES[k] : undefined);
  const WORDS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det']);
  const RELATIONS = new Set(['=', '<', '>', '≤', '≥', '≠', '≈', '→']);
  const BINARY = new Set(['+', '-', '×', '÷', '±', '·', '*']);
  // One quick sample of these tends to look like a scribble, so wait for two before using the writer's own
  const OPERATORS = new Set(['+', '-', '=', '<', '>', '≤', '≥', '≠', '≈', '±', '×', '÷', '·', '→']);
  const OPEN = new Set(['(', '[', '{']);
  const CLOSE = new Set([')', ']', '}']);

  function tokenize(src) {
    const s = src.replace(/\r/g, '').replace(/->/g, '→').replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/!=/g, '≠').replace(/\+-/g, '±');
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') {
        out.push({ k: 'nl' });
        i++;
      } else if (/[ \t]/.test(c)) {
        while (i < s.length && /[ \t]/.test(s[i])) i++;
        out.push({ k: 'sp' });
      } else if (c === '\\') {
        if (s[i + 1] === '\\') {
          out.push({ k: 'nl' });
          i += 2;
        } else if (/[A-Za-z]/.test(s[i + 1] || '')) {
          let j = i + 1;
          while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
          const name = s.slice(i + 1, j);
          i = j;
          if (TEXT_COMMANDS.has(name)) {
            // \text{some words}: the braces hold plain text, written as it is (spaces count, commands do not)
            let k = i;
            while (k < s.length && /[ \t]/.test(s[k])) k++;
            if (s[k] === '{') {
              let depth = 0;
              let e = k;
              for (; e < s.length; e++) {
                if (s[e] === '{') depth++;
                else if (s[e] === '}' && --depth === 0) break;
              }
              out.push({ k: 'text', v: s.slice(k + 1, e) });
              i = Math.min(s.length, e + 1);
              continue;
            }
          }
          if (spaceOf(name) !== undefined) out.push({ k: 'gap', v: spaceOf(name) });
          else out.push({ k: 'cmd', v: name });
        } else if (spaceOf(s[i + 1]) !== undefined) {
          out.push({ k: 'gap', v: spaceOf(s[i + 1]) }); // "\ " is a space that stays, like \, and \;
          i += 2;
        } else if (s[i + 1] === '!' || i + 1 >= s.length) {
          i += 2;
        } else {
          out.push({ k: 'ch', v: s[i + 1] }); // \% \$ \{ and so on: the character itself
          i += 2;
        }
      } else if (c === '{' || c === '}' || c === '^' || c === '_') {
        out.push({ k: c });
        i++;
      } else if (c === '√' || c === '∛') {
        out.push({ k: 'cmd', v: c === '√' ? 'sqrt' : 'cbrt' });
        i++;
      } else if (/[A-Za-z0-9.']/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9.']/.test(s[j])) j++;
        const word = s.slice(i, j);
        const root = /^(sqrt|cbrt|cubert|cuberoot)(\d[\d.]*)?$/i.exec(word); // typed as words: sqrt(x), cubert 8
        if (root) {
          out.push({ k: 'cmd', v: root[1].toLowerCase() === 'sqrt' ? 'sqrt' : 'cbrt' });
          if (root[2]) out.push({ k: 'run', v: root[2] });
        } else out.push({ k: 'run', v: word });
        i = j;
      } else {
        out.push({ k: 'ch', v: c });
        i++;
      }
    }
    return out;
  }

  /** Tokens -> lines of nodes. A node is {t, ...} with optional .sup / .sub (each a node list). */
  function parse(src) {
    const toks = tokenize(src);
    let i = 0;

    function skipSpace() {
      while (i < toks.length && toks[i].k === 'sp') i++;
    }

    function group() {
      // expects toks[i] to be '{'
      i++;
      const nodes = seq(true);
      if (i < toks.length && toks[i].k === '}') i++;
      return nodes;
    }

    function arg() {
      skipSpace();
      if (i < toks.length && toks[i].k === '{') return group();
      const a = atom(true);
      return a ? [a] : [];
    }

    // parsing can be limited to the tokens before `end`, for sqrt(...) and \sqrt[3]{...}
    let end = Infinity;
    function until(close) {
      // tokens up to the matching close bracket, parsed as a row; leaves i after it
      let depth = 0;
      let j = i;
      for (; j < toks.length; j++) {
        if (toks[j].k === 'ch' && toks[j].v === (close === ')' ? '(' : '[')) depth++;
        else if (toks[j].k === 'ch' && toks[j].v === close && depth-- === 0) break;
      }
      const saved = end;
      end = j;
      const nodes = seq(false);
      end = saved;
      i = Math.min(toks.length, j + 1);
      return nodes;
    }

    function atom(noScripts) {
      skipSpace();
      const t = toks[i];
      if (!t || i >= end || t.k === '}' || t.k === 'nl') return null;
      let n = null;
      if (t.k === 'gap') {
        i++;
        return { t: 'gap', w: t.v };
      } else if (t.k === 'text') {
        i++;
        n = { t: 'text', s: t.v };
      } else if (t.k === '{') {
        n = { t: 'group', a: group() };
      } else if (t.k === 'run') {
        i++;
        n = { t: 'run', s: t.v };
      } else if (t.k === 'ch') {
        i++;
        n = { t: 'sym', c: t.v };
      } else if (t.k === 'cmd') {
        i++;
        if (t.v === 'frac') {
          const a = arg();
          const b = arg();
          n = { t: 'frac', a, b };
        } else if (t.v === 'sqrt' || t.v === 'cbrt') {
          let idx = t.v === 'cbrt' ? [{ t: 'run', s: '3' }] : null;
          skipSpace();
          if (!idx && toks[i] && toks[i].k === 'ch' && toks[i].v === '[') {
            i++;
            idx = until(']');
            skipSpace();
          }
          let body;
          if (toks[i] && toks[i].k === 'ch' && toks[i].v === '(') {
            i++;
            body = until(')'); // sqrt(x + 1)
          } else body = arg();
          n = { t: 'sqrt', a: body, idx };
        } else if (t.v === 'int' || t.v === 'sum' || t.v === 'prod') {
          n = { t: 'big', c: t.v === 'int' ? '∫' : t.v === 'sum' ? '∑' : '∏' };
        } else if (t.v === 'left' || t.v === 'right') {
          skipSpace();
          const f = toks[i];
          if (f && f.k === 'ch') i++;
          return f && f.k === 'ch' && f.v !== '.' ? { t: 'sym', c: f.v } : atom();
        } else if (WORDS.has(t.v)) {
          n = { t: 'run', s: t.v };
        } else if (COMMANDS[t.v]) {
          n = { t: 'sym', c: COMMANDS[t.v] };
        } else {
          n = { t: 'run', s: t.v }; // unknown command: write its name
        }
      } else if (t.k === '^' || t.k === '_') {
        n = { t: 'group', a: [] }; // a script with nothing before it
      } else {
        i++;
        return atom(noScripts);
      }
      // scripts: x^2, x_1, x_i^2 (the argument of a script does not take scripts of its own: _0^1)
      while (!noScripts) {
        const save = i;
        skipSpace();
        const nx = toks[i];
        if (nx && nx.k === '^' && !n.sup) {
          i++;
          n.sup = arg();
        } else if (nx && nx.k === '_' && !n.sub) {
          i++;
          n.sub = arg();
        } else {
          i = save;
          break;
        }
      }
      return n;
    }

    function seq(inGroup) {
      const out = [];
      for (;;) {
        skipSpace();
        const t = toks[i];
        if (!t || i >= end || t.k === 'nl' || (inGroup && t.k === '}')) break;
        if (t.k === '}') {
          i++;
          continue;
        }
        const a = atom();
        if (a) out.push(a);
      }
      return out;
    }

    const lines = [];
    for (;;) {
      lines.push(seq(false));
      if (i < toks.length && toks[i].k === 'nl') i++;
      else break;
    }
    return lines;
  }

  // ---- boxes ----------------------------------------------------------------------------------

  const clone = (strokes, dx, dy, sx, sy) =>
    strokes.map((s) => ({
      taperStart: s.taperStart,
      taperEnd: s.taperEnd,
      pts: s.pts.map((p) => ({ x: dx + p.x * sx, y: dy + p.y * sy, w: p.w })),
    }));

  function measure(strokes) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of strokes) {
      for (const p of s.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  /** A box from strokes: shifted so the ink starts at x = 0. */
  function boxOf(strokes, minUp, minDown) {
    if (!strokes.length) return { w: 0, up: minUp || 0, down: minDown || 0, strokes: [] };
    const m = measure(strokes);
    const moved = clone(strokes, -m.minX, 0, 1, 1);
    return { w: m.maxX - m.minX, up: Math.max(minUp || 0, m.maxY), down: Math.max(minDown || 0, -m.minY), strokes: moved };
  }

  const place = (into, box, dx, dy) => {
    for (const s of clone(box.strokes, dx, dy, 1, 1)) into.push(s);
  };

  // ---- the layout engine ----------------------------------------------------------------------

  function createEngine(style, rng, opts) {
    const messiness = opts.messiness;
    const ctx = { variation: opts.variation, messiness, usage: new Map(), missing: new Set(), rhythm: true };
    const sample = Y.synthWord(style, 'x', G.mulberry32(1), { variation: 0, messiness: 0, usage: new Map(), missing: new Set(), rhythm: true });
    const ws = sample ? sample.strokes.flatMap((s) => s.pts.map((p) => p.w)).sort((a, b) => a - b) : [1.2];
    const PEN = ws[ws.length >> 1] || 1.2;

    /** The writer's own writing of `text`, scaled by sc. */
    function written(text, sc) {
      const w = Y.synthWord(style, text, rng, ctx);
      if (!w) return null;
      const jitter = 1 + 0.03 * messiness * G.gaussian(rng);
      return boxOf(clone(w.strokes, 0, 0, sc * jitter, sc * jitter));
    }

    /** A drawn stand-in: polylines in engine units, densified, smoothed and wobbled like handwriting. */
    function drawn(polys, sc) {
      const strokes = [];
      for (const poly of polys) {
        const pts = [];
        for (let i = 0; i < poly.length - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.04));
          for (let k = 0; k < n; k++) pts.push({ x: a[0] + ((b[0] - a[0]) * k) / n, y: a[1] + ((b[1] - a[1]) * k) / n, w: PEN });
        }
        const last = poly[poly.length - 1];
        pts.push({ x: last[0], y: last[1], w: PEN });
        strokes.push({ pts: pts.length >= 5 ? G.smooth(pts, 2, ['w']) : pts, taperStart: 0.12, taperEnd: 0.12 });
      }
      Y.deform(strokes, rng, messiness, false);
      return boxOf(clone(strokes, 0, 0, sc, sc));
    }

    const line = (x0, y0, x1, y1) => [[x0, y0], [x1, y1]];

    /** Hand-drawn glyphs for symbols the writer has not written. */
    function standIn(c, sc, up, down) {
      const U = up === undefined ? 1.8 : up;
      const D = down === undefined ? 0.4 : down;
      const mid = (U - D) / 2;
      switch (c) {
        case '[': return drawn([[[0.35, U], [0, U], [0, -D], [0.35, -D]]], sc);
        case ']': return drawn([[[0, U], [0.35, U], [0.35, -D], [0, -D]]], sc);
        case '{': return drawn([[[0.4, U], [0.2, U - 0.1], [0.2, mid + 0.15], [0, mid], [0.2, mid - 0.15], [0.2, -D + 0.1], [0.4, -D]]], sc);
        case '}': return drawn([[[0, U], [0.2, U - 0.1], [0.2, mid + 0.15], [0.4, mid], [0.2, mid - 0.15], [0.2, -D + 0.1], [0, -D]]], sc);
        case '(': return drawn([[[0.35, U], [0.08, mid + 0.4], [0.08, mid - 0.4], [0.35, -D]]], sc);
        case ')': return drawn([[[0, U], [0.27, mid + 0.4], [0.27, mid - 0.4], [0, -D]]], sc);
        case '|': return drawn([[[0, U], [0.02, -D]]], sc);
        case '<': return drawn([[[0.55, 0.95], [0, 0.5], [0.55, 0.05]]], sc);
        case '>': return drawn([[[0, 0.95], [0.55, 0.5], [0, 0.05]]], sc);
        case '≤': return drawn([[[0.55, 1.0], [0, 0.6], [0.55, 0.2]], line(0, -0.05, 0.55, -0.05)], sc);
        case '≥': return drawn([[[0, 1.0], [0.55, 0.6], [0, 0.2]], line(0, -0.05, 0.55, -0.05)], sc);
        case '=': return drawn([line(0, 0.35, 0.7, 0.35), line(0, 0.7, 0.7, 0.7)], sc);
        case '≠': return drawn([line(0, 0.3, 0.7, 0.3), line(0, 0.65, 0.7, 0.65), line(0.5, 0.95, 0.2, 0.0)], sc);
        case '≈': return drawn([[[0, 0.3], [0.2, 0.45], [0.45, 0.2], [0.7, 0.35]], [[0, 0.65], [0.2, 0.8], [0.45, 0.55], [0.7, 0.7]]], sc);
        case '+': return drawn([line(0, 0.5, 0.7, 0.5), line(0.35, 0.85, 0.35, 0.15)], sc);
        case '-': return drawn([line(0, 0.45, 0.6, 0.45)], sc);
        case '±': return drawn([line(0, 0.7, 0.7, 0.7), line(0.35, 1.05, 0.35, 0.35), line(0, 0.05, 0.7, 0.05)], sc);
        case '×': return drawn([line(0, 0.15, 0.6, 0.85), line(0, 0.85, 0.6, 0.15)], sc);
        case '÷': return drawn([line(0, 0.5, 0.7, 0.5), [[0.35, 0.9], [0.36, 0.92]], [[0.35, 0.1], [0.36, 0.12]]], sc);
        case '·': return drawn([[[0, 0.5], [0.02, 0.52]]], sc);
        case '→': return drawn([line(0, 0.5, 1.0, 0.5), [[0.75, 0.8], [1.0, 0.5], [0.75, 0.2]]], sc);
        case '∞': {
          const p = [];
          for (let i = 0; i <= 40; i++) {
            const t = (i / 40) * 2 * Math.PI;
            p.push([0.5 + 0.5 * Math.sin(t), 0.5 + 0.3 * Math.sin(t) * Math.cos(t)]);
          }
          return drawn([p], sc);
        }
        case '∫': return drawn([[[0.5, 1.9], [0.38, 2.0], [0.28, 1.85], [0.25, 1.4], [0.2, 0.5], [0.15, -0.2], [0.05, -0.65], [-0.08, -0.55]]], sc);
        case '∑': return drawn([[[1.0, 1.5], [0.1, 1.5], [0.7, 0.5], [0.0, -0.45], [1.0, -0.45]]], sc);
        case '∏': return drawn([line(0, 1.5, 1.0, 1.5), line(0.15, 1.5, 0.12, -0.45), line(0.85, 1.5, 0.88, -0.45)], sc);
        default: return null;
      }
    }

    /** A box for a single symbol: the writer's own if they have written it, else a stand-in. */
    function symbol(c, sc, up, down) {
      const have = style.byChar.get(c);
      const mine = have && have.length >= (OPERATORS.has(c) ? 2 : 1) ? written(c, sc) : null;
      if (mine) return mine;
      const stand = standIn(c, sc, up, down);
      if (stand) {
        stand.stand = true; // drawn, not the writer's own
        return stand;
      }
      ctx.missing.add(c);
      return null;
    }

    /** A bracket stretched to cover content from -down up to up (in this box's own scale). */
    function fence(c, sc, up, down) {
      const natural = symbol(c, sc);
      if (!natural) return null;
      const wantUp = up + 0.2 * sc;
      const wantDown = down + 0.2 * sc;
      if (natural.up >= wantUp - 0.05 && natural.down >= wantDown - 0.05) return natural;
      if (natural.stand) return standIn(c, 1, wantUp, wantDown);
      // the writer's own bracket, stretched
      const sy = (wantUp + wantDown) / (natural.up + natural.down);
      const sx = Math.min(1.5, Math.sqrt(sy));
      const strokes = natural.strokes.map((s) => ({
        taperStart: s.taperStart,
        taperEnd: s.taperEnd,
        pts: s.pts.map((p) => ({ x: p.x * sx, y: (p.y + natural.down) * sy - wantDown, w: p.w })),
      }));
      return { w: natural.w * sx, up: wantUp, down: wantDown, strokes };
    }

    return { ctx, written, drawn, standIn, symbol, fence, PEN, line };
  }

  function layoutNodes(E, nodes, sc) {
    const items = [];
    for (const n of nodes) {
      const it = layoutAtom(E, n, sc);
      if (it) items.push(it);
    }
    // brackets stretch to what is inside them
    const stack = [];
    items.forEach((it, idx) => {
      if (it.kind === 'open') stack.push(idx);
      else if (it.kind === 'close' && stack.length) {
        const o = stack.pop();
        let up = 0;
        let down = 0;
        for (let k = o + 1; k < idx; k++) {
          up = Math.max(up, items[k].box.up);
          down = Math.max(down, items[k].box.down);
        }
        if (up > 1.4 * sc || down > 0.5 * sc) {
          const a = E.fence(items[o].c, sc, up, down);
          const b = E.fence(it.c, sc, up, down);
          if (a) items[o].box = a;
          if (b) it.box = b;
        }
      }
    });
    return items;
  }

  function gapBetween(a, b, atStart) {
    if (!a) return 0;
    const unary = b.c === '-' && (atStart || a.kind === 'open' || a.kind === 'rel' || a.kind === 'bin');
    if (a.kind === 'gap' || b.kind === 'gap') return 0; // a space that was asked for is the whole gap
    if (a.kind === 'rel' || b.kind === 'rel') return 0.55;
    if (a.kind === 'bin' && !(a.unary)) return 0.35;
    if (b.kind === 'bin' && !unary) return 0.35;
    if (a.kind === 'open' || b.kind === 'close') return 0.05;
    if (a.kind === 'punct') return 0.3;
    if (b.kind === 'punct') return 0.04;
    if (a.kind === 'big' || b.kind === 'big') return 0.15;
    if (a.kind === 'frac' || b.kind === 'frac' || a.kind === 'sqrt' || b.kind === 'sqrt') return 0.2;
    if (a.kind === 'run' && b.kind === 'run') return 0.3;
    return 0.12;
  }

  /** Lay items left to right on one baseline. Returns a box. */
  function row(E, nodes, sc) {
    const items = layoutNodes(E, nodes, sc);
    const out = [];
    let x = 0;
    let up = 0;
    let down = 0;
    items.forEach((it, i) => {
      const prev = items[i - 1];
      if (prev && prev.kind === 'bin' && prev.c === '-' && (i === 1 || (items[i - 2] && ['open', 'rel', 'bin'].includes(items[i - 2].kind)))) prev.unary = true;
      x += gapBetween(prev, it, i === 0) * sc;
      place(out, it.box, x, it.dy || 0);
      x += it.box.w;
      up = Math.max(up, it.box.up + (it.dy || 0));
      down = Math.max(down, it.box.down - (it.dy || 0));
    });
    return { w: x, up, down, strokes: out };
  }

  function attachScripts(E, n, box, sc) {
    if (!n.sup && !n.sub) return box;
    const out = [];
    place(out, box, 0, 0);
    const ssc = sc * 0.7;
    const sup = n.sup ? row(E, n.sup, ssc) : null;
    const sub = n.sub ? row(E, n.sub, ssc) : null;
    const x = box.w + 0.05 * sc;
    let w = box.w;
    let up = box.up;
    let down = box.down;
    if (sup) {
      const base = Math.max(0.6 * sc, box.up - 0.45 * sc);
      place(out, sup, x, base);
      w = Math.max(w, x + sup.w);
      up = Math.max(up, base + sup.up);
    }
    if (sub) {
      const base = -Math.max(0.3 * sc, box.down * 0.6 + 0.15 * sc);
      place(out, sub, x, base);
      w = Math.max(w, x + sub.w);
      down = Math.max(down, -base + sub.down);
    }
    return { w, up, down, strokes: out };
  }

  function layoutAtom(E, n, sc) {
    if (n.t === 'run') {
      const under = n.s === 'lim' && n.sub;
      let box = E.written(n.s, sc);
      if (!box) {
        for (const c of Array.from(n.s)) E.ctx.missing.add(c);
        return null;
      }
      if (under) {
        const lo = row(E, n.sub, sc * 0.7);
        const w = Math.max(box.w, lo.w);
        const out = [];
        place(out, box, (w - box.w) / 2, 0);
        place(out, lo, (w - lo.w) / 2, -box.down - 0.25 * sc - lo.up);
        return { kind: 'run', box: { w, up: box.up, down: box.down + 0.25 * sc + lo.up + lo.down, strokes: out } };
      }
      box = attachScripts(E, n, box, sc);
      return { kind: 'run', box };
    }
    if (n.t === 'gap') return { kind: 'gap', box: { w: n.w * sc, up: 0, down: 0, strokes: [] } };
    if (n.t === 'text') {
      // plain text inside math: each word written as a word, with word gaps between (and no operator spacing in "-int")
      const out = [];
      let x = /^\s/.test(n.s) ? 0.4 * sc : 0; // spaces at the ends of the braces are real: \text{ so }
      let up = 0;
      let down = 0;
      for (const w of n.s.split(/\s+/).filter(Boolean)) {
        const box = E.written(w, sc);
        if (!box) {
          for (const c of Array.from(w)) E.ctx.missing.add(c);
          continue;
        }
        if (out.length) x += 0.3 * sc;
        place(out, box, x, 0);
        x += box.w;
        up = Math.max(up, box.up);
        down = Math.max(down, box.down);
      }
      if (!out.length) return null;
      if (/\s$/.test(n.s)) x += 0.4 * sc;
      return { kind: 'run', box: attachScripts(E, n, { w: x, up, down, strokes: out }, sc) };
    }
    if (n.t === 'sym') {
      const c = n.c;
      const kind = RELATIONS.has(c) ? 'rel' : BINARY.has(c) ? 'bin' : OPEN.has(c) ? 'open' : CLOSE.has(c) ? 'close' : c === ',' || c === ';' || c === ':' ? 'punct' : 'ord';
      let box = E.symbol(c, sc);
      if (!box) return null;
      box = attachScripts(E, n, box, sc);
      return { kind, c, box };
    }
    if (n.t === 'group') {
      const box = attachScripts(E, n, row(E, n.a, sc), sc);
      return { kind: 'run', box };
    }
    if (n.t === 'frac') {
      const fs = sc * 0.88;
      const a = row(E, n.a, fs);
      const b = row(E, n.b, fs);
      const w = Math.max(a.w, b.w) + 0.3 * sc;
      const axis = 0.5 * sc;
      const gap = 0.22 * sc;
      const bar = E.drawn([E.line(0, 0, w / sc, 0.01)], sc);
      const out = [];
      place(out, bar, 0, axis);
      place(out, a, (w - a.w) / 2, axis + gap + a.down);
      place(out, b, (w - b.w) / 2, axis - gap - b.up);
      const box = { w, up: axis + gap + a.down + a.up, down: -(axis - gap - b.up) + b.down, strokes: out };
      return { kind: 'frac', box: attachScripts(E, n, box, sc) };
    }
    if (n.t === 'sqrt') {
      const inner = row(E, n.a, sc);
      const top = Math.max(inner.up, 1.0 * sc) + 0.25 * sc;
      const bottom = -(inner.down + 0.05 * sc);
      const h = top - bottom;
      const index = n.idx && n.idx.length ? row(E, n.idx, sc * 0.55) : null; // the 3 of a cube root, small at the hook
      const lead = index ? Math.max(0, index.w - 0.12 * sc) : 0;
      const rw = 0.55 * sc;
      const poly = [[0, bottom + 0.45 * h], [0.15 * sc, bottom + 0.55 * h], [0.32 * sc, bottom], [rw, top], [rw + inner.w + 0.2 * sc, top]];
      const rad = E.drawn([poly.map(([x, y]) => [x / sc, y / sc])], sc);
      const out = [];
      place(out, rad, lead, 0);
      place(out, inner, lead + rw + 0.08 * sc, 0);
      let boxUp = top;
      if (index) {
        const iy = bottom + 0.5 * h;
        place(out, index, 0, iy);
        boxUp = Math.max(top, iy + index.up);
      }
      const box = { w: lead + rw + inner.w + 0.2 * sc, up: boxUp, down: Math.max(inner.down, -bottom), strokes: out };
      return { kind: 'sqrt', box: attachScripts(E, n, box, sc) };
    }
    if (n.t === 'big') {
      const bsc = sc * (n.c === '∫' ? 1.15 : 1);
      const glyph = E.symbol(n.c, bsc);
      if (!glyph) return null;
      const out = [];
      place(out, glyph, 0, 0);
      let w = glyph.w;
      let up = glyph.up;
      let down = glyph.down;
      const lsc = sc * 0.65;
      const hi = n.sup ? row(E, n.sup, lsc) : null;
      const lo = n.sub ? row(E, n.sub, lsc) : null;
      if (n.c === '∫') {
        if (hi) {
          place(out, hi, glyph.w * 0.7, glyph.up - 0.5 * sc);
          w = Math.max(w, glyph.w * 0.7 + hi.w);
          up = Math.max(up, glyph.up - 0.5 * sc + hi.up);
        }
        if (lo) {
          place(out, lo, glyph.w * 0.15, -glyph.down - lo.up + 0.25 * sc);
          w = Math.max(w, glyph.w * 0.15 + lo.w);
          down = Math.max(down, glyph.down + lo.up + lo.down - 0.25 * sc);
        }
      } else {
        const width = Math.max(glyph.w, hi ? hi.w : 0, lo ? lo.w : 0);
        out.length = 0;
        place(out, glyph, (width - glyph.w) / 2, 0);
        if (hi) {
          place(out, hi, (width - hi.w) / 2, glyph.up + 0.2 * sc + hi.down);
          up = glyph.up + 0.2 * sc + hi.down + hi.up;
        }
        if (lo) {
          place(out, lo, (width - lo.w) / 2, -glyph.down - 0.2 * sc - lo.up);
          down = glyph.down + 0.2 * sc + lo.up + lo.down;
        }
        w = width;
      }
      return { kind: 'big', box: { w, up, down, strokes: out } };
    }
    return null;
  }

  // ---- page -----------------------------------------------------------------------------------

  /**
   * Same result shape as synth.layout: {width, height, strokes, missing, baselines, xh, lineHeightPx}.
   * opts: {xh (px), width (px), lineHeight (x-heights), messiness, variation, seed, margin (px)}
   */
  function layout(style, text, opts) {
    const o = Object.assign({ xh: 34, width: 900, lineHeight: 3.1, messiness: 0.3, variation: 0.4, slantDelta: 0, seed: 1 }, opts || {});
    const rng = G.mulberry32(o.seed);
    const E = createEngine(style, rng, o);
    const xh = o.xh;
    const margin = o.margin != null ? o.margin : xh * 1.2;
    const tanS = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180);
    const lines = parse(text).map((nodes) => row(E, nodes, 1));

    const baselines = [];
    const strokes = [];
    let base = margin;
    let widest = 0;
    lines.forEach((ln, i) => {
      const up = Math.max(ln.up, 1.7);
      base = i === 0 ? margin + up * xh : base + Math.max(o.lineHeight * xh, (lines[i - 1].down + up + 0.7) * xh);
      baselines.push(base);
      const drift = (rng() * 2 - 1) * 0.02 * o.messiness * xh;
      for (const s of ln.strokes) {
        strokes.push({
          taperStart: s.taperStart,
          taperEnd: s.taperEnd,
          pts: s.pts.map((p) => ({ x: margin + (p.x + p.y * tanS) * xh, y: base - p.y * xh + drift, w: p.w })),
        });
      }
      widest = Math.max(widest, ln.w + Math.max(0, ln.up) * Math.abs(tanS));
    });
    const last = lines[lines.length - 1] || { down: 0 };
    const height = (baselines.length ? baselines[baselines.length - 1] : margin) + (Math.max(last.down, 0.8) + 0.8) * xh + margin * 0.5;
    return {
      width: Math.max(o.width, widest * xh + 2 * margin),
      height,
      strokes,
      words: [],
      missing: Array.from(E.ctx.missing),
      baselines,
      xh,
      lineHeightPx: o.lineHeight * xh,
    };
  }

  const api = { layout, parse, tokenize };
  root.HW = root.HW || {};
  root.HW.math = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

},
"mcp/raster.js": function (module, exports, __req) {
'use strict';
/*
 * Draws the ink (SVG path data from render.js: M, L, Z and the small round arcs of the pen's dots) into a PNG, so an
 * AI that calls the tools can look at what was written. Filled with the nonzero rule, like the canvas and the PDF.
 * No dependencies: Node's zlib writes the PNG.
 */
const zlib = require('zlib');

/** Path data -> list of closed polygons [[x, y], ...]. */
function polygons(d) {
  const out = [];
  let cur = null;
  let x = 0;
  let y = 0;
  const re = /([MLZa])([^MLZa]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const n = (m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
    if (m[1] === 'M') {
      cur = [[(x = n[0]), (y = n[1])]];
      out.push(cur);
    } else if (m[1] === 'L' && cur) {
      for (let i = 0; i + 1 < n.length; i += 2) cur.push([(x = n[i]), (y = n[i + 1])]);
    } else if (m[1] === 'a' && cur) {
      // a half circle from here to (x + dx, y), as render.js writes the dots: rx ry rot large sweep dx dy
      const r = n[0];
      const dx = n[5];
      const sweep = n[4] ? 1 : -1;
      const cx = x + dx / 2;
      const a0 = Math.atan2(0, -dx);
      for (let k = 1; k <= 12; k++) {
        const t = a0 + sweep * (Math.PI * k) / 12;
        cur.push([cx + r * Math.cos(t), y + r * Math.sin(t)]);
      }
      x += dx;
    }
  }
  return out;
}

/**
 * Fill polygons (already in pixels) into a width x height grey-coverage buffer, 0..1, 4 sub-scanlines per pixel and
 * exact horizontal coverage.
 */
function coverage(polys, width, height) {
  const cov = new Float32Array(width * height);
  const SUB = 4;
  const edges = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
    }
  }
  const byRow = Array.from({ length: height * SUB }, () => []);
  for (const e of edges) {
    const lo = Math.max(0, Math.ceil(e[1] * SUB - 0.5));
    const hi = Math.min(height * SUB - 1, Math.ceil(e[3] * SUB - 0.5) - 1);
    for (let s = lo; s <= hi; s++) {
      const yy = (s + 0.5) / SUB;
      byRow[s].push([e[0] + ((yy - e[1]) / (e[3] - e[1])) * (e[2] - e[0]), e[4]]);
    }
  }
  for (let s = 0; s < height * SUB; s++) {
    const xs = byRow[s].sort((p, q) => p[0] - q[0]);
    const row = Math.floor(s / SUB) * width;
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i][1];
      if (!wind) continue;
      const x0 = Math.max(0, xs[i][0]);
      const x1 = Math.min(width, xs[i + 1][0]);
      if (x1 <= x0) continue;
      for (let px = Math.floor(x0); px < Math.ceil(x1); px++) cov[row + px] += (Math.min(x1, px + 1) - Math.max(x0, px)) / SUB;
    }
  }
  return cov;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Ink path data (layout pixels) as a PNG on white. scale: output pixels per layout pixel. rgb: [0..255 x3].
 * Returns {png: Buffer, width, height}.
 */
function renderPng(pathData, layoutWidth, layoutHeight, scale, rgb) {
  const width = Math.max(1, Math.min(4000, Math.ceil(layoutWidth * scale)));
  const height = Math.max(1, Math.min(4000, Math.ceil(layoutHeight * scale)));
  const polys = polygons(pathData).map((p) => p.map(([x, y]) => [x * scale, y * scale]));
  const cov = coverage(polys, width, height);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3);
    raw[o] = 0;
    for (let x = 0; x < width; x++) {
      const a = Math.min(1, cov[y * width + x]);
      for (let c = 0; c < 3; c++) raw[o + 1 + x * 3 + c] = Math.round(255 + (rgb[c] - 255) * a);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth
  head[9] = 2; // RGB
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return { png, width, height };
}

module.exports = { renderPng, polygons, coverage };

},
"mcp/sealed.js": function (module, exports, __req) {
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

},
};
const __cache = {};
function __req(id) {
  if (__cache[id]) return __cache[id].exports;
  if (!__defs[id]) throw new Error("This build of the server does not include " + id + ". Build it with --pdf for the PDF tools.");
  const m = (__cache[id] = { exports: {} });
  __defs[id].call(m.exports, m, m.exports, __req);
  return m.exports;
}
const __entry = { exports: {} };
__cache["mcp/server.js"] = __entry;
__req.main = __entry;
__defs["mcp/server.js"].call(__entry.exports, __entry, __entry.exports, __req);
