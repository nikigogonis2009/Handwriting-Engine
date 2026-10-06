'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const PDFLib = require('../vendor/pdf-lib.min.js');
const { build } = require('../scripts/build-mcp');

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const samplesJson = S.toJSON(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));

/** A folder holding only the built file and the samples, as it would be when handed to someone. */
function lonely(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-bundle-'));
  fs.writeFileSync(path.join(dir, 'handwriting-mcp.js'), build(opts));
  fs.writeFileSync(path.join(dir, 'my-handwriting.json'), samplesJson);
  return dir;
}

/** Start the file and return {ask(method, params), close()} over stdio. */
function run(dir, args) {
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), ...(args || [])], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (waiting.has(m.id)) waiting.get(m.id)(m);
    }
  });
  let id = 0;
  return {
    child,
    ask: (method, params) => new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    }),
    close: () => child.kill(),
  };
}

test('the built file has no reference to the rest of the project', () => {
  const code = build({});
  assert.ok(code.length < 400 * 1024, 'small: ' + code.length);
  assert.ok(!/require\(['"]\.{1,2}\//.test(code), 'no relative requires are left');
  assert.ok(!code.includes('pdfjsWorker') && !code.includes('PDFPageLeaf'), 'the PDF libraries are not in the small build');
});

test('alone in a folder with the samples, it answers write_text with a PNG, and base64 on request', async () => {
  const dir = lonely({});
  const s = run(dir);
  try {
    const init = await s.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'handwriting');
    const names = (await s.ask('tools/list')).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['handwriting_status', 'write_batch', 'write_text']);
    const r = await s.ask('tools/call', { name: 'write_text', arguments: { text: 'the quick fox', include_base64: true, width_pt: 300 } });
    const img = r.result.content.find((c) => c.type === 'image');
    assert.equal(Buffer.from(img.data, 'base64').subarray(1, 4).toString(), 'PNG');
    const b64 = r.result.content.map((c) => c.text || '').find((t) => t.startsWith('image/png base64:\n'));
    assert.equal(b64.split('\n')[1], img.data, 'the same picture, as text');
    const st = await s.ask('tools/call', { name: 'handwriting_status', arguments: {} });
    assert.match(st.result.content[0].text, /recorded words/);
    const pdf = await s.ask('tools/call', { name: 'inspect_pdf', arguments: { pdf: 'x.pdf' } });
    assert.ok(pdf.error, 'the PDF tools are not part of this build');
  } finally {
    s.close();
  }
});

test('the --pdf build adds the PDF tools and they work from a single file too', async () => {
  const dir = lonely({ pdf: true });
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  pg.drawText('Question 1', { x: 72, y: 700, size: 14, font });
  pg.drawLine({ start: { x: 72, y: 600 }, end: { x: 540, y: 600 }, thickness: 1 });
  fs.writeFileSync(path.join(dir, 'w.pdf'), await doc.save());
  const s = run(dir, ['--out', path.join(dir, 'results')]);
  try {
    assert.deepEqual((await s.ask('tools/list')).result.tools.map((t) => t.name).sort(), ['fill_pdf', 'handwriting_status', 'inspect_pdf', 'write_batch', 'write_text']);
    const ins = await s.ask('tools/call', { name: 'inspect_pdf', arguments: { pdf: path.join(dir, 'w.pdf') } });
    assert.match(ins.result.content[0].text, /line\s+x=72 y=192 w=468/);
    const fill = await s.ask('tools/call', { name: 'fill_pdf', arguments: { pdf: path.join(dir, 'w.pdf'), answers: [{ page: 1, x: 72, line_y: 192, width: 468, text: 'the quick fox' }] } });
    assert.ok(!fill.result.isError, JSON.stringify(fill.result));
    assert.ok(fs.existsSync(path.join(dir, 'results', 'w-filled.pdf')));
  } finally {
    s.close();
  }
});

test('--http serves the same tools at /mcp, and only with the token', async () => {
  const dir = lonely({});
  const token = 'a-long-enough-secret-123';
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), '--http', '0', '--token', token], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
        const m = err.match(/127\.0\.0\.1:(\d+)\/mcp/);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', () => reject(new Error('exited: ' + err)));
    });
    const post = (body, auth) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth ? { authorization: 'Bearer ' + auth } : {}) }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
      });
      req.end(JSON.stringify(body));
    });
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token-wrong-token')).status, 401);
    const ok = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: 'the fox' } } }, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result.content[0].type, 'image');
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token)).status, 202);
  } finally {
    child.kill();
  }
});

test('--http refuses to start without a real token', async () => {
  const dir = lonely({});
  const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), '--http', '0', '--token', 'short'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
});

test('the files published on the site are the program only, with hashes and instructions that match', () => {
  const { buildExtras } = require('../scripts/build-site-extras');
  const crypto = require('crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-site-'));
  const hashes = buildExtras(dir, 'https://example.github.io/repo/');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['handwriting-engine.zip', 'handwriting-engine.zip.sha256', 'handwriting-mcp-pdf.js', 'handwriting-mcp-pdf.js.sha256', 'handwriting-mcp.js', 'handwriting-mcp.js.sha256', 'mcp.txt']);
  const files = require('./zip-reader').readZip(fs.readFileSync(path.join(dir, 'handwriting-engine.zip')));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'handwriting-engine.zip'))).digest('hex'), hashes['handwriting-engine.zip']);
  for (const need of ['START-HERE.txt', 'CLAUDE.md', 'README.md', 'handwriting-mcp.js', 'docs/handwriting-engine-guide.pdf']) assert.ok(files.has('handwriting-engine/' + need), need);
  assert.ok(![...files.keys()].some((n) => /my-handwriting|\.enc\.json|node_modules/.test(n)), 'no samples in the public zip');
  assert.ok(!files.get('handwriting-engine/handwriting-mcp.js').toString().includes('__HW_DEFAULT_SAMPLES_URL__ ='), 'the zip server has no address of anyone\'s samples baked in');
  assert.match(fs.readFileSync(path.join(dir, 'mcp.txt'), 'utf8'), /handwriting-engine\.zip/);
  for (const name of ['handwriting-mcp.js', 'handwriting-mcp-pdf.js']) {
    const code = fs.readFileSync(path.join(dir, name));
    assert.equal(crypto.createHash('sha256').update(code).digest('hex'), hashes[name]);
    assert.equal(fs.readFileSync(path.join(dir, name + '.sha256'), 'utf8'), `${hashes[name]}  ${name}\n`, 'sha256sum -c format');
    assert.ok(!code.includes('"strokes":[['), 'no samples inside');
  }
  const txt = fs.readFileSync(path.join(dir, 'mcp.txt'), 'utf8');
  assert.match(txt, /curl -fsSLO https:\/\/example\.github\.io\/repo\/handwriting-mcp\.js/);
  assert.ok(txt.includes(hashes['handwriting-mcp.js']) && txt.includes(hashes['handwriting-mcp-pdf.js']));
  for (const tool of ['write_text', 'write_batch', 'handwriting_status', 'fill_pdf']) assert.ok(txt.includes(tool), tool);
});

test('sealed samples: round trip, wrong password, and the server opens them from a file or an address', async () => {
  const { seal, unseal, isSealed } = require('../mcp/sealed');
  const plain = Buffer.from(samplesJson);
  const sealed = seal(plain, 'a-long-enough-password');
  assert.ok(isSealed(sealed) && !isSealed(plain));
  assert.ok(!sealed.includes('strokes') && !sealed.includes('quick'), 'nothing readable inside');
  assert.ok(sealed.length < plain.length, 'compressed before locking');
  assert.ok(unseal(Buffer.from(sealed), 'a-long-enough-password').equals(plain));
  assert.throws(() => unseal(Buffer.from(sealed), 'another-long-password'), /Wrong password/);
  assert.throws(() => unseal(Buffer.from(sealed), ''), /locked/);
  assert.throws(() => seal(plain, 'short'), /under 12/);

  const dir = lonely({});
  fs.rmSync(path.join(dir, 'my-handwriting.json')); // only the sealed copy is here
  fs.writeFileSync(path.join(dir, 'handwriting.enc.json'), sealed);
  const ask = async (s, name, args) => (await s.ask('tools/call', { name, arguments: args })).result;

  // from a file, password in the environment
  let s = run(dir, ['--samples', path.join(dir, 'handwriting.enc.json')]);
  s.close();
  const withEnv = (extra, args) => {
    const child = spawn(process.execPath, [path.join(dir, 'handwriting-mcp.js'), ...args], { cwd: dir, env: Object.assign({}, process.env, extra), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const waiting = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (waiting.has(m.id)) waiting.get(m.id)(m);
      }
    });
    let n = 0;
    return {
      child,
      ask: (method, params) => new Promise((resolve) => {
        waiting.set(++n, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      }),
    };
  };
  s = withEnv({ HANDWRITING_PASSWORD: 'a-long-enough-password' }, ['--samples', path.join(dir, 'handwriting.enc.json')]);
  try {
    assert.match((await ask(s, 'handwriting_status', {})).content[0].text, /recorded words/);
  } finally {
    s.child.kill();
  }
  // wrong or missing password: an error that says what to do
  s = withEnv({ HANDWRITING_PASSWORD: 'not-the-right-password' }, ['--samples', path.join(dir, 'handwriting.enc.json')]);
  try {
    const r = await ask(s, 'handwriting_status', {});
    assert.ok(r.isError);
    assert.match(r.content[0].text, /Wrong password/);
  } finally {
    s.child.kill();
  }
  s = withEnv({}, ['--samples', path.join(dir, 'handwriting.enc.json')]);
  try {
    assert.match((await ask(s, 'handwriting_status', {})).content[0].text, /--password|HANDWRITING_PASSWORD/);
  } finally {
    s.child.kill();
  }

  // from an address, as the site publishes it
  const web = http.createServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(302, { location: '/handwriting.enc.json' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(sealed);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  try {
    s = withEnv({ HANDWRITING_PASSWORD: 'a-long-enough-password' }, ['--samples-url', `http://127.0.0.1:${web.address().port}/old`]);
    try {
      const r = await ask(s, 'write_text', { text: 'the quick fox' });
      assert.ok(!r.isError, JSON.stringify(r).slice(0, 200));
      assert.equal(r.content[0].type, 'image');
    } finally {
      s.child.kill();
    }
    s = withEnv({}, ['--samples-url', 'http://127.0.0.1:1/none']);
    try {
      assert.match((await ask(s, 'handwriting_status', {})).content[0].text, /Could not download/);
    } finally {
      s.child.kill();
    }
  } finally {
    web.close();
  }
});

test('seal-samples.js locks a file and refuses a short password', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-seal-'));
  fs.writeFileSync(path.join(dir, 'in.json'), samplesJson);
  const script = path.join(__dirname, '..', 'scripts', 'seal-samples.js');
  const ok = spawnSync(process.execPath, [script, path.join(dir, 'in.json'), path.join(dir, 'out.enc.json')], { env: Object.assign({}, process.env, { SEAL_PASSWORD: 'a-long-enough-password' }) });
  assert.equal(ok.status, 0, ok.stderr.toString());
  assert.equal(fs.statSync(path.join(dir, 'out.enc.json')).mode & 0o077, 0, 'private file');
  const bad = spawnSync(process.execPath, [script, path.join(dir, 'in.json'), path.join(dir, 'x.enc.json')], { env: Object.assign({}, process.env, { SEAL_PASSWORD: 'short' }) });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr.toString(), /under 12/);
  assert.ok(!fs.existsSync(path.join(dir, 'x.enc.json')));
});

test('publishing with samples seals them, bakes their address into the servers, and a kept file is used without them', () => {
  const { buildExtras, ENC } = require('../scripts/build-site-extras');
  const { unseal } = require('../mcp/sealed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-site2-'));
  const src = path.join(dir, 'my-handwriting.json');
  fs.writeFileSync(src, samplesJson);
  const out = path.join(dir, 'site');
  buildExtras(out, 'https://example.github.io/repo/', { sealFrom: src, password: 'a-long-enough-password' });
  const enc = fs.readFileSync(path.join(out, ENC));
  assert.ok(unseal(enc, 'a-long-enough-password').equals(Buffer.from(samplesJson)));
  assert.ok(!enc.includes(Buffer.from('quick')), 'nothing readable in the published file');
  for (const f of ['handwriting-mcp.js', 'handwriting-mcp-pdf.js']) assert.match(fs.readFileSync(path.join(out, f), 'utf8'), /__HW_DEFAULT_SAMPLES_URL__ = "https:\/\/example\.github\.io\/repo\/handwriting\.enc\.json"/);
  const txt = fs.readFileSync(path.join(out, 'mcp.txt'), 'utf8');
  assert.match(txt, /HANDWRITING_PASSWORD=/);
  assert.ok(!txt.includes('a-long-enough-password'), 'the password is never written down');
  // a later publish without a new file keeps the sealed one and still points at it
  buildExtras(out, 'https://example.github.io/repo/', {});
  assert.ok(fs.existsSync(path.join(out, ENC)));
  assert.match(fs.readFileSync(path.join(out, 'handwriting-mcp.js'), 'utf8'), /handwriting\.enc\.json/);
  // a short password is refused, and nothing is written
  const out2 = path.join(dir, 'site2');
  assert.throws(() => buildExtras(out2, 'https://x/', { sealFrom: src, password: 'short' }), /under 12/);
  assert.ok(!fs.existsSync(path.join(out2, ENC)));
});

test('the published program with a baked address fetches the sealed file by itself, with only the password', async () => {
  const { buildExtras, ENC } = require('../scripts/build-site-extras');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-site3-'));
  const src = path.join(dir, 'my-handwriting.json');
  fs.writeFileSync(src, samplesJson);
  const web = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(fs.readFileSync(path.join(dir, 'site', req.url.slice(req.url.lastIndexOf('/') + 1))));
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  try {
    buildExtras(path.join(dir, 'site'), `http://127.0.0.1:${web.address().port}/`, { sealFrom: src, password: 'a-long-enough-password' });
    const work = path.join(dir, 'client'); // a folder with nothing else in it
    fs.mkdirSync(work);
    fs.copyFileSync(path.join(dir, 'site', 'handwriting-mcp.js'), path.join(work, 'handwriting-mcp.js'));
    const child = spawn(process.execPath, [path.join(work, 'handwriting-mcp.js')], { cwd: work, env: Object.assign({}, process.env, { HANDWRITING_PASSWORD: 'a-long-enough-password' }), stdio: ['pipe', 'pipe', 'pipe'] });
    const reply = await new Promise((resolve) => {
      child.stdout.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0])));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_text', arguments: { text: 'the quick fox' } } }) + '\n');
    });
    child.kill();
    assert.equal(reply.result.content[0].type, 'image', JSON.stringify(reply).slice(0, 200));
    assert.ok(fs.existsSync(path.join(work, '.handwriting-cache')), 'the cache goes in the folder it runs from');
    assert.ok(ENC);
  } finally {
    web.close();
  }
});
