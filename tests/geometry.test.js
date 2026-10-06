'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geometry');

const line = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('resample gives even spacing and keeps both end points', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  const r = G.resample(pts, 0.05);
  assert.deepEqual([r[0].x, r[0].y], [0, 0]);
  assert.deepEqual([r[r.length - 1].x, r[r.length - 1].y], [1, 1]);
  const gaps = r.slice(1).map((p, i) => G.dist(p, r[i]));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.01, 'spacing is uniform');
});

test('resample interpolates extra channels and survives a dot', () => {
  const r = G.resample([{ x: 0, y: 0, t: 0, p: 0 }, { x: 2, y: 0, t: 100, p: 1 }], 0.5);
  assert.ok(Math.abs(r[2].t - 50) < 1e-6 && Math.abs(r[2].p - 0.5) < 1e-6);
  const dot = G.resample([{ x: 3, y: 4 }], 0.1);
  assert.equal(dot.length, 2);
});

test('smooth never moves the end points and reduces jitter', () => {
  const noisy = line(60, (i) => ({ x: i * 0.03, y: (i % 2 ? 1 : -1) * 0.02 }));
  const s = G.smooth(noisy, 2);
  assert.ok(Math.abs(s[0].x - noisy[0].x) < 1e-9 && Math.abs(s[0].y - noisy[0].y) < 1e-9);
  assert.ok(Math.abs(s[59].x - noisy[59].x) < 1e-9 && Math.abs(s[59].y - noisy[59].y) < 1e-9);
  const amp = (a) => Math.max(...a.map((p) => Math.abs(p.y)));
  assert.ok(amp(s.slice(10, 50)) < amp(noisy) * 0.3);
});

test('hermite bridge leaves and arrives along the requested tangents', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 1, y: 0.4 };
  const t0 = { dx: 1, dy: 0 };
  const t1 = { dx: 0.8, dy: 0.6 };
  const mid = G.hermite(a, t0, b, t1, 0.02);
  const all = [a, ...mid, b];
  const first = G.dirAt(all, 0, 1);
  const last = G.dirAt(all, all.length - 1, 1);
  assert.ok(first.dx > 0.95, 'starts heading along t0');
  assert.ok(last.dx * t1.dx + last.dy * t1.dy > 0.97, 'ends heading along t1');
  assert.ok(G.maxTurnDeg(all) < 10, 'no corner in between');
});

test('catmull keeps original points and adds smooth ones', () => {
  const pts = line(6, (i) => ({ x: i, y: i % 2 }));
  const c = G.catmull(pts, 4);
  assert.equal(c.length, (pts.length - 1) * 4 + 1);
  assert.deepEqual([c[4].x, c[4].y], [1, 1]);
});

test('seeded randomness is deterministic and noise is bounded', () => {
  const a = G.mulberry32(5);
  const b = G.mulberry32(5);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
  const n = G.makeNoise(G.mulberry32(3));
  for (let x = -5; x < 60; x += 0.37) assert.ok(Math.abs(n(x)) <= 1);
  assert.notEqual(G.mulberry32(1)(), G.mulberry32(2)());
});
