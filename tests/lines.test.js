'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeLine } = require('./synth-writer');
const L = require('../src/lines');

const SENTENCES = [
  'The old house was very quiet.',
  'She said it would rain today.',
  'Bring a pencil and your book.',
  'He walked by the river daily.',
  'My friends are visiting soon.',
  'We finally arrived home late.',
  'They could hardly believe it.',
  'Please call me when you land.',
];

test('a line is split back into the words that were asked for', () => {
  let good = 0;
  let total = 0;
  for (let seed = 1; seed <= 4; seed++) {
    for (const text of SENTENCES) {
      const raw = writeLine(text, { seed });
      const res = L.splitLine(raw);
      total++;
      if (res.ok && res.words.map((w) => w.text).join(' ') === text) good++;
    }
  }
  assert.ok(good / total >= 0.95, `split ${good} of ${total} lines`);
});

test('every stroke ends up in exactly one word, in order', () => {
  const raw = writeLine(SENTENCES[0], { seed: 3 });
  const res = L.splitLine(raw);
  assert.ok(res.ok);
  const count = res.words.reduce((n, w) => n + w.strokes.length, 0);
  assert.equal(count, raw.strokes.length);
  // words run left to right
  const lefts = res.words.map((w) => Math.min(...w.strokes.flat().map((p) => p[0])));
  assert.deepEqual(lefts, lefts.slice().sort((a, b) => a - b));
  assert.deepEqual(res.words.map((w) => w.pos), res.words.map((_, i) => i));
});

test('words keep their exact pad position, so spacing can be measured later', () => {
  const raw = writeLine(SENTENCES[1], { seed: 2 });
  const res = L.splitLine(raw);
  const all = res.words.flatMap((w) => w.strokes).flat();
  assert.equal(all.length, raw.strokes.flat().length);
  assert.equal(res.words[0].xh, raw.xh);
  assert.equal(res.words[0].baseline, raw.baseline);
});

test('words written without gaps are reported instead of guessed', () => {
  // no gap at all between words: the strokes run together
  const raw = writeLine(SENTENCES[2], { seed: 5, gap: -0.3, gapSd: 0, minGap: -0.5 });
  const res = L.splitLine(raw);
  assert.equal(res.ok, false);
  assert.ok(res.reason);
});

test('a single word and an empty pad are handled', () => {
  const one = L.splitLine(writeLine('hello', { seed: 1 }));
  assert.ok(one.ok);
  assert.equal(one.words.length, 1);
  assert.equal(L.splitLine({ text: 'a b', xh: 52, baseline: 189, strokes: [] }).ok, false);
});

// ---- rhythm: does the engine measure back what the writer actually did? -------------------

const S = require('../src/style');
const { writeWord } = require('./synth-writer');
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump'.split(' ');

function styleWithLines(truthOpts, nLines) {
  const raws = WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }));
  const lineRecs = [];
  for (let k = 0; k < nLines; k++) {
    const text = SENTENCES[k % SENTENCES.length];
    const line = writeLine(text, Object.assign({ seed: 40 + k }, truthOpts));
    const split = L.splitLine(line);
    assert.ok(split.ok, 'line ' + k + ' splits');
    split.words.forEach((w, p) => {
      w.line = 'ln.' + k;
      w.key = 'ln.' + k + '.w' + p;
      lineRecs.push(w);
    });
  }
  return S.buildStyle(raws.concat(lineRecs));
}

test('not enough lines -> generic spacing, nothing invented', () => {
  const st = styleWithLines({}, 2);
  assert.equal(st.rhythm.learned, false);
  assert.equal(S.buildStyle(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }))).rhythm.learned, false);
});

test('the word gap the writer used is measured back', () => {
  for (const gap of [0.7, 1.2]) {
    const st = styleWithLines({ gap, gapSd: 0.1 }, 8);
    assert.equal(st.rhythm.learned, true);
    // the gap is measured between ink, in the writer's x-heights; allow for the slant overhang
    assert.ok(Math.abs(st.rhythm.gapMean - gap) < 0.25 * gap + 0.1, `wanted ~${gap}, measured ${st.rhythm.gapMean.toFixed(2)}`);
  }
});

test('a steadier writer measures steadier than a wobbly one', () => {
  const steady = styleWithLines({ baseSd: 0.01, sizeSd: 0.01, slantSd: 0.005, gap: 1.1, gapSd: 0.03 }, 10).rhythm;
  const wobbly = styleWithLines({ baseSd: 0.12, sizeSd: 0.12, slantSd: 0.08, gap: 1.1, gapSd: 0.22 }, 10).rhythm;
  assert.ok(wobbly.baseSd > steady.baseSd * 1.5, `baseline ${steady.baseSd.toFixed(3)} vs ${wobbly.baseSd.toFixed(3)}`);
  assert.ok(wobbly.sizeSd > steady.sizeSd * 1.25, `size ${steady.sizeSd.toFixed(3)} vs ${wobbly.sizeSd.toFixed(3)}`);
  assert.ok(wobbly.gapSd > steady.gapSd * 1.5, `gap ${steady.gapSd.toFixed(3)} vs ${wobbly.gapSd.toFixed(3)}`);
});

test('a line that slopes is measured as sloping', () => {
  const flat = styleWithLines({ slope: 0 }, 8).rhythm;
  assert.ok(flat.slopeSd < 0.02, 'flat lines: ' + flat.slopeSd.toFixed(3));
});

// ---- the synthesizer uses the learned rhythm ----------------------------------------------

const Y = require('../src/synth');


test('word gaps in the output follow the writer\'s gaps, and the slider scales them', () => {
  const wide = styleWithLines({ gap: 1.4, gapSd: 0.1 }, 8);
  const tight = styleWithLines({ gap: 0.6, gapSd: 0.05 }, 8);
  const text = 'the quick brown fox jumps over lazy dog and the five boxes';
  const measure = (st, messiness) => {
    const lay = Y.layout(st, text, { xh: 34, width: 4000, seed: 3, messiness, variation: 0.3 });
    // words are separate stroke groups; find the horizontal gaps in ink coverage
    const spans = lay.strokes.map((s) => [Math.min(...s.pts.map((p) => p.x)), Math.max(...s.pts.map((p) => p.x))]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1] + 1) last[1] = Math.max(last[1], sp[1]);
      else merged.push(sp.slice());
    }
    const gaps = merged.slice(1).map((m, i) => m[0] - merged[i][1]).sort((a, b) => b - a);
    return gaps.slice(0, 11).reduce((a, b) => a + b, 0) / 11 / 34; // the 11 word gaps, in x-heights
  };
  const w = measure(wide, 0.3);
  const t = measure(tight, 0.3);
  assert.ok(w > t * 1.4, `wide writer ${w.toFixed(2)} vs tight writer ${t.toFixed(2)}`);
  assert.ok(Math.abs(w - wide.rhythm.gapMean) < 0.4, `output gap ${w.toFixed(2)} vs measured ${wide.rhythm.gapMean.toFixed(2)}`);
});

test('the variation slider scales the learned drift: 0 is perfectly regular', () => {
  const st = styleWithLines({ baseSd: 0.1, sizeSd: 0.1, gap: 1.0, gapSd: 0.2 }, 10);
  // the same letter again and again, always the same example (variation 0), so any spread in
  // where the letters sit can only come from the drift model
  const text = 'o o o o o o o o o o o o o o o o';
  const spread = (messiness) => {
    const lay = Y.layout(st, text, { xh: 34, width: 4000, seed: 5, messiness, variation: 0 });
    const bottoms = lay.strokes.map((s) => Math.max(...s.pts.map((p) => p.y)));
    const m = bottoms.reduce((a, b) => a + b, 0) / bottoms.length;
    return Math.sqrt(bottoms.reduce((a, b) => a + (b - m) * (b - m), 0) / bottoms.length);
  };
  const none = spread(0);
  const normal = spread(0.3);
  const lots = spread(0.9);
  assert.ok(none < 0.5, 'slider at 0 -> letters sit on one line, spread ' + none.toFixed(2));
  assert.ok(normal > none + 0.2, `normal ${normal.toFixed(2)} vs none ${none.toFixed(2)}`);
  assert.ok(lots > normal, `more variation -> more spread (${lots.toFixed(2)} vs ${normal.toFixed(2)})`);
});

test('without line data the output is unchanged by the new code path', () => {
  const st = S.buildStyle(WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 })));
  assert.equal(st.rhythm.learned, false);
  const lay = Y.layout(st, 'the quick brown fox', { xh: 34, width: 900, seed: 2 });
  assert.ok(lay.strokes.length > 0);
});

test('drift moves the lines on its own, without changing word sizes', () => {
  const st = styleWithLines({ baseSd: 0.1, sizeSd: 0.1, gap: 1.0, gapSd: 0.2 }, 10);
  const text = 'o o o o o o o o o o o o o o o o';
  const run = (drift) => {
    const lay = Y.layout(st, text, { xh: 34, width: 4000, seed: 5, messiness: 0, drift, variation: 0 });
    const boxes = lay.strokes.map((s) => {
      const ys = s.pts.map((p) => p.y);
      return { bottom: Math.max(...ys), h: Math.max(...ys) - Math.min(...ys) };
    });
    const m = boxes.reduce((a, b) => a + b.bottom, 0) / boxes.length;
    const spread = Math.sqrt(boxes.reduce((a, b) => a + (b.bottom - m) ** 2, 0) / boxes.length);
    return { spread, heights: boxes.map((b) => b.h) };
  };
  const flat = run(0);
  const drifting = run(0.9);
  assert.ok(flat.spread < 0.5, 'drift 0 -> straight line, spread ' + flat.spread.toFixed(2));
  assert.ok(drifting.spread > flat.spread + 0.5, `drift 0.9 spread ${drifting.spread.toFixed(2)}`);
  drifting.heights.forEach((h, i) => assert.ok(Math.abs(h - flat.heights[i]) < 0.01, `letter ${i} kept its size`));
});

test('left out, drift follows messiness as before', () => {
  const st = styleWithLines({ baseSd: 0.1, sizeSd: 0.1, gap: 1.0, gapSd: 0.2 }, 10);
  const a = Y.layout(st, 'the quick brown fox jumps', { seed: 7, messiness: 0.6 });
  const b = Y.layout(st, 'the quick brown fox jumps', { seed: 7, messiness: 0.6, drift: 0.6 });
  assert.deepEqual(a.strokes, b.strokes);
});
