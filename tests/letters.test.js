'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeWord } = require('./synth-writer');
const S = require('../src/style');
const P = require('../src/prompts');
const Y = require('../src/synth');
const G = require('../src/geometry');

const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
const WORDS = 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs how vexingly daft zebras jump sphinx of black quartz judge vow'.split(' ');

function wordsAndLetters(opts) {
  const words = WORDS.map((w, i) => writeWord(w, { style: 'print', seed: i + 1 }));
  const letters = [];
  for (let rep = 0; rep < 2; rep++) {
    LOWER.forEach((c, i) => {
      const r = writeWord(c, { style: 'print', seed: 500 + rep * 50 + i });
      r.iso = true;
      letters.push(r);
    });
  }
  return { words, letters };
}

test('the Single letters round asks for every letter, lowercase twice', () => {
  const round = P.ROUNDS.find((r) => r.id === 'iso');
  const toks = P.tokens(round);
  assert.equal(toks.length, 26 * 3);
  assert.ok(toks.every((t) => t.iso === true && t.text.length === 1));
  assert.equal(new Set(toks.map((t) => t.key)).size, toks.length, 'every key is unique');
  for (const c of LOWER) assert.ok(toks.filter((t) => t.text === c).length >= 2);
});

test('letters written on their own are stored as clean one-letter examples', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  assert.equal(st.failed.length, 0);
  const isoUnits = [...st.byChar.values()].flat().filter((u) => u.iso);
  assert.equal(isoUnits.length, letters.length);
  assert.ok(isoUnits.every((u) => u.strokes.length >= 1));
});

test('a letter that was cut wrongly is flagged; correctly cut letters mostly are not', () => {
  const { words, letters } = wordsAndLetters();
  // mislabel a word so one of its letters has the shape of another letter: written "ox", labelled "ex"
  const bad = writeWord('ox', { style: 'print', seed: 77 });
  bad.text = 'ex';
  const st = S.buildStyle(words.concat(letters, [bad]));
  const wrongE = (st.byChar.get('e') || []).filter((u) => u.word.text === 'ex');
  assert.equal(wrongE.length, 1);
  assert.equal(wrongE[0].wrong, 1, 'an o labelled e is flagged');
  const cut = [...st.byChar.values()].flat().filter((u) => !u.iso && u.word.text !== 'ex');
  const flagged = cut.filter((u) => u.wrong).length;
  assert.ok(flagged / cut.length < 0.15, `${flagged} of ${cut.length} correctly cut letters flagged`);
});

test('without enough single letters nothing is flagged', () => {
  const { words } = wordsAndLetters();
  const st = S.buildStyle(words);
  const all = [...st.byChar.values()].flat();
  assert.ok(all.every((u) => !u.wrong));
});

test('if the comparison would call lots of letters wrong, it switches itself off', () => {
  const { words } = wordsAndLetters();
  // references that look nothing like the writer's real letters: every letter looks "wrong"
  const letters = [];
  for (let rep = 0; rep < 2; rep++) {
    LOWER.forEach((c, i) => {
      const other = LOWER[(i + 7) % 26]; // draw a different letter than the one labelled
      const r = writeWord(other, { style: 'print', seed: 700 + rep * 50 + i });
      r.text = c;
      r.iso = true;
      letters.push(r);
    });
  }
  const st = S.buildStyle(words.concat(letters));
  const cut = [...st.byChar.values()].flat().filter((u) => !u.iso);
  assert.ok(cut.length >= 30);
  assert.ok(cut.filter((u) => u.wrong).length === 0, 'nothing is acted on when the references are unreliable');
});

test('a letter crossed out in the letter check stays out of the pool but can be listed', () => {
  const { words } = wordsAndLetters();
  const before = S.buildStyle(words);
  const nBefore = before.byChar.get('o').length;
  const u = before.byChar.get('o')[0];
  words[u.wid].skip = [{ i: u.idx, ch: 'o' }];
  const after = S.buildStyle(words);
  assert.equal(after.byChar.get('o').length, nBefore - 1);
  assert.equal(after.allByChar.get('o').length, nBefore, 'still listed so it can be restored');
  assert.equal(after.allByChar.get('o').filter((x) => x.skipped).length, 1);
  // a stale mark (wrong letter at that position) is ignored
  words[u.wid].skip = [{ i: u.idx, ch: 'z' }];
  assert.equal(S.buildStyle(words).byChar.get('o').length, nBefore);
});

test('stems and punctuation are never called wrong by shape, and look-alike letters do not flag each other', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  for (const ch of 'il1|!jI.,\'`:;') {
    for (const u of st.byChar.get(ch) || []) assert.equal(u.wrong, 0, ch + ' must not be flagged');
  }
});

test('single letters are only used to start a word when the word letters exist, and are never enlarged', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  const width = (u) => u.box.maxX - u.box.minX;
  // rebuilding must not compound the shrinking
  const again = S.buildStyle(words.concat(letters));
  const isoW = (style, c) => style.byChar.get(c).filter((u) => u.iso).map(width);
  assert.deepEqual(isoW(st, 'o'), isoW(again, 'o'));
  const raw = letters.filter((l) => l.text === 'o').length;
  assert.ok(raw >= 2);
  // mid-word the cut-out letters win over single letters for letters that have enough of them
  const ctx = { variation: 0.4, messiness: 0, usage: new Map(), missing: new Set() };
  let midIso = 0;
  let mid = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const w = Y.synthWord(st, 'ohoho', G.mulberry32(seed), ctx);
    w.choices.slice(1).forEach((c) => {
      mid++;
      if (c.unit.iso) midIso++;
    });
  }
  assert.ok(midIso <= 0.1 * mid, midIso + ' of ' + mid + ' mid-word letters were single letters');
});

test('a stroke that closes on itself counts as having a bowl, an open arc does not', () => {
  const circle = [];
  for (let i = 0; i <= 40; i++) circle.push({ x: 0.5 + 0.5 * Math.cos((i / 40) * 2 * Math.PI), y: 0.5 + 0.5 * Math.sin((i / 40) * 2 * Math.PI) });
  const arc = circle.slice(0, 30);
  assert.equal(S.hasBowl({ strokes: [{ pts: circle }] }), true);
  assert.equal(S.hasBowl({ strokes: [{ pts: arc }] }), false);
});

test('cut-out letters that stay open are flagged only where the writer closes the letter', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  for (const list of st.byChar.values()) for (const u of list) assert.ok(u.open === 0 || u.open === 1 && !u.iso);
});

test('a word made only of symbols is sized by the writer\'s usual size, so a bracket stays tall', () => {
  const { words, letters } = wordsAndLetters();
  // a "(" about twice as tall as a lowercase letter, hanging a little below the baseline
  const pts = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    pts.push([60 + 18 * Math.sin(Math.PI * t), 230 - 120 * t, 1000 + i * 8, 0.5]); // bulges left-to-right like a "("
  }
  const paren = { text: '(', xh: 50, baseline: 210, strokes: [pts], truth: {} };
  const st = S.buildStyle(words.concat(letters, [paren]));
  const u = st.byChar.get('(')[0];
  const h = u.box.maxY - u.box.minY;
  const x = st.byChar.get('x')[0];
  const xh = x.box.maxY - x.box.minY;
  assert.ok(h > 0.5 * xh && h < 4, 'bracket height ' + h.toFixed(2) + ' against an x of ' + xh.toFixed(2));
  assert.ok(st.profile.s > 0, 'the writer\'s scale was learned');
});

test('Tricky letters has a, e, o, r and u at the start, middle and end of words, two words each', () => {
  const toks = P.tokens(P.ROUNDS.find((r) => r.id === 'tricky'));
  'aeoru'.split('').forEach((c, si) => {
    const words = toks.filter((t) => t.si === si).map((t) => t.text); // this letter's own sentence
    assert.equal(words.length, 6, c + ' has six words');
    for (const w of words) assert.equal(w.split(c).length, 2, w + ' has ' + c + ' exactly once');
    assert.equal(words.filter((w) => w[0] === c).length, 2, c + ' at the start');
    assert.equal(words.filter((w) => w[0] !== c && w[w.length - 1] !== c).length, 2, c + ' in the middle');
    assert.equal(words.filter((w) => w[w.length - 1] === c).length, 2, c + ' at the end');
  });
});

test('the Math and Numbers in a row rounds give every digit clean examples', () => {
  const math = P.tokens(P.ROUNDS.find((r) => r.id === 'math'));
  assert.ok(math.every((t) => t.iso === true));
  for (const d of '0123456789') assert.ok(math.filter((t) => t.text === d).length >= 2, d + ' twice on its own');
  for (const op of '+-=×÷±<>≤≥≠≈→') assert.ok(math.filter((t) => t.text === op).length >= 2, op + ' twice');
  const rows = P.tokens(P.ROUNDS.find((r) => r.id === 'nums2')).map((t) => t.text).join('');
  for (const d of '0123456789') assert.ok(rows.split(d).length - 1 >= 3, d + ' at least three times in number words');
});

test('a slash written much taller than the writer\'s letters is scaled down to their ascender height', () => {
  const { words, letters } = wordsAndLetters();
  // a straight line three x-heights tall, written on its own like a symbol
  const pts = [];
  for (let i = 0; i <= 30; i++) pts.push([60 + (i / 30) * 40, 250 - (i / 30) * 150, 1000 + i * 8, 0.5]);
  const slash = { text: '/', xh: 50, baseline: 210, strokes: [pts], truth: {} };
  const st = S.buildStyle(words.concat(letters, [slash]));
  const u = st.byChar.get('/')[0];
  const height = u.box.maxY - u.box.minY;
  const top = st.profile.asc + 0.25;
  assert.ok(height <= top + 0.05, 'slash height ' + height.toFixed(2) + ' against a cap of ' + top.toFixed(2));
  assert.ok(height > 1, 'still a tall slash');
  assert.equal(S.buildStyle(words.concat(letters, [slash])).byChar.get('/')[0].box.maxY, u.box.maxY, 'rebuilding does not shrink it again');
});

test('Common words gives only words, each at least two letters, and no duplicates', () => {
  const toks = P.tokens(P.ROUNDS.find((r) => r.id === 'common'));
  assert.ok(toks.length >= 80);
  const words = toks.map((t) => t.text);
  assert.ok(words.every((w) => /^[a-z]{2,}$/.test(w)));
  assert.equal(new Set(words).size, words.length);
  assert.equal(new Set(toks.map((t) => t.key)).size, toks.length);
});

test('a short flat run-in stroke on a single letter is trimmed off, and a letter without one is left alone', () => {
  const pt = (x, y) => ({ x, y, w: 1 });
  const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => pt(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n));
  const unitOf = (pts) => ({
    ch: 'm', iso: true, marks: [], strokes: [{ pts }],
    entry: { x: pts[0].x, y: pts[0].y, dx: 1, dy: 0, mid: false }, exit: { x: 1, y: 0, dx: 0, dy: -1, mid: false },
    box: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
  });
  // a tail running right for 0.2, then a stem straight down
  const tailed = unitOf(line(0, 0.9, 0.2, 0.9, 5).concat(line(0.2, 0.9, 0.22, 0, 20)));
  const before = tailed.strokes[0].pts.length;
  const trimmed = S.trimRunIn(tailed);
  assert.ok(trimmed.trimmed);
  assert.ok(trimmed.strokes[0].pts.length < tailed.strokes[0].pts.length);
  assert.ok(trimmed.box.minX >= 0.19, 'the unit now starts at the stem');
  assert.ok(trimmed.entry.dy < -0.9, 'and enters heading down');
  assert.equal(tailed.strokes[0].pts.length, before, 'the original is untouched');
  // a stem that starts going down has no run-in
  const plain = unitOf(line(0.2, 1, 0.22, 0, 20));
  assert.equal(S.trimRunIn(plain), plain);
});

test('the neatness setting moves how much the writer\'s single letters are used, from the usual mix to mostly single letters', () => {
  const { words, letters } = wordsAndLetters();
  const st = S.buildStyle(words.concat(letters));
  const text = 'the quick brown fox jumps over the lazy dog and the five dozen liquor jugs';
  const share = (neatness) => {
    let iso = 0;
    let n = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const lay = Y.layout(st, text, { seed, width: 4000, wordReuse: 0, neatness });
      for (const w of lay.words) for (const u of w.choices) if (/[A-Za-z]/.test(u.ch)) { n++; if (u.iso) iso++; }
    }
    return iso / n;
  };
  const low = share(0);
  const mid = share(0.5);
  const high = share(1);
  assert.ok(mid > low + 0.1, 'half neatness uses more single letters: ' + low.toFixed(2) + ' -> ' + mid.toFixed(2));
  assert.ok(high >= mid, 'full neatness uses at least as many: ' + high.toFixed(2));
});
