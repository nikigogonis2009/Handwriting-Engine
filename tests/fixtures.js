'use strict';
const { writeWord } = require('./synth-writer');
const S = require('../src/style');

const CORPUS =
  'the quick brown fox jumps over the lazy dog pack my box with five dozen liquor jugs how vexingly quick daft zebras jump sphinx of black quartz judge my vow and then we went home after that hello world this is my writing for you to see'.split(
    ' '
  );

const cache = {};

/** Raw synthetic words + built style, cached per writing style. */
function corpus(style, reps) {
  const key = style + ':' + (reps || 2);
  if (!cache[key]) {
    const raws = [];
    for (let rep = 0; rep < (reps || 2); rep++) CORPUS.forEach((w, i) => raws.push(writeWord(w, { style, seed: rep * 1000 + i + 1 })));
    cache[key] = { raws, style: S.buildStyle(raws) };
  }
  return cache[key];
}

/** Turning angle (degrees) at every interior vertex of a polyline. */
function turns(pts) {
  const t = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x;
    const ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x;
    const by = pts[i + 1].y - pts[i].y;
    if (Math.hypot(ax, ay) < 1e-9 || Math.hypot(bx, by) < 1e-9) continue;
    t.push((Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * 180) / Math.PI);
  }
  return t;
}

module.exports = { CORPUS, corpus, turns };
