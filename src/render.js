/*
 * Strokes to filled ink outlines, as SVG path data. Used for the canvas, SVG export and PNG export.
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;

  const f2 = (v) => (Math.round(v * 100) / 100).toString();

  function smoothstep(t) {
    t = Math.min(1, Math.max(0, t));
    return t * t * (3 - 2 * t);
  }

  function dotPath(x, y, r) {
    return `M${f2(x - r)} ${f2(y)}a${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0a${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0Z`;
  }

  // The constant pen is 0.12 x-heights wide at a pen thickness of 1. That is a Notability pen at
  // thickness 3 (1.2 pt wide) against a lowercase x-height of about 10 pt, measured from a sample page.
  const CONSTANT_W = 0.12 / 0.085;

  /**
   * stroke: {pts:[{x,y,w}], taperStart, taperEnd} in px; taper values are in x-heights.
   * constant: one width all along with round ends, like a ballpoint in a note-taking app, ignoring w and the tapers.
   */
  function strokeToPath(stroke, penPx, xh, constant) {
    let pts = stroke.pts;
    if (!pts.length) return '';
    const len0 = G.pathLength(pts);
    const w0 = pts[0].w || 1;
    if (pts.length < 2 || len0 < 0.25 * penPx) {
      const c = pts[Math.floor(pts.length / 2)];
      return dotPath(c.x, c.y, 0.5 * penPx * (constant ? CONSTANT_W : (c.w || 1) * 1.05));
    }
    const spacing = len0 / (pts.length - 1);
    if (spacing > 1.4) pts = G.catmull(pts, Math.ceil(spacing / 1.2));
    const n = pts.length;
    // arc length along the stroke
    const s = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + G.dist(pts[i - 1], pts[i]));
    const total = s[n - 1];
    const tsLen = Math.max(0.5, (stroke.taperStart > 0 ? stroke.taperStart : 0.08) * xh);
    const teLen = Math.max(0.5, (stroke.taperEnd > 0 ? stroke.taperEnd : 0.08) * xh);
    const tsMin = stroke.taperStart > 0 ? 0.25 : 0.6;
    const teMin = stroke.taperEnd > 0 ? 0.25 : 0.6;

    const hw = new Array(n);
    for (let i = 0; i < n; i++) {
      if (constant) {
        hw[i] = 0.5 * penPx * CONSTANT_W;
        continue;
      }
      const w = pts[i].w !== undefined ? pts[i].w : w0;
      const a = tsMin + (1 - tsMin) * smoothstep(s[i] / tsLen);
      const b = teMin + (1 - teMin) * smoothstep((total - s[i]) / teLen);
      hw[i] = 0.5 * penPx * w * Math.min(a, b);
    }
    // never let the pen be wider than the local radius of curvature
    for (let i = 1; i < n - 1; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x;
      const by = pts[i + 1].y - pts[i].y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6) continue;
      const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      if (turn > 0.02) {
        const r = (0.5 * (la + lb)) / turn;
        if (hw[i] > 0.8 * r) hw[i] = Math.max(0.5 * hw[i], 0.8 * r);
      }
    }

    const nx = new Array(n);
    const ny = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      nx[i] = -dy;
      ny[i] = dx;
    }
    const d = [];
    const P = (x, y, first) => d.push((first ? 'M' : 'L') + f2(x) + ' ' + f2(y));
    for (let i = 0; i < n; i++) P(pts[i].x + nx[i] * hw[i], pts[i].y + ny[i] * hw[i], i === 0);
    // end cap: left -> forward -> right
    const e = n - 1;
    const edx = ny[e];
    const edy = -nx[e];
    for (let k = 1; k < 8; k++) {
      const phi = (Math.PI * k) / 8;
      P(pts[e].x + hw[e] * (Math.cos(phi) * nx[e] + Math.sin(phi) * edx), pts[e].y + hw[e] * (Math.cos(phi) * ny[e] + Math.sin(phi) * edy));
    }
    for (let i = n - 1; i >= 0; i--) P(pts[i].x - nx[i] * hw[i], pts[i].y - ny[i] * hw[i]);
    // start cap: right -> backward -> left
    const sdx = ny[0];
    const sdy = -nx[0];
    for (let k = 1; k < 8; k++) {
      const phi = (Math.PI * k) / 8;
      P(pts[0].x - hw[0] * (Math.cos(phi) * nx[0] + Math.sin(phi) * sdx), pts[0].y - hw[0] * (Math.cos(phi) * ny[0] + Math.sin(phi) * sdy));
    }
    // round joins: stamp a disc on every tight vertex (hides mitre / inner-loop artefacts)
    let discs = '';
    for (let i = 1; i < n - 1; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x;
      const by = pts[i + 1].y - pts[i].y;
      if (Math.hypot(ax, ay) < 1e-6 || Math.hypot(bx, by) < 1e-6) continue;
      const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      if (turn > 0.35) discs += dotPath(pts[i].x, pts[i].y, hw[i]);
    }
    return d.join('') + 'Z' + discs;
  }

  function layoutToPath(layout, penMult, constant) {
    const xh = layout.xh;
    const penPx = 0.085 * xh * (penMult || 1);
    const parts = [];
    for (const s of layout.strokes) parts.push(strokeToPath(s, penPx, xh, constant));
    return parts.join('');
  }

  function paperMarkup(layout, kind, lineColor) {
    const W = layout.width;
    const H = layout.height;
    const xh = layout.xh;
    const lh = layout.lineHeightPx;
    const base0 = layout.baselines[0];
    let out = '';
    if (kind === 'lined') {
      const y0 = base0 + 0.12 * xh;
      let y = y0 - Math.floor(y0 / lh) * lh;
      for (; y < H; y += lh) out += `<line x1="0" y1="${f2(y)}" x2="${W}" y2="${f2(y)}"/>`;
      out = `<g stroke="${lineColor}" stroke-width="1" opacity=".9">${out}</g>`;
      out += `<line x1="${f2(xh * 0.9)}" y1="0" x2="${f2(xh * 0.9)}" y2="${H}" stroke="#e58b8b" stroke-width="1.2" opacity=".8"/>`;
    } else if (kind === 'grid') {
      const g = Math.max(12, xh * 0.9);
      let s = '';
      for (let x = g; x < W; x += g) s += `<line x1="${f2(x)}" y1="0" x2="${f2(x)}" y2="${H}"/>`;
      for (let y = g; y < H; y += g) s += `<line x1="0" y1="${f2(y)}" x2="${W}" y2="${f2(y)}"/>`;
      out = `<g stroke="${lineColor}" stroke-width="1" opacity=".8">${s}</g>`;
    }
    return out;
  }

  /**
   * opts: {ink, pen (thickness multiplier), constant (one pen width all along), paper: 'white'|'plain'|'lined'|'grid'|'none',
   *        paperColor, lineColor}
   */
  function withDefaults(opts) {
    const o = Object.assign({ ink: '#1b1f3b', pen: 1, constant: false, paper: 'plain', paperColor: '#fffdf7', lineColor: '#b9c7e6' }, opts || {});
    if (o.paper === 'white') {
      o.paper = 'plain';
      o.paperColor = '#ffffff';
    }
    return o;
  }

  function toSVG(layout, opts) {
    const o = withDefaults(opts);
    const W = layout.width;
    const H = Math.ceil(layout.height);
    const d = layoutToPath(layout, o.pen, o.constant);
    let body = '';
    if (o.paper !== 'none') body += `<rect width="${W}" height="${H}" fill="${o.paperColor}"/>`;
    body += paperMarkup(layout, o.paper, o.lineColor);
    body += `<path d="${d}" fill="${o.ink}" fill-rule="nonzero"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  }

  function drawToCanvas(ctx, layout, opts, scale) {
    const o = withDefaults(opts);
    const sc = scale || 1;
    const W = layout.width;
    const H = Math.ceil(layout.height);
    ctx.save();
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (o.paper !== 'none') {
      ctx.fillStyle = o.paperColor;
      ctx.fillRect(0, 0, W, H);
    }
    const xh = layout.xh;
    const lh = layout.lineHeightPx;
    ctx.strokeStyle = o.lineColor;
    ctx.lineWidth = 1;
    if (o.paper === 'lined') {
      const y0 = layout.baselines[0] + 0.12 * xh;
      let y = y0 - Math.floor(y0 / lh) * lh;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (; y < H; y += lh) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
      ctx.strokeStyle = '#e58b8b';
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(xh * 0.9, 0);
      ctx.lineTo(xh * 0.9, H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (o.paper === 'grid') {
      const g = Math.max(12, xh * 0.9);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let x = g; x < W; x += g) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let y = g; y < H; y += g) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = o.ink;
    ctx.fill(new Path2D(layoutToPath(layout, o.pen, o.constant)));
    ctx.restore();
  }

  /**
   * Move and grow a layout so none of its ink is outside it (a tall letter on the first line, a long tail at the
   * right), with `pad` to spare on every side. Returns how far everything moved right and down, so a caller that
   * places the layout somewhere can move it back by the same amount and keep the writing where it was meant to be.
   */
  function fitLayout(layout, pad) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of layout.strokes) {
      for (const p of s.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) return { dx: 0, dy: 0 };
    const dx = Math.max(0, pad - minX);
    const dy = Math.max(0, pad - minY);
    if (dx || dy) {
      for (const s of layout.strokes) {
        for (const p of s.pts) {
          p.x += dx;
          p.y += dy;
        }
      }
      layout.baselines = layout.baselines.map((b) => b + dy);
    }
    layout.width = Math.max(layout.width + dx, maxX + dx + pad);
    layout.height = Math.max(layout.height + dy, maxY + dy + pad);
    return { dx, dy };
  }

  const api = { strokeToPath, layoutToPath, toSVG, drawToCanvas, fitLayout };
  root.HW = root.HW || {};
  root.HW.render = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
