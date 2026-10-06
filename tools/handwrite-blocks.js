#!/usr/bin/env node
/*
 * Writes blocks of text or math in a person's handwriting as transparent SVGs, ready to be placed
 * on a PDF with tools/place_on_pdf.py.
 *
 *   node tools/handwrite-blocks.js <my-handwriting.json> <blocks.json> <outDir>
 *
 * blocks.json:
 *   {
 *     "ink": "#1749b3",          // pen colour
 *     "xhPt": 9.5,               // height of a lowercase letter on the page, in points
 *     "blocks": [
 *       { "name": "1a", "page": 0, "x": 92, "y": 270, "width": 470,   // top-left and width, in PDF points
 *         "text": "Some answer.", "kind": "text",                      // "text", or "math" for TeX-style input
 *         "lineHeight": 2.5, "seed": 1 }                               // both optional
 *     ],
 *     "marks": [                                                      // hand-drawn lines, e.g. on a graph
 *       { "page": 1, "points": [[222, 125], [322, 125], [322, 185]], "arrow": true }
 *     ]
 *   }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const S = require(path.join(root, 'src/style'));
const Y = require(path.join(root, 'src/synth'));
const M = require(path.join(root, 'src/math'));
const R = require(path.join(root, 'src/render'));
const G = require(path.join(root, 'src/geometry'));

const [, , exportFile, blocksFile, outDir] = process.argv;
if (!exportFile || !blocksFile || !outDir) {
  console.error('usage: node tools/handwrite-blocks.js <my-handwriting.json> <blocks.json> <outDir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const spec = JSON.parse(fs.readFileSync(blocksFile, 'utf8'));
const style = S.buildStyle(S.fromJSON(fs.readFileSync(exportFile, 'utf8')));
const XH = 34; // engine pixels per lowercase height
const xhPt = spec.xhPt || 9.5;
const K = xhPt / XH; // engine px -> PDF points
const render = { ink: spec.ink || '#1749b3', pen: 1, constant: true, paper: 'none' };

const manifest = { blocks: [], marks: [], penPt: 0.12 * xhPt, ink: render.ink };
for (const b of spec.blocks || []) {
  const kind = b.kind === 'math' ? M : Y;
  const lay = kind.layout(style, b.text, {
    xh: XH,
    width: Math.round(b.width / K),
    lineHeight: b.lineHeight || (b.kind === 'math' ? 3.0 : 2.5),
    seed: b.seed || 1,
    margin: 2,
    messiness: 0.3,
    variation: 0.4,
  });
  // a tall letter on the first line (digits, brackets, l, h) can reach above the box; grow the box to hold it,
  // and move it back by the same amount so the writing still lands where it was asked for
  const moved = R.fitLayout(lay, 0.1 * XH);
  fs.writeFileSync(path.join(outDir, b.name + '.svg'), R.toSVG(lay, render));
  manifest.blocks.push({ name: b.name, page: b.page, x: b.x - moved.dx * K, y: b.y - moved.dy * K, w: lay.width * K, h: lay.height * K, missing: lay.missing });
  if (lay.missing.length) console.warn(`${b.name}: no sample for ${lay.missing.join(' ')} (skipped)`);
}

// a slightly wobbly line between points, with an optional arrowhead
function wobble(p0, p1, rng) {
  const n = 40;
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
  const nx = -(p1[1] - p0[1]) / len;
  const ny = (p1[0] - p0[0]) / len;
  const ph = rng() * 6;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = 0.45 * xhPt / 9.5 * Math.sin(t * 5 + ph) * Math.sin(Math.PI * t);
    out.push({ x: p0[0] + (p1[0] - p0[0]) * t + nx * w, y: p0[1] + (p1[1] - p0[1]) * t + ny * w });
  }
  return out;
}
const rng = G.mulberry32(7);
for (const m of spec.marks || []) {
  const lines = [];
  for (let i = 0; i + 1 < m.points.length; i++) lines.push(wobble(m.points[i], m.points[i + 1], rng));
  if (m.arrow && m.points.length >= 2) {
    const a = m.points[m.points.length - 2];
    const b = m.points[m.points.length - 1];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h = 0.55 * xhPt;
    lines.push([
      { x: b[0] - h * Math.cos(ang - 0.45), y: b[1] - h * Math.sin(ang - 0.45) },
      { x: b[0], y: b[1] },
      { x: b[0] - h * Math.cos(ang + 0.45), y: b[1] - h * Math.sin(ang + 0.45) },
    ]);
  }
  manifest.marks.push({ page: m.page, lines });
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`wrote ${manifest.blocks.length} blocks and ${manifest.marks.length} marks to ${outDir}`);
