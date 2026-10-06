'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const Sheet = require('../src/sheet');
const PDFLib = require('../vendor/pdf-lib.min.js');

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');
const style = S.buildStyle(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
const look = { messiness: 0.3, variation: 0.4, neatness: 0.5 };

// where the ink ends up on the page, in points from the top-left, for a box at (box.x, box.y)
function pageInk(box, placed) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of placed.layout.strokes) for (const p of s.pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const ox = box.x - placed.dx * placed.K;
  const oy = box.y - placed.dy * placed.K;
  return { minX: ox + minX * placed.K, maxX: ox + maxX * placed.K, minY: oy + minY * placed.K, maxY: oy + maxY * placed.K };
}

test('a short answer keeps the default size and stays in its box', () => {
  const box = { page: 0, x: 90, y: 200, w: 300, h: 60, text: 'the quick fox', kind: 'text', seed: 3 };
  const p = Sheet.layoutBox(style, box, look);
  assert.equal(p.xhPt, Sheet.DEFAULT_XH_PT);
  assert.ok(!p.overflow);
  const ink = pageInk(box, p);
  assert.ok(ink.minX >= box.x - 1 && ink.maxX <= box.x + box.w + 1, 'inside left and right');
  assert.ok(ink.minY >= box.y - 1 && ink.maxY <= box.y + box.h + 1, 'inside top and bottom');
});

test('an answer too long for its box is written smaller until it fits', () => {
  const text = 'the quick brown fox jumps over the lazy dog and the five dozen liquor jugs';
  const box = { page: 0, x: 50, y: 100, w: 200, h: 42, text, kind: 'text', seed: 2 };
  const p = Sheet.layoutBox(style, box, look);
  assert.ok(p.xhPt < Sheet.DEFAULT_XH_PT, 'shrunk');
  assert.ok(p.xhPt >= Sheet.MIN_XH_PT);
  assert.ok(!p.overflow, 'fits after shrinking');
  const ink = pageInk(box, p);
  assert.ok(ink.maxY <= box.y + box.h + 1);
});

test('with auto size off the size is kept and the overflow is reported', () => {
  const text = 'the quick brown fox jumps over the lazy dog and the five dozen liquor jugs';
  const box = { page: 0, x: 50, y: 100, w: 200, h: 20, text, kind: 'text', seed: 2, auto: false };
  const p = Sheet.layoutBox(style, box, look);
  assert.equal(p.xhPt, Sheet.DEFAULT_XH_PT);
  assert.ok(p.overflow);
});

test('math boxes are laid out by the math engine', () => {
  const box = { page: 0, x: 90, y: 200, w: 300, h: 60, text: String.raw`\frac{a}{b} = x^2`, kind: 'math', seed: 1 };
  const p = Sheet.layoutBox(style, box, look);
  assert.ok(p.layout.strokes.length > 0);
  assert.ok(!p.overflow);
});

test('the same box and seed always give the same ink', () => {
  const box = { page: 0, x: 90, y: 200, w: 300, h: 60, text: 'quick fox', kind: 'text', seed: 7 };
  const a = Sheet.inkPath(Sheet.layoutBox(style, box, look), {});
  const b = Sheet.inkPath(Sheet.layoutBox(style, box, look), {});
  assert.equal(a, b);
  const c = Sheet.inkPath(Sheet.layoutBox(style, Object.assign({}, box, { seed: 8 }), look), {});
  assert.notEqual(a, c, 'another seed is another take');
});

test('hexToRgb reads colours and falls back to the Notability blue', () => {
  assert.deepEqual(Sheet.hexToRgb('#ff0000'), [1, 0, 0]);
  const [r, g, b] = Sheet.hexToRgb('nonsense');
  assert.ok(Math.abs(r - 0x17 / 255) < 1e-9 && Math.abs(g - 0x49 / 255) < 1e-9 && Math.abs(b - 0xb3 / 255) < 1e-9);
});

async function blankPdf(opts) {
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (opts && opts.cropBox) page.setCropBox(...opts.cropBox);
  if (opts && opts.rotate) page.setRotation(PDFLib.degrees(opts.rotate));
  doc.addPage([612, 792]);
  return doc.save();
}

test('writing ink into a PDF keeps the pages and adds drawing to the right one', async () => {
  const bytes = await blankPdf();
  const box = { page: 1, x: 90, y: 200, w: 300, h: 60, text: 'quick fox', kind: 'text', seed: 3 };
  const placed = Sheet.layoutBox(style, box, look);
  const out = await Sheet.writeInk(PDFLib, bytes, [{ box, placed }], { ink: '#1749b3' });
  const doc = await PDFLib.PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);
  assert.equal((doc.getPage(0).node.normalizedEntries().Contents || { size: () => 0 }).size(), 0, 'page 1 is left alone');
  const parts = doc.getPage(1).node.normalizedEntries().Contents;
  assert.ok(parts && parts.size() > 0, 'page 2 has drawing');
});

test('a page that has a crop box is placed from the crop box corner', async () => {
  const bytes = await blankPdf({ cropBox: [20, 30, 500, 700] });
  const box = { page: 0, x: 10, y: 10, w: 200, h: 40, text: 'fox', kind: 'text', seed: 1 };
  const placed = Sheet.layoutBox(style, box, look);
  const out = await Sheet.writeInk(PDFLib, bytes, [{ box, placed }], { ink: '#000000' });
  assert.ok(out.length > bytes.length);
});

test('a rotated page is refused instead of putting the ink in the wrong place', async () => {
  const bytes = await blankPdf({ rotate: 90 });
  const box = { page: 0, x: 10, y: 10, w: 200, h: 40, text: 'fox', kind: 'text', seed: 1 };
  const placed = Sheet.layoutBox(style, box, look);
  await assert.rejects(Sheet.writeInk(PDFLib, bytes, [{ box, placed }], { ink: '#000000' }), /rotated/);
});

test('a picture becomes a one page PDF with the same shape', async () => {
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const out = await Sheet.pdfFromImage(PDFLib, png, 'image/png', 1200, 1600);
  const doc = await PDFLib.PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(width, 612);
  assert.equal(height, 816);
});

test('in a box about one line tall the writing sits on the bottom edge, in a tall box it starts at the top', () => {
  const line = { page: 0, x: 90, y: 200, w: 300, h: 30, text: 'the quick fox', kind: 'text', seed: 3 };
  const p = Sheet.layoutBox(style, line, look);
  const base = line.y + (p.layout.baselines[0] - p.dy) * p.K;
  assert.ok(Math.abs(base - (line.y + line.h - 0.45 * p.xhPt)) < 0.5, 'baseline near the bottom: ' + base);
  assert.ok(!p.overflow);
  const tall = Object.assign({}, line, { h: 120 });
  const t = Sheet.layoutBox(style, tall, look);
  const baseTall = tall.y + (t.layout.baselines[0] - t.dy) * t.K;
  assert.ok(baseTall < tall.y + 3 * t.xhPt, 'baseline in the first lines: ' + baseTall);
});

// ---- finding the blanks on a page ----
// A grey picture of a letter-size page at 2 pixels per point, drawn with plain rectangles.
function pagePicture(paper) {
  const s = 2;
  const W = 612 * s;
  const H = 792 * s;
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = paper ? paper(x / s, y / s) : 255;
  const ink = (x, y, w, h) => {
    for (let yy = Math.round(y * s); yy < Math.round((y + h) * s); yy++) for (let xx = Math.round(x * s); xx < Math.round((x + w) * s); xx++) data[yy * W + xx] = Math.round(data[yy * W + xx] * 0.4);
  };
  const outline = (x, y, w, h) => {
    ink(x, y, w, 1);
    ink(x, y + h - 1, w, 1);
    ink(x, y, 1, h);
    ink(x + w - 1, y, 1, h);
  };
  const text = (x, y, w) => {
    for (let i = 0; i < w; i += 6) ink(x + i, y, 3, 8); // blobs the size of letters
  };
  return { img: { data, width: W, height: H }, s, ink, outline, text };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('blank answer lines and empty boxes are found, and a line box sits on its line', () => {
  const P = pagePicture();
  P.text(72, 60, 150);
  P.ink(72, 100, 300, 0.75); // an answer line
  P.outline(72, 200, 300, 60); // an empty box
  P.text(72, 515, 180);
  P.ink(300, 520, 200, 0.75); // "Name: ______": a label beside the line, nothing above it
  const found = Sheet.findBlanks(P.img, P.s);
  assert.equal(found.length, 3, JSON.stringify(found));
  const [a, box, name] = found;
  assert.equal(a.kind, 'line');
  assert.ok(near(a.y + a.h, 100, 1) && near(a.x, 72, 2) && near(a.w, 300, 3), 'the box ends on the line: ' + JSON.stringify(a));
  assert.ok(a.h >= 14 && a.h <= 28);
  assert.equal(box.kind, 'box');
  assert.ok(box.x > 72 && box.y > 200 && box.x + box.w < 372 && box.y + box.h < 260, 'inside the outline: ' + JSON.stringify(box));
  assert.equal(name.kind, 'line');
  assert.ok(near(name.x, 300, 2), JSON.stringify(name));
});

test('lines and boxes that are not blanks are left alone', () => {
  const P = pagePicture();
  P.text(72, 150, 100);
  P.ink(72, 160, 200, 0.75); // underlines a heading: text sits on it
  P.outline(72, 300, 300, 60);
  P.text(80, 320, 120); // a box with something written in it
  P.outline(380, 200, 150, 120);
  P.text(390, 210, 100); // a framed note: neither its top nor its bottom edge is a line to write on
  P.ink(72, 400, 300, 6); // a thick bar
  P.ink(72, 450, 20, 0.75); // too short to write on
  assert.deepEqual(Sheet.findBlanks(P.img, P.s), []);
});

test('only the empty cells of a table are offered, not its rules', () => {
  const P = pagePicture();
  const xs = [72, 172, 272, 372];
  const ys = [415, 440, 465, 490];
  for (const y of ys) P.ink(72, y, 301, 0.8);
  for (const x of xs) P.ink(x, 415, 0.8, 75.8);
  P.text(110, 422, 10); // row 1: both cells filled
  P.text(210, 422, 10);
  P.text(110, 447, 10); // row 2: only the first cell filled, row 3: none
  const found = Sheet.findBlanks(P.img, P.s);
  assert.ok(found.every((g) => g.kind === 'box'), JSON.stringify(found));
  const cells = found.map((g) => [xs.findIndex((x) => g.x > x && g.x < x + 100), ys.findIndex((y) => g.y > y && g.y < y + 25)].join(','));
  assert.deepEqual(cells.sort(), ['0,2', '1,1', '1,2', '2,0', '2,1', '2,2'], 'column,row of each empty cell');
});

test('a photo with a shadow across it still gives its blanks', () => {
  // the paper gets darker towards the bottom right, with some grain, like a phone photo
  let seed = 7;
  const grain = () => (((seed = Math.imul(seed, 48271) % 2147483647) & 0xffff) / 0xffff - 0.5) * 16;
  const P = pagePicture((x, y) => Math.max(0, Math.min(255, 245 - 95 * (x / 612 / 2 + y / 792 / 2) + grain())));
  P.text(72, 60, 150);
  P.ink(72, 100, 300, 1);
  P.text(300, 600, 150);
  P.ink(300, 640, 250, 1); // deep in the shadow
  P.outline(320, 680, 220, 50);
  const found = Sheet.findBlanks(P.img, P.s);
  assert.deepEqual(found.map((g) => g.kind), ['line', 'line', 'box'], JSON.stringify(found));
});
