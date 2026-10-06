'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { createServer } = require('../mcp/server');
const { renderPng } = require('../mcp/raster');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-mcp-'));
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const samples = path.join(tmp, 'my-handwriting.json');
fs.writeFileSync(samples, S.toJSON(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }))));
const out = path.join(tmp, 'out');

let nextId = 1;
const server = createServer({ samples, out });
const rpc = (method, params) => server({ jsonrpc: '2.0', id: nextId++, method, params });
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const textOf = (res) => res.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function worksheet() {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (const n of [1, 2]) {
    const pg = doc.addPage([612, 792]);
    pg.drawText('Question ' + n + '. Explain your answer.', { x: 72, y: 700, size: 14, font });
    pg.drawLine({ start: { x: 72, y: 600 }, end: { x: 540, y: 600 }, thickness: 1 });
  }
  const p = path.join(tmp, 'sheet.pdf');
  fs.writeFileSync(p, await doc.save());
  return p;
}

test('the handshake names the server and says it has tools', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, 'handwriting');
  assert.equal(await server({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'notifications get no reply');
  assert.deepEqual((await rpc('ping')).result, {});
});

test('the tools are listed with descriptions and schemas', async () => {
  const names = (await rpc('tools/list')).result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['fill_pdf', 'handwriting_status', 'inspect_pdf', 'write_batch', 'write_text']);
  for (const t of (await rpc('tools/list')).result.tools) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, 'object');
  }
  assert.equal((await rpc('nonsense')).error.code, -32601);
  assert.equal((await call('nope', {})).error.code, -32602);
});

test('status reports the loaded handwriting and what is missing', async () => {
  const t = textOf(await call('handwriting_status', { check: 'the 7 fox' }));
  assert.match(t, /Handwriting loaded: 27 recorded words/);
  assert.match(t, /No sample for: 7/);
});

test('write_text returns a PNG of ink and saves the files', async () => {
  const res = await call('write_text', { text: 'the quick fox', seed: 2 });
  const img = res.result.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  const png = Buffer.from(img.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  // decode: every row starts with filter byte 0; ink is bluish pixels
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 4);
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, h * (1 + w * 3));
  let blue = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (1 + w * 3) + 1 + x * 3;
    if (raw[o + 2] > 150 && raw[o] < 100) blue++;
  }
  assert.ok(blue > 200, 'there is ink: ' + blue);
  const paths = textOf(res).match(/SVG: (\S+)\s+PNG: (\S+)/);
  assert.ok(fs.existsSync(paths[1]) && fs.existsSync(paths[2]), 'files saved');
  assert.match(fs.readFileSync(paths[1], 'utf8'), /^<svg/);
  assert.ok(!res.result.content.some((c) => c.type === 'text' && c.text.startsWith('<svg')), 'the default is the picture only');
});

test('write_text takes math and a colour, and another seed is another take', async () => {
  const a = await call('write_text', { text: String.raw`x = \frac{a}{b}`, kind: 'math', ink: '#ff0000', seed: 1 });
  assert.ok(a.result.content.some((c) => c.type === 'image'));
  const svg = (r) => fs.readFileSync(textOf(r).match(/SVG: (\S+)/)[1], 'utf8');
  assert.match(svg(a), /#ff0000/);
  const t1 = svg(await call('write_text', { text: 'quick fox', seed: 1 }));
  const t2 = svg(await call('write_text', { text: 'quick fox', seed: 2 }));
  assert.notEqual(t1, t2);
});

test('the rasteriser fills with the nonzero rule and draws the round dots', () => {
  const square = 'M2 2L8 2L8 8L2 8Z';
  const { png, width } = renderPng(square, 10, 10, 2, [0, 0, 0]);
  const raw = zlib.inflateSync(png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 4));
  const px = (x, y) => raw[y * (1 + width * 3) + 1 + x * 3];
  assert.equal(px(10, 10), 0, 'inside is ink');
  assert.equal(px(1, 1), 255, 'outside is paper');
  const dot = renderPng('M3 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z', 10, 10, 4, [0, 0, 0]);
  const r2 = zlib.inflateSync(dot.png.subarray(dot.png.indexOf('IDAT') + 4, dot.png.indexOf('IEND') - 4));
  assert.equal(r2[20 * (1 + 40 * 3) + 1 + 20 * 3], 0, 'the centre of the dot is ink');
});

test('inspect_pdf lists text and ruled lines in points from the top-left', async () => {
  const pdf = await worksheet();
  const t = textOf(await call('inspect_pdf', { pdf }));
  assert.match(t, /Page 1: 612 x 792 pt/);
  assert.match(t, /Page 2/);
  assert.match(t, /text\s+x=72 y=78 .*"Question 1\. Explain your answer\."/);
  assert.match(t, /line\s+x=72 y=192 w=468/);
});

test('fill_pdf writes the answers in, reports each one and leaves the original alone', async () => {
  const pdf = await worksheet();
  const before = fs.readFileSync(pdf);
  const res = await call('fill_pdf', {
    pdf,
    answers: [
      { page: 1, x: 72, line_y: 192, width: 468, text: 'the quick fox jumps' },
      { page: 2, x: 72, y: 150, width: 300, height: 60, text: String.raw`x = \frac{a}{b}`, kind: 'math' },
      { page: 1, x: 72, y: 300, width: 120, height: 20, text: 'the quick brown fox jumps over the lazy dog and the five dozen liquor jugs' },
    ],
  });
  assert.ok(!res.result.isError, textOf(res));
  const t = textOf(res);
  const saved = t.match(/Saved (\S+)/)[1];
  assert.ok(fs.existsSync(saved));
  assert.deepEqual(fs.readFileSync(pdf), before, 'original untouched');
  assert.match(t, /answer 3 \(page 1\): written at [\d.]+ pt; (made smaller to fit|DOES NOT FIT)/);
  const doc = await PDFLib.PDFDocument.load(fs.readFileSync(saved));
  assert.equal(doc.getPageCount(), 2);
  for (const i of [0, 1]) assert.ok(doc.getPage(i).node.normalizedEntries().Contents.size() > 1, 'page ' + (i + 1) + ' has ink');
});

test('bad requests come back as errors the model can act on', async () => {
  const pdf = await worksheet();
  const bad = async (answers, re) => {
    const r = await call('fill_pdf', { pdf, answers });
    assert.ok(r.result.isError, JSON.stringify(answers));
    assert.match(textOf(r), re);
  };
  await bad([{ page: 3, x: 72, y: 100, width: 200, text: 'a' }], /page 3 does not exist/);
  await bad([{ page: 1, x: 72, width: 200, text: 'a' }], /give y/);
  await bad([{ page: 1, x: 500, y: 100, width: 200, text: 'a' }], /outside page 1/);
  await bad([{ page: 1, x: 72, y: 100, width: 200, text: '  ' }], /text is empty/);
  const r = await call('fill_pdf', { pdf, out: pdf, answers: [{ page: 1, x: 72, y: 100, width: 200, text: 'a' }] });
  assert.match(textOf(r), /never overwritten/);
  const notPdf = path.join(tmp, 'x.txt');
  fs.writeFileSync(notPdf, 'hello');
  assert.match(textOf(await call('inspect_pdf', { pdf: notPdf })), /not a PDF/);
});

test('without a handwriting file the error says how to give one', async () => {
  const bare = createServer({});
  const r = await bare({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: 'hi' } } });
  assert.ok(r.result.isError);
  assert.match(r.result.content[0].text, /--samples/);
});

test('the real program speaks the protocol over stdin and stdout, and only the protocol', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js'), '--samples', samples, '--out', out], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_pdf', arguments: { pdf: await worksheet() } } });
  for (let n = 0; n < 200 && lines.length < 2; n++) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  assert.equal(lines.length, 2);
  const msgs = lines.map((l) => JSON.parse(l)); // every line is JSON: nothing else was printed to stdout
  assert.equal(msgs[0].id, 1);
  assert.match(msgs[1].result.content[0].text, /Question 1/);
});

test('the built handwriting is cached on disk, so a second start does not build it again, and the result is the same', async () => {
  const cacheDir = path.join(tmp, 'cache-test');
  const mk = () => createServer({ samples, out: path.join(tmp, 'out2'), cache: cacheDir });
  const ask = (h, name, args) => h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const svgOf = (r) => fs.readFileSync(textOf(r).match(/SVG: (\S+)/)[1], 'utf8');
  const first = svgOf(await ask(mk(), 'write_text', { text: 'quick fox jumps', seed: 5 }));
  const files = fs.readdirSync(cacheDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^style-[0-9a-f]{32}\.v8$/);
  assert.equal(fs.statSync(path.join(cacheDir, files[0])).mode & 0o077, 0, 'private to the user');
  const real = S.buildStyle;
  S.buildStyle = () => {
    throw new Error('built again');
  };
  try {
    const again = svgOf(await ask(mk(), 'write_text', { text: 'quick fox jumps', seed: 5 }));
    assert.equal(again, first, 'the same ink from the cached handwriting');
    const m = await ask(mk(), 'write_text', { text: String.raw`x = \frac{a}{b}`, kind: 'math' });
    assert.ok(!m.result.isError, 'math works from the cache too');
  } finally {
    S.buildStyle = real;
  }
  // other samples: not the old cache
  const other = path.join(tmp, 'other.json');
  fs.writeFileSync(other, S.toJSON(WORDS.slice(0, 20).map((w, i) => writeWord(w, { style: 'print', seed: i + 50 }))));
  const h2 = createServer({ samples: other, out: path.join(tmp, 'out2'), cache: cacheDir });
  assert.match(textOf(await ask(h2, 'handwriting_status', {})), /20 recorded words/);
  assert.equal(fs.readdirSync(cacheDir).length, 1, 'only the newest is kept');
  // turned off
  const none = path.join(tmp, 'cache-off');
  await ask(createServer({ samples, out: path.join(tmp, 'out2'), cache: false }), 'handwriting_status', {});
  assert.ok(!fs.existsSync(none));
});

test('write_batch writes many in one call, reports a bad one by number and can skip the pictures', async () => {
  const res = await call('write_batch', { ink: '#aa0000', items: [{ text: 'the fox' }, { text: '   ' }, { text: String.raw`x^2`, kind: 'math' }, { text: 'quick', seed: 3 }] });
  assert.ok(!res.result.isError);
  const c = res.result.content;
  assert.equal(c.filter((x) => x.type === 'image').length, 3);
  const t = c.filter((x) => x.type === 'text').map((x) => x.text);
  assert.match(t[0], /^1\. Written at/);
  assert.match(t[1], /^2\. FAILED: text is required/);
  assert.match(t[2], /^3\. /);
  const svg = fs.readFileSync(t[0].match(/SVG: (\S+)/)[1], 'utf8');
  assert.match(svg, /#aa0000/, 'top-level options apply to every item');
  const names = new Set(t.filter((x) => /SVG:/.test(x)).map((x) => x.match(/SVG: (\S+)/)[1]));
  assert.equal(names.size, 3, 'each item has its own files');
  const slim = await call('write_batch', { return_images: false, items: [{ text: 'the fox' }, { text: 'quick' }] });
  assert.equal(slim.result.content.filter((x) => x.type === 'image').length, 0);
  assert.equal(slim.result.content.length, 2);
  assert.ok((await call('write_batch', { items: [] })).result.isError);
});

test('math typed the way people type it: sqrt words, \\text and spaces, through write_text', async () => {
  const r = await call('write_text', { text: String.raw`y\text{-int}: so\ x = sqrt(x + 1)`, kind: 'math' });
  assert.ok(!r.result.isError, textOf(r));
});

test('format svg returns the SVG markup as text, in points, with no PNG; both gives both', async () => {
  const r = await call('write_text', { text: 'the quick fox', format: 'svg', letter_height_pt: 10, ink: '#112233' });
  assert.ok(!r.result.isError);
  assert.ok(!r.result.content.some((c) => c.type === 'image'), 'no raster');
  const svg = r.result.content[0].text;
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+" width="[\d.]+pt" height="[\d.]+pt">/);
  assert.match(svg, /fill="#112233"/);
  assert.ok(!/<rect/.test(svg), 'transparent');
  const size = svg.match(/width="([\d.]+)pt" height="([\d.]+)pt"/);
  assert.match(textOf(r), new RegExp(`${Math.round(size[1])} x ${Math.round(size[2])} pt`), 'the stated size is the drawn size');
  const saved = textOf(r).match(/SVG: (\S+)/)[1];
  assert.equal(fs.readFileSync(saved, 'utf8'), svg, 'the file is the same markup');
  assert.ok(!/PNG: /.test(textOf(r)), 'no png made');
  const both = await call('write_text', { text: 'the fox', format: 'both' });
  assert.ok(both.result.content.some((c) => c.type === 'image') && both.result.content.some((c) => c.type === 'text' && c.text.startsWith('<svg')));
  const batch = await call('write_batch', { format: 'svg', items: [{ text: 'the fox' }, { text: 'quick' }] });
  assert.equal(batch.result.content.filter((c) => c.text && c.text.startsWith('<svg')).length, 2);
  assert.equal(batch.result.content.filter((c) => c.type === 'image').length, 0);
  const slim = await call('write_batch', { format: 'svg', return_images: false, items: [{ text: 'the fox' }] });
  assert.ok(!slim.result.content.some((c) => c.text && c.text.startsWith('<svg')), 'return_images false sends paths only');
  // a server started with --format svg gives SVG unless a call says png
  const svgServer = createServer({ samples, out, format: 'svg' });
  const d = await svgServer({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: 'the fox' } } });
  assert.ok(d.result.content[0].text.startsWith('<svg'));
  const p = await svgServer({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_text', arguments: { text: 'the fox', format: 'png' } } });
  assert.equal(p.result.content[0].type, 'image');
});
