'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const { seal } = require('../mcp/sealed');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-cli-'));
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs'.split(' ');
const plain = Buffer.from(S.toJSON(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }))));
const samples = path.join(tmp, 'my-handwriting.json');
fs.writeFileSync(samples, plain);
const PASSWORD = 'a long test password';
const sealed = path.join(tmp, 'handwriting.enc.json');
fs.writeFileSync(sealed, seal(plain, PASSWORD));
const CLI = path.join(__dirname, '..', 'tools', 'hw.js');

function cli(args, env) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
  } catch (e) {
    return { code: e.status, out: String(e.stdout), err: String(e.stderr) };
  }
}

test('the command line runs a tool and saves the picture it returns', () => {
  const out = path.join(tmp, 'out1');
  const r = cli(['--samples', samples, '--out', out, 'write_text', '{"text":"the quick fox"}']);
  assert.equal(r.code, 0, r.err);
  const pic = r.out.match(/Picture: (\S+\.png)/);
  assert.ok(pic, r.out);
  assert.ok(fs.statSync(pic[1]).size > 500);
});

test('a sealed handwriting file opens with the password from the environment, and not without it', () => {
  const ok = cli(['--samples', sealed, '--out', path.join(tmp, 'out2'), 'handwriting_status'], { HANDWRITING_PASSWORD: PASSWORD });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Handwriting loaded: 16 recorded words/);
  const wrong = cli(['--samples', sealed, '--out', path.join(tmp, 'out3'), '--no-cache', 'handwriting_status'], { HANDWRITING_PASSWORD: 'not the password' });
  assert.notEqual(wrong.code, 0);
});

test('the password is refused as an argument, so it never shows in the process list', () => {
  const r = cli(['--samples', sealed, '--password', PASSWORD, 'handwriting_status']);
  assert.equal(r.code, 2);
  assert.match(r.err, /HANDWRITING_PASSWORD/);
});

test('arguments can come from a file', () => {
  const f = path.join(tmp, 'args.json');
  fs.writeFileSync(f, JSON.stringify({ items: [{ text: 'box' }, { text: 'fox' }], return_images: false }));
  const r = cli(['--samples', samples, '--out', path.join(tmp, 'out4'), 'write_batch', '@' + f]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1\./);
});

test('find-blanks reads the pages pdftoppm writes and gives answer boxes in points', () => {
  const { blanksOfPages } = require('../tools/find-blanks');
  // a 612 x 792 pt page at 144 dpi with one answer line at y = 300 pt, written as pdftoppm -gray would
  const W = 1224;
  const H = 1584;
  const px = Buffer.alloc(W * H, 255);
  for (let y = 600; y < 602; y++) for (let x = 144; x < 744; x++) px[y * W + x] = 0;
  const file = path.join(tmp, 'page-1.pgm');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5\n# made by a test\n${W} ${H}\n255\n`), px]));
  const found = blanksOfPages([file], 144);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].page, 1);
  assert.equal(found[0].kind, 'line');
  assert.ok(Math.abs(found[0].line_y - 300) < 1 && Math.abs(found[0].x - 72) < 2 && Math.abs(found[0].w - 300) < 3, JSON.stringify(found[0]));
});
