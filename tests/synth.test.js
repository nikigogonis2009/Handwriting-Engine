'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geometry');
const S = require('../src/style');
const Y = require('../src/synth');
const R = require('../src/render');
const { corpus, turns } = require('./fixtures');

const fraction = (a, th) => a.filter((v) => v > th).length / Math.max(1, a.length);
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

test('same seed -> identical handwriting, different seed -> different handwriting', () => {
  const { style } = corpus('cursive');
  const a = Y.layout(style, 'the quick brown fox', { seed: 5 });
  const b = Y.layout(style, 'the quick brown fox', { seed: 5 });
  const c = Y.layout(style, 'the quick brown fox', { seed: 6 });
  const sig = (l) => l.strokes.map((s) => s.pts.map((p) => p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ')).join('|');
  assert.equal(sig(a), sig(b));
  assert.notEqual(sig(a), sig(c));
});

test('the same letter is not pasted identically every time', () => {
  const { style } = corpus('cursive');
  const lay = Y.layout(style, 'eeeeeeeeee', { seed: 2, variation: 0.8, messiness: 0.3 });
  assert.ok(lay.strokes.length >= 1);
  // pick the units used: with variety on, more than one distinct 'e' instance appears
  const ctx = { variation: 0.8, messiness: 0, usage: new Map(), missing: new Set() };
  const w = Y.synthWord(style, 'eeeeeeeeee', G.mulberry32(1), ctx);
  const used = new Set(w.choices.map((c) => c.unit.id));
  assert.ok(used.size >= 3, `used ${used.size} distinct e's`);
});

test('real neighbouring letters are reused as a chunk when they exist', () => {
  const { style } = corpus('cursive');
  const ctx = { variation: 0, messiness: 0, usage: new Map(), missing: new Set() };
  const w = Y.synthWord(style, 'the', G.mulberry32(1), ctx);
  const ids = w.choices.map((c) => c.unit);
  const natural = ids.slice(1).filter((u, i) => u.wid === ids[i].wid && u.idx === ids[i].idx + 1).length;
  assert.ok(natural >= 1, 'at least one true letter pair (ligature) was kept');
});

test('output has no more sharp turns than the writer\'s own strokes', () => {
  const { style } = corpus('cursive');
  let input = [];
  for (const w of style.words) if (w.ok) for (const u of w.units) for (const s of u.strokes) input = input.concat(turns(s.pts));
  const ctx = { variation: 0.6, messiness: 0.5, usage: new Map(), missing: new Set() };
  const rng = G.mulberry32(9);
  let output = [];
  for (let k = 0; k < 60; k++) {
    for (const word of ['the', 'quick', 'brown', 'jumps', 'handwriting', 'engine', 'lazy', 'over', 'fox', 'writing']) {
      const r = Y.synthWord(style, word, rng, ctx);
      for (const s of r.strokes) output = output.concat(turns(s.pts));
    }
  }
  for (const th of [30, 45, 60]) {
    assert.ok(fraction(output, th) <= fraction(input, th) * 1.25 + 0.002, `>${th} deg: out ${fraction(output, th)} vs in ${fraction(input, th)}`);
  }
});

test('joins between letters are smooth: no visible corner where letters connect', () => {
  const { style } = corpus('cursive');
  const ctx = { variation: 0.6, messiness: 0, usage: new Map(), missing: new Set() };
  const rng = G.mulberry32(21);
  const worst = [];
  for (let k = 0; k < 60; k++) {
    for (const word of ['the', 'quick', 'brown', 'jumps', 'handwriting', 'engine', 'lazy', 'over', 'fox', 'writing', 'hello']) {
      const r = Y.synthWord(style, word, rng, ctx);
      for (const j of r.joins) {
        const seg = j.stroke.pts.slice(Math.max(0, j.from - 1), Math.min(j.stroke.pts.length, j.to + 2));
        worst.push(Math.max(0, ...turns(seg)));
      }
    }
  }
  assert.ok(worst.length > 500, 'plenty of joins were exercised');
  assert.ok(q(worst, 0.5) < 12, 'typical join turns less than 12 degrees, got ' + q(worst, 0.5));
  assert.ok(q(worst, 0.95) < 25, 'p95 ' + q(worst, 0.95));
  assert.ok(q(worst, 0.99) < 45, 'p99 ' + q(worst, 0.99));
  assert.ok(Math.max(...worst) < 70, 'worst ' + Math.max(...worst));
});

test('every stroke is finite and stays on the page', () => {
  const { style } = corpus('cursive');
  const lay = Y.layout(style, 'the quick brown fox jumps over the lazy dog. pack my box with five dozen liquor jugs.', { width: 700, xh: 36, seed: 3 });
  for (const s of lay.strokes) {
    for (const p of s.pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w));
      assert.ok(p.x > -20 && p.x < lay.width + 20, 'x on page ' + p.x);
      assert.ok(p.y > -20 && p.y < lay.height + 20, 'y on page ' + p.y);
    }
  }
});

test('long text wraps to the page width and keeps lines ordered', () => {
  const { style } = corpus('cursive');
  const text = 'the quick brown fox jumps over the lazy dog and then we went home after that';
  const narrow = Y.layout(style, text, { width: 420, xh: 30, seed: 1 });
  const wide = Y.layout(style, text, { width: 1100, xh: 30, seed: 1 });
  assert.ok(narrow.baselines.length > wide.baselines.length, 'narrower page -> more lines');
  const maxX = Math.max(...narrow.strokes.flatMap((s) => s.pts.map((p) => p.x)));
  assert.ok(maxX < 420 + 30, 'nothing runs off the right edge (' + maxX + ')');
  for (let i = 1; i < narrow.baselines.length; i++) assert.ok(narrow.baselines[i] > narrow.baselines[i - 1]);
});

test('newlines start new lines, blank lines leave a gap', () => {
  const { style } = corpus('cursive');
  const one = Y.layout(style, 'the dog', { width: 800, seed: 1 });
  const three = Y.layout(style, 'the dog\n\nthe dog', { width: 800, seed: 1 });
  assert.equal(one.baselines.length, 1);
  assert.equal(three.baselines.length, 3);
});

test('characters that were never written are reported, not drawn as garbage', () => {
  const { style } = corpus('cursive');
  assert.deepEqual(S.missingChars(style, 'the dog').sort(), []);
  assert.deepEqual(S.missingChars(style, 'the # dog 7').sort(), ['#', '7']);
  const lay = Y.layout(style, 'the # dog 7', { seed: 1 });
  assert.deepEqual(lay.missing.sort(), ['#', '7']);
  assert.ok(lay.strokes.length > 0, 'the rest is still written');
});

test('a missing capital falls back to an enlarged lowercase letter', () => {
  const { style } = corpus('cursive');
  assert.ok(!style.byChar.has('Z'));
  assert.equal(S.fallbackFor(style, 'Z').ch, 'z');
  assert.ok(S.fallbackFor(style, 'Z').scale > 1.3);
  assert.deepEqual(S.missingChars(style, 'Zed'), []);
  const lay = Y.layout(style, 'Zed', { seed: 1 });
  assert.equal(lay.missing.length, 0);
});

test('typographic quotes and dashes map to the plain marks', () => {
  assert.equal(S.normalizeChar('’'), "'");
  assert.equal(S.normalizeChar('“'), '"');
  assert.equal(S.normalizeChar('—'), '-');
});

test('slant slider tilts the writing', () => {
  const { style } = corpus('cursive');
  const upright = Y.layout(style, 'lllll', { seed: 4, slantDelta: -15, messiness: 0 });
  const leaning = Y.layout(style, 'lllll', { seed: 4, slantDelta: 15, messiness: 0 });
  const lean = (l) => {
    const xs = l.strokes.flatMap((s) => s.pts);
    const top = xs.filter((p) => p.y < l.baselines[0] - l.xh * 1.4);
    const bot = xs.filter((p) => p.y > l.baselines[0] - l.xh * 0.3 && p.y < l.baselines[0] + 2);
    const mean = (a) => a.reduce((s, p) => s + p.x, 0) / a.length;
    return mean(top) - mean(bot);
  };
  assert.ok(lean(leaning) > lean(upright) + 5);
});

test('SVG output is well formed and finite', () => {
  const { style } = corpus('cursive');
  const lay = Y.layout(style, 'the quick brown fox.', { seed: 2 });
  for (const paper of ['plain', 'lined', 'grid', 'none']) {
    const svg = R.toSVG(lay, { paper });
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
    assert.ok(!/NaN|undefined|Infinity/.test(svg));
    assert.match(svg, /<path d="M/);
  }
  assert.ok(!R.toSVG(lay, { paper: 'none' }).includes('<rect'), 'transparent has no paper');
});

test('a dot renders as a round dot and a stroke as a closed ribbon', () => {
  const dot = R.strokeToPath({ pts: [{ x: 5, y: 5, w: 1 }, { x: 5, y: 5, w: 1 }] }, 3, 30);
  assert.match(dot, /^M[\d.]+ [\d.]+a/);
  const stroke = R.strokeToPath({ pts: Array.from({ length: 30 }, (_, i) => ({ x: i, y: Math.sin(i / 5) * 4, w: 1 })) }, 2, 30);
  assert.ok(stroke.endsWith('Z') && !/NaN/.test(stroke));
});

test('pressure-less pencils get speed-based line weight, pressure pencils get pressure-based', () => {
  const { writeWord } = require('./synth-writer');
  const flat = [];
  const pressed = [];
  for (let i = 0; i < 12; i++) {
    flat.push(writeWord('the', { style: 'cursive', seed: i + 1, pressure: false }));
    pressed.push(writeWord('the', { style: 'cursive', seed: i + 1, pressure: true }));
  }
  assert.equal(S.computeStats(flat).hasPressure, false);
  assert.equal(S.computeStats(pressed).hasPressure, true);
  const w = S.buildStyle(flat).words[0].units[0].strokes[0].pts.map((p) => p.w);
  assert.ok(Math.max(...w) - Math.min(...w) > 0.05, 'line weight still varies (with speed)');
});

test('export / import round trip keeps every stroke', () => {
  const { raws } = corpus('cursive');
  const back = S.fromJSON(S.toJSON(raws.slice(0, 10)));
  assert.equal(back.length, 10);
  assert.deepEqual(back[3].strokes[0][0], raws[3].strokes[0][0]);
  assert.throws(() => S.fromJSON('{"nope":1}'));
});

test('the writer\'s own letter clearance is measured from their words', () => {
  const { style } = corpus('print');
  assert.ok(style.clearance && style.clearance.median > 0 && style.clearance.sd >= 0);
});

// ---- replacing one letter without touching the rest of the page ----------------------------

const TEXT = 'the quick brown fox jumps over the lazy dog and the quick fox';
const sigOfWord = (w) => w.ids.join(',') + '|' + w.spans.map((s) => s.map((v) => v.toFixed(2)).join('-')).join(',');
// the same word, wherever it sits on the line (a wider letter earlier in the line pushes it along)
const shapeOfWord = (w) => w.ids.join(',') + '|' + w.spans.map((s) => s.map((v) => (v - w.spans[0][0]).toFixed(1)).join('-')).join(',');

test('every word spans and ids are reported, one span per letter', () => {
  const { style } = corpus('cursive');
  const lay = Y.layout(style, TEXT, { seed: 3, width: 4000 });
  assert.equal(lay.words.length, TEXT.split(' ').length);
  for (const w of lay.words) {
    assert.equal(w.ids.length, w.text.length);
    assert.equal(w.spans.length, w.text.length);
    for (const [lo, hi] of w.spans) assert.ok(isFinite(lo) && isFinite(hi) && hi >= lo);
    assert.ok(w.spans.every((s, i) => i === 0 || s[0] >= w.spans[0][0] - 1e-6));
  }
});

test('pinning every letter reproduces the page exactly', () => {
  const { style } = corpus('cursive');
  const a = Y.layout(style, TEXT, { seed: 4, width: 900 });
  const pins = a.words.map((w) => w.ids);
  const b = Y.layout(style, TEXT, { seed: 4, width: 900, pins, variation: 0.9 }); // even with other settings
  assert.deepEqual(b.words.map(sigOfWord), a.words.map(sigOfWord));
  assert.equal(b.strokes.length, a.strokes.length);
});

test('replacing one letter changes that letter and nothing else', () => {
  const { raws } = corpus('cursive');
  const copy = raws.map((r) => ({ ...r })); // own copies, so the shared fixture keeps all its letters
  const style = S.buildStyle(copy);
  const a = Y.layout(style, TEXT, { seed: 5, width: 4000 });
  const wi = a.words.findIndex((w) => w.text === 'quick');
  const ci = 2; // the "i"
  const tapped = a.words[wi].choices[ci];
  // cross it out, rebuild, and lay the page out again with everything else pinned
  copy[tapped.wid].skip = [{ i: tapped.idx, ch: tapped.ch }];
  const style2 = S.buildStyle(copy);
  const pins = a.words.map((w, k) => w.ids.map((id, j) => (k === wi && j === ci ? null : id)));
  const b = Y.layout(style2, TEXT, { seed: 5, width: 4000, pins });
  assert.notEqual(b.words[wi].ids[ci], tapped.id, 'the crossed-out example is not used again');
  assert.equal(b.words[wi].choices[ci].ch, 'i');
  assert.ok(!b.words[wi].choices[ci].skipped);
  // a crossed-out example is gone from the whole page; every word that did not use it is exactly as it was
  b.words.forEach((w, k) => {
    assert.ok(!w.ids.includes(tapped.id), 'word ' + k + ' no longer uses the crossed-out example');
    if (!a.words[k].ids.includes(tapped.id)) assert.equal(shapeOfWord(w), shapeOfWord(a.words[k]), 'word ' + w.text + ' is unchanged');
  });
  const keep = (w) => w.ids.filter((_, j) => j !== ci).join(',');
  assert.equal(keep(b.words[wi]), keep(a.words[wi]), 'the other letters of that word are unchanged');
});

test('a digit the writer wrote on its own is strongly preferred over one cut out of a word', () => {
  const unit = (iso, id, wid) => ({
    ch: '5', iso, id, wid, idx: 0, strokes: [], marks: [], hc: 0, odd: 0, dev: 0,
    entry: { mid: false, x: 0, y: 0.5, dx: 1, dy: 0 }, exit: { mid: false, x: 1, y: 0.5, dx: 1, dy: 0 },
    box: { minX: 0, maxX: 1, minY: 0, maxY: 1.8 }, word: { units: [], suspect: false },
  });
  const single = unit(true, 'single', 1);
  const cut = unit(false, 'cut', 2);
  const style = { byChar: new Map([['5', [cut, single]]]), allByChar: new Map() };
  for (let seed = 1; seed <= 30; seed++) {
    const ctx = { variation: 0.4, messiness: 0, usage: new Map(), missing: new Set() };
    const picked = Y.chooseUnits(style, ['5', '5'], G.mulberry32(seed), ctx);
    assert.ok(picked.every((c) => c.unit.id === 'single'), 'seed ' + seed + ' picked ' + picked.map((c) => c.unit.id));
  }
});

// ---- words the writer wrote are written back from their own strokes ------------------------------

test('a word the writer wrote is written back from their own strokes, letter for letter', () => {
  const { style } = corpus('cursive');
  const lay = Y.layout(style, 'quick brown fox', { seed: 3, width: 4000, wordReuse: 1 });
  for (const w of lay.words) {
    const src = new Set(w.choices.map((c) => c.wid));
    assert.equal(src.size, 1, w.text + ' comes from one recorded word');
    assert.deepEqual(w.choices.map((c) => c.idx), w.choices.map((_, i) => w.choices[0].idx + i), 'in the order it was written');
  }
});

test('with reuse off, or for a word never written, letters are picked fresh', () => {
  const { style } = corpus('cursive');
  const off = Y.layout(style, 'quick', { seed: 3, width: 4000, wordReuse: 0 });
  const sources = (l) => new Set(l.words[0].choices.map((c) => c.wid)).size;
  const unseen = Y.layout(style, 'zbqk', { seed: 3, width: 4000, wordReuse: 1 });
  assert.ok(unseen.words[0].choices.length > 0 && sources(unseen) > 1, 'a word that was never written is built from several');
  assert.ok(off.words[0].choices.length === 5);
});

test('a recorded word is not pasted identically all over a page', () => {
  const { style } = corpus('cursive');
  const lay = Y.layout(style, 'quick quick quick quick quick quick quick quick', { seed: 4, width: 4000, wordReuse: 1 });
  const sig = lay.words.map((w) => w.ids.join(','));
  assert.ok(new Set(sig).size >= 3, 'only ' + new Set(sig).size + ' different versions in 8 words');
});

test('a crossed-out letter keeps a whole word from being reused', () => {
  const { raws } = corpus('cursive');
  const copy = raws.map((r) => ({ ...r }));
  const before = S.buildStyle(copy);
  assert.ok(before.wholeWords.has('quick'));
  const n = before.wholeWords.get('quick').length;
  const one = before.wholeWords.get('quick')[0].units[1];
  copy[one.wid].skip = [{ i: one.idx, ch: one.ch }];
  assert.equal(S.buildStyle(copy).wholeWords.get('quick').length, n - 1);
});

test('explicit pins win over word reuse', () => {
  const { style } = corpus('cursive');
  const a = Y.layout(style, 'the quick fox', { seed: 8, width: 4000, wordReuse: 0 });
  const pins = a.words.map((w) => w.ids);
  const b = Y.layout(style, 'the quick fox', { seed: 8, width: 4000, wordReuse: 1, pins });
  assert.deepEqual(b.words.map((w) => w.ids), pins);
});
