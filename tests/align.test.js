'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWord } = require('./synth-writer');
const A = require('../src/align');
const S = require('../src/style');
const { corpus } = require('./fixtures');

const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow this is a longer sentence with many words including hello world writing handwriting engine'.split(
  ' '
);

/** Segmentation quality, independent of a constant shift caused by slant estimation. */
function score(styleName) {
  const raws = [];
  for (let seed = 1; seed <= 4; seed++) WORDS.forEach((w, i) => raws.push(writeWord(w, { style: styleName, seed: seed * 100 + i })));
  const st = S.buildStyle(raws);
  let total = 0;
  let good = 0;
  let descTotal = 0;
  let descGood = 0;
  let dotOwners = 0;
  let dotGood = 0;
  st.words.forEach((w, wi) => {
    if (!w.ok) return;
    // words are stored at the writer's own x-height, so convert back to guide x-heights
    const d = w.units.map((u, k) => ((u.box.minX + u.box.maxX) / 2) * w.view.s - raws[wi].truth.centers[k]);
    const off = d.slice().sort((a, b) => a - b)[d.length >> 1];
    w.units.forEach((u, k) => {
      total++;
      if (Math.abs(d[k] - off) < 0.35) good++;
      if ('gjpqy'.includes(u.ch)) {
        descTotal++;
        if (u.box.minY < -0.3) descGood++;
      } else if ('abcdehiklmnorstuvwx'.includes(u.ch) && u.box.minY < -0.3) descTotal++;
      if (u.ch === 'i' || u.ch === 'j') {
        // the dot is either a delayed mark (cursive) or one of the unit's own strokes (print)
        dotOwners++;
        const ink = u.strokes.flatMap((s) => s.pts).concat(u.marks.flatMap((m) => m.pts));
        if (Math.max(...ink.map((p) => p.y)) > 1.2) dotGood++;
      }
    });
  });
  return { st, total, good, descTotal, descGood, dotOwners, dotGood };
}

for (const styleName of ['cursive', 'print']) {
  test(`aligner finds the right letters (${styleName})`, () => {
    const r = score(styleName);
    assert.equal(r.st.failed.length, 0, 'every word could be aligned');
    assert.ok(r.good / r.total >= 0.98, `letters in place: ${((r.good / r.total) * 100).toFixed(1)}%`);
  });

  test(`descenders stay with their own letter (${styleName})`, () => {
    const r = score(styleName);
    assert.ok(r.descGood / r.descTotal >= 0.99, `${r.descGood}/${r.descTotal}`);
  });

  test(`i and j dots end up on the i and j (${styleName})`, () => {
    const r = score(styleName);
    assert.ok(r.dotGood / r.dotOwners >= 0.97, `${r.dotGood}/${r.dotOwners}`);
  });
}

test('single characters and punctuation become one unit', () => {
  const raw = writeWord('.', { style: 'print', seed: 3 });
  const res = A.alignWord(raw, {});
  assert.ok(res.ok);
  assert.equal(res.units.length, 1);
  assert.equal(res.units[0].ch, '.');
});

test('a drawing too short for its text reports failure instead of throwing', () => {
  const raw = writeWord('.', { style: 'print', seed: 1 });
  const res = A.alignWord(Object.assign({}, raw, { text: 'hello' }), {});
  assert.equal(res.ok, false);
  assert.ok(res.reason);
});

test('a mislabeled word is flagged for a second look, clean words are not', () => {
  const words = WORDS.slice(0, 26);
  const clean = words.map((w, i) => writeWord(w, { style: 'cursive', seed: i + 3 }));
  assert.equal(S.buildStyle(clean).suspect.length, 0, 'no false alarms');
  const bad = clean.map((r, i) => ([3, 9, 14, 20].includes(i) ? Object.assign({}, r, { text: words[(i + 5) % words.length] }) : r));
  const flagged = new Set(S.buildStyle(bad).suspect.map((s) => s.index));
  const caught = [3, 9, 14, 20].filter((i) => flagged.has(i)).length;
  assert.ok(caught >= 3, `caught ${caught} of 4 mislabeled words`);
});

test('slant is estimated within a few degrees on a long word', () => {
  const raw = writeWord('handwriting', { style: 'cursive', seed: 4 });
  const prep = A.preprocess(raw, undefined);
  const est = (prep.slant * 180) / Math.PI;
  const truth = (raw.truth.slant * 180) / Math.PI;
  assert.ok(Math.abs(est - truth) < 6, `estimated ${est.toFixed(1)} vs true ${truth.toFixed(1)}`);
});

test('units are stored upright: baseline 0, x-height 1', () => {
  const { style } = corpus('cursive');
  const os = style.byChar.get('o');
  assert.ok(os.length >= 4);
  for (const u of os) {
    assert.ok(u.box.minY > -0.4 && u.box.maxY < 1.5, 'o sits on the line and stays x-height');
  }
});

test('style building is fast enough to run on a tablet', () => {
  const raws = corpus('cursive').raws;
  const t = Date.now();
  S.buildStyle(raws.map((r) => Object.assign({}, r))); // fresh objects: nothing cached
  assert.ok(Date.now() - t < 4000, 'builds ~94 words in well under 4 s');
});

// ---- spacing by nearest ink ------------------------------------------------------------

/** a straight stroke sampled every 0.05, as real units are */
const line = (x0, y0, x1, y1) => {
  const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.05));
  return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
};
const unit = (...strokes) => ({ strokes: strokes.map((pts) => ({ pts: pts.map(([x, y]) => ({ x, y })) })), marks: [] });

test('nearest-ink gap sees the closest approach, not the bounding box', () => {
  const left = unit(line(1, 0, 1, 1)); // a stem at x = 1
  const right = unit(line(0, 0, 0, 1)); // a stem at x = 0
  // shifting the right stem by (clearance - base) leaves exactly `clearance` between the two stems
  assert.ok(Math.abs(A.inkBase(left, right) - -1) < 1e-6, 'base ' + A.inkBase(left, right));
  // a long tail below the baseline does not stop the next letter coming close
  const withTail = unit(line(1, 0, 1, 1), line(1, -1, 3, -1));
  assert.ok(Math.abs(A.inkBase(withTail, right) - -1) < 1e-6, 'tail ignored: ' + A.inkBase(withTail, right));
  // ...but a tail the next letter sits beside does count
  const beside = unit(line(0, -1, 0, 0.5));
  assert.ok(A.inkBase(withTail, beside) < -2, 'a letter beside the tail has to clear it: ' + A.inkBase(withTail, beside));
  // letters that never overlap vertically have no nearest-ink relation
  assert.equal(A.inkBase(unit(line(0, 1.6, 1, 1.9)), unit(line(0, 0, 1, 0.4))), null);
});
