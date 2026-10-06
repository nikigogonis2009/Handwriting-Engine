'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/render');

const stroke = (w, taper) => ({
  taperStart: taper || 0,
  taperEnd: taper || 0,
  pts: Array.from({ length: 30 }, (_, i) => ({ x: i * 2, y: 20 + 6 * Math.sin(i / 4), w: typeof w === 'function' ? w(i) : w })),
});

test('a constant pen ignores the stroke width and the tapers', () => {
  const a = R.strokeToPath(stroke(0.5), 3, 34, true);
  const b = R.strokeToPath(stroke((i) => 0.4 + i * 0.05, 0.3), 3, 34, true);
  assert.equal(a, b);
});

test('the speed-based pen still varies with the stroke width', () => {
  const a = R.strokeToPath(stroke(0.5), 3, 34, false);
  const b = R.strokeToPath(stroke(1.5), 3, 34, false);
  assert.notEqual(a, b);
});

test('a constant pen draws a dot as a disc of the same size as the line is wide', () => {
  const dot = R.strokeToPath({ taperStart: 0, taperEnd: 0, pts: [{ x: 5, y: 5, w: 0.3 }] }, 3, 34, true);
  const other = R.strokeToPath({ taperStart: 0, taperEnd: 0, pts: [{ x: 5, y: 5, w: 2 }] }, 3, 34, true);
  assert.equal(dot, other);
});

test('SVG export carries the constant pen, the ink colour and a white page', () => {
  const layout = { width: 100, height: 60, xh: 34, lineHeightPx: 100, baselines: [40], strokes: [stroke(1)] };
  const svg = R.toSVG(layout, { ink: '#1749b3', constant: true, paper: 'white' });
  assert.ok(svg.includes('fill="#1749b3"'));
  assert.ok(svg.includes('fill="#ffffff"'));
  const loose = R.toSVG({ ...layout, strokes: [stroke(2, 0.4)] }, { ink: '#1749b3', constant: true, paper: 'white' });
  assert.equal(svg, loose, 'with a constant pen the page does not depend on stroke widths');
});

test('fitLayout grows and shifts a layout so no ink is outside it, and says how far it moved', () => {
  const lay = {
    width: 100, height: 60, xh: 34, baselines: [40],
    strokes: [{ pts: [{ x: -6, y: -20, w: 1 }, { x: 90, y: 30, w: 1 }, { x: 120, y: 70, w: 1 }] }],
  };
  const moved = R.fitLayout(lay, 3);
  assert.equal(moved.dx, 9);
  assert.equal(moved.dy, 23);
  const pts = lay.strokes[0].pts;
  assert.ok(pts.every((p) => p.x >= 3 && p.y >= 3));
  assert.ok(pts.every((p) => p.x <= lay.width - 3 && p.y <= lay.height - 3), 'the box covers the ink on every side');
  assert.equal(lay.baselines[0], 63, 'baselines move with the ink');
  // a layout that already fits is left alone
  const fine = { width: 100, height: 60, xh: 34, baselines: [40], strokes: [{ pts: [{ x: 10, y: 10, w: 1 }, { x: 50, y: 40, w: 1 }] }] };
  assert.deepEqual(R.fitLayout(fine, 3), { dx: 0, dy: 0 });
  assert.equal(fine.height, 60);
});
