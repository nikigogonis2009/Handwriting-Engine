/*
 * A fake pen for the tests. It writes words from rough skeleton letters (cursive or print) with
 * jitter, slant, uneven speed and timestamps, and remembers where each letter really is so the
 * aligner can be scored. The letters are ugly on purpose, they only need to exercise the code.
 */
'use strict';
const G = require('../src/geometry');

// [advance, path control points, marks]
const L = {
  a: [0.85, [[0, .1], [.25, .6], [.5, .95], [.3, 1.02], [.08, .75], [.05, .3], [.25, .03], [.5, .25], [.58, .9], [.6, .4], [.65, .05], [.85, .05]]],
  b: [0.85, [[0, .05], [.25, .9], [.3, 1.6], [.2, 1.9], [.1, 1.6], [.15, .8], [.2, .2], [.4, 0], [.65, .25], [.55, .65], [.3, .75], [.2, .5], [.55, .85], [.85, .8]]],
  c: [0.7, [[0, .1], [.3, .7], [.5, .95], [.25, 1.0], [.05, .6], [.1, .2], [.3, .02], [.55, .15], [.7, .05]]],
  d: [0.9, [[0, .1], [.25, .6], [.45, .95], [.25, 1.02], [.05, .6], [.1, .2], [.3, .02], [.5, .25], [.6, .9], [.7, 1.6], [.75, 1.9], [.65, 1.6], [.62, .8], [.65, .2], [.9, .05]]],
  e: [0.7, [[0, .1], [.15, .45], [.55, .55], [.5, .9], [.25, 1.0], [.05, .75], [.08, .3], [.3, .02], [.55, .12], [.7, .1]]],
  f: [0.7, [[0, .1], [.25, .9], [.4, 1.7], [.3, 1.95], [.2, 1.5], [.2, .5], [.15, -.5], [0, -.6], [.1, -.1], [.4, .3], [.7, .1]], [[[-.05, 1.0], [.6, 1.05]]]],
  g: [0.9, [[0, .1], [.25, .6], [.5, .95], [.3, 1.02], [.08, .75], [.05, .3], [.25, .03], [.5, .25], [.58, .9], [.6, .2], [.58, -.4], [.4, -.85], [.15, -.7], [.2, -.3], [.9, .05]]],
  h: [0.95, [[0, .05], [.2, .9], [.3, 1.6], [.2, 1.95], [.1, 1.6], [.15, .8], [.2, .1], [.3, .5], [.45, .9], [.65, .75], [.7, .35], [.75, .05], [.95, .05]]],
  i: [0.45, [[0, .1], [.2, .55], [.25, .9], [.25, .5], [.3, .05], [.45, .05]], [[[.25, 1.4], [.26, 1.42]]]],
  j: [0.5, [[0, .1], [.2, .55], [.25, .9], [.25, .3], [.15, -.5], [-.05, -.85], [-.2, -.6], [-.1, -.3], [.3, .05], [.5, .1]], [[[.25, 1.4], [.26, 1.42]]]],
  k: [0.9, [[0, .05], [.2, .9], [.3, 1.6], [.2, 1.95], [.1, 1.6], [.15, .8], [.2, .1], [.2, .4], [.5, .8], [.3, .55], [.45, .2], [.6, .05], [.9, .05]]],
  l: [0.5, [[0, .05], [.2, .9], [.35, 1.6], [.3, 1.95], [.15, 1.6], [.2, .8], [.25, .1], [.5, .05]]],
  m: [1.35, [[0, .05], [.1, .9], [.12, .4], [.15, .05], [.25, .5], [.42, .95], [.55, .8], [.55, .3], [.6, .05], [.7, .5], [.85, .95], [1.0, .8], [1.0, .3], [1.05, .05], [1.35, .05]]],
  n: [0.95, [[0, .05], [.1, .9], [.12, .4], [.15, .05], [.25, .5], [.42, .95], [.6, .8], [.65, .3], [.7, .05], [.95, .05]]],
  o: [0.85, [[0, .1], [.25, .6], [.45, .95], [.25, 1.02], [.08, .7], [.1, .25], [.35, .02], [.6, .3], [.6, .75], [.4, 1.0], [.85, .95]]],
  p: [0.9, [[0, .1], [.1, .9], [.12, .2], [.08, -.8], [.16, .1], [.24, .6], [.5, .95], [.7, .8], [.7, .35], [.5, .05], [.25, .15], [.9, .05]]],
  q: [0.9, [[0, .1], [.25, .6], [.5, .95], [.3, 1.02], [.08, .75], [.05, .3], [.25, .03], [.5, .25], [.6, .9], [.62, .2], [.6, -.8], [.7, -.5], [.9, .05]]],
  r: [0.7, [[0, .05], [.1, .85], [.12, .3], [.15, .05], [.25, .5], [.38, .9], [.6, .95], [.7, .9]]],
  s: [0.7, [[0, .05], [.25, .6], [.5, .95], [.55, .8], [.2, .55], [.3, .35], [.5, .15], [.3, .02], [.15, .1], [.7, .05]]],
  t: [0.7, [[0, .1], [.2, .6], [.25, 1.3], [.27, 1.35], [.28, .5], [.32, .1], [.5, .05], [.7, .05]], [[[0, 1.0], [.55, 1.02]]]],
  u: [0.95, [[0, .05], [.1, .9], [.14, .3], [.3, .03], [.5, .2], [.6, .9], [.65, .3], [.7, .05], [.95, .05]]],
  v: [0.85, [[0, .05], [.1, .9], [.2, .4], [.35, .05], [.5, .5], [.6, .95], [.85, .95]]],
  w: [1.3, [[0, .05], [.1, .9], [.2, .4], [.3, .05], [.4, .5], [.5, .9], [.6, .5], [.75, .05], [.9, .5], [1.0, .95], [1.3, .95]]],
  x: [0.9, [[0, .05], [.3, .9], [.35, .95], [.6, .05], [.9, .05]], [[[.55, .9], [.05, .05]]]],
  y: [0.9, [[0, .05], [.1, .9], [.2, .4], [.4, .05], [.55, .5], [.6, .95], [.6, .3], [.5, -.5], [.3, -.9], [.05, -.7], [.2, -.3], [.9, .05]]],
  z: [0.8, [[0, .05], [.1, .95], [.55, .95], [.05, .05], [.3, -.1], [.5, -.3], [.3, -.5], [.8, .05]]],
  '.': [0.3, [[.1, .05], [.11, .06]], null, true],
  ',': [0.3, [[.1, .05], [.12, -.1], [.08, -.3]], null, true],
};

// upper case = a scaled-up lower case skeleton (only used to exercise the pipeline)
for (const c of 'abcdefghijklmnopqrstuvwxyz') {
  const [adv, path, marks] = L[c];
  L[c.toUpperCase()] = [adv * 1.5, path.map(([x, y]) => [x * 1.5, y * 1.6]), marks ? marks.map((m) => m.map(([x, y]) => [x * 1.5, y * 1.6])) : null, true];
}

function catmullDense(ctrl, perSpan) {
  const pts = ctrl.map(([x, y]) => ({ x, y }));
  return G.catmull(pts, perSpan);
}

/**
 * @returns {text, xh, baseline, strokes, truth:{centers:[...]} }
 */
function writeWord(text, o) {
  o = Object.assign({ style: 'cursive', xh: 50, baseline: 210, x0: 30, seed: 1, slant: 0.2, pressure: false }, o || {});
  const rng = G.mulberry32(o.seed);
  const rnd = (a) => (rng() * 2 - 1) * a;
  const wordSlant = o.slant + rnd(0.03);
  const chars = Array.from(text);

  const strokesUnits = []; // in xh units, unslanted
  const centers = [];
  let X = 0;
  let cursive = [];
  const lateMarks = [];
  const inlineStrokes = [];

  for (const ch of chars) {
    const g = L[ch];
    if (!g) throw new Error('synth-writer: no glyph for ' + ch);
    const [adv, path, marks, lifted] = g;
    const sx = 1 + rnd(0.07);
    const sy = 1 + rnd(0.05);
    const dy = rnd(0.03);
    const tr = (x, y) => [X + x * sx + rnd(0.012), y * sy + dy + rnd(0.012)];
    const ctrl = path.map(([x, y]) => tr(x, y));
    centers.push(X + (adv * sx) / 2);
    if (o.style === 'cursive' && !lifted) {
      cursive.push(...ctrl);
    } else {
      if (cursive.length) {
        strokesUnits.push(catmullDense(cursive, 6));
        cursive = [];
      }
      inlineStrokes.push(catmullDense(ctrl, 6));
      strokesUnits.push(inlineStrokes.pop());
    }
    if (marks) {
      for (const m of marks) {
        const mm = m.map(([x, y]) => tr(x, y));
        const dense = mm.length > 2 ? catmullDense(mm, 6) : G.resample(mm.map(([x, y]) => ({ x, y })), 0.02);
        if (o.style === 'cursive') lateMarks.push(dense);
        else strokesUnits.push(dense);
      }
    }
    X += adv * sx + (o.style === 'cursive' && !lifted ? 0.05 : 0.18) + rnd(0.02);
  }
  if (cursive.length) strokesUnits.push(catmullDense(cursive, 6));
  // cursive: main stroke first (if we flushed early because of punctuation it's already ordered)
  for (const m of lateMarks) strokesUnits.push(m);

  // to pen samples
  let minUx = Infinity;
  for (const s of strokesUnits) for (const p of s) minUx = Math.min(minUx, p.x);

  const rawStrokes = [];
  let time = 1000;
  for (const s of strokesUnits) {
    // speed profile: slower where the path turns
    const dense = G.resample(s, 0.01);
    const n = dense.length;
    const tt = [0];
    for (let i = 1; i < n; i++) {
      const a = dense[Math.max(0, i - 3)];
      const b = dense[i];
      const c = dense[Math.min(n - 1, i + 3)];
      const v1x = b.x - a.x;
      const v1y = b.y - a.y;
      const v2x = c.x - b.x;
      const v2y = c.y - b.y;
      const turn = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
      const speed = 7 / (1 + 2.5 * turn); // x-heights per second
      tt.push(tt[i - 1] + (G.dist(dense[i - 1], dense[i]) / speed) * 1000);
    }
    const total = tt[n - 1];
    const pts = [];
    let k = 1;
    for (let t = 0; t <= total; t += 8 + rng() * 2) {
      while (k < n - 1 && tt[k] < t) k++;
      const u = tt[k] > tt[k - 1] ? (t - tt[k - 1]) / (tt[k] - tt[k - 1]) : 0;
      const x = dense[k - 1].x + (dense[k].x - dense[k - 1].x) * u;
      const y = dense[k - 1].y + (dense[k].y - dense[k - 1].y) * u;
      const px = o.x0 + (x - minUx + y * wordSlant) * o.xh + rnd(0.25);
      const py = o.baseline - y * o.xh + rnd(0.25);
      const pr = o.pressure ? 0.25 + 0.6 * Math.abs(Math.sin(t / 90)) : 0.5;
      pts.push([Math.round(px * 10) / 10, Math.round(py * 10) / 10, Math.round(time + t), pr]);
    }
    // always include the final sample
    const last = dense[n - 1];
    pts.push([
      Math.round((o.x0 + (last.x - minUx + last.y * wordSlant) * o.xh) * 10) / 10,
      Math.round((o.baseline - last.y * o.xh) * 10) / 10,
      Math.round(time + total),
      o.pressure ? 0.3 : 0.5,
    ]);
    rawStrokes.push(pts);
    time += total + 150 + rng() * 200;
  }

  return {
    text,
    xh: o.xh,
    baseline: o.baseline,
    strokes: rawStrokes,
    truth: { centers: centers.map((c) => c - minUx), slant: wordSlant },
  };
}

/**
 * A whole sentence written in one go, as on the "full lines" round: words separated by gaps,
 * with a baseline that wanders, size and slant that drift, and a slight slope. Everything that
 * varies is drawn from known distributions (the defaults below) so a test can check that the
 * engine measures them back. Returns a raw record like a captured word, plus the truth.
 */
function writeLine(text, o) {
  o = Object.assign(
    { seed: 1, guideXh: 52, guideBase: 189, size: 0.5, gap: 0.9, gapSd: 0.15, baseSd: 0.06, baseRho: 0.5, sizeSd: 0.05, sizeRho: 0.5, slantSd: 0.03, slant: 0.1, slope: 0, style: 'print', x0: 30, float: 0.12, minGap: 0.35 },
    o || {}
  );
  const rng = G.mulberry32(o.seed * 977 + 3);
  const xhRef = o.guideXh * o.size;
  const words = text.split(/\s+/).filter(Boolean);
  const strokes = [];
  const truth = { gaps: [], base: [], size: [], slant: [], xhRef };
  let x = o.x0;
  let off = 0;
  let lsz = 0;
  let prevRight = null;
  words.forEach((w, k) => {
    off = o.baseRho * off + Math.sqrt(1 - o.baseRho * o.baseRho) * o.baseSd * G.gaussian(rng);
    lsz = o.sizeRho * lsz + Math.sqrt(1 - o.sizeRho * o.sizeRho) * o.sizeSd * G.gaussian(rng);
    const xh = xhRef * Math.exp(lsz);
    const baseY = o.guideBase - o.float * o.guideXh - off * xhRef + o.slope * (x - o.x0);
    const slant = o.slant + o.slantSd * G.gaussian(rng);
    const rec = writeWord(w, { style: o.style, seed: o.seed * 100 + k, xh, baseline: baseY, x0: x, slant });
    let left = Infinity;
    let right = -Infinity;
    rec.strokes.forEach((st) => st.forEach((p) => { left = Math.min(left, p[0]); right = Math.max(right, p[0]); }));
    rec.strokes.forEach((st) => strokes.push(st.map((p) => [p[0], p[1], p[2] + k * 4000, p[3]])));
    if (prevRight !== null) truth.gaps.push((left - prevRight) / xhRef);
    truth.base.push(baseY);
    truth.size.push(xh);
    truth.slant.push(slant);
    prevRight = right;
    x = right + Math.max(o.minGap, o.gap + o.gapSd * G.gaussian(rng)) * xhRef;
  });
  return { text, xh: o.guideXh, baseline: o.guideBase, pen: true, strokes, truth };
}

module.exports = { writeWord, writeLine, GLYPHS: L };
