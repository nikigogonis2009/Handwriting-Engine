/*
 * Small geometry helpers: resampling, smoothing, bridges between points, seeded noise.
 * Points are {x, y} plus optional t, p, w channels that are interpolated along with them.
 */
(function (root) {
  'use strict';

  const CHANNELS = ['t', 'p', 'w'];

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pathLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
    return s;
  }

  function lerpPt(a, b, u) {
    const o = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    for (const c of CHANNELS) {
      if (a[c] !== undefined && b[c] !== undefined) o[c] = a[c] + (b[c] - a[c]) * u;
      else if (a[c] !== undefined) o[c] = a[c];
    }
    return o;
  }

  function copyPt(p) {
    return Object.assign({}, p);
  }

  /** Re-sample a polyline at (almost) equal arc-length spacing. Keeps both end points. */
  function resample(pts, step) {
    if (pts.length === 0) return [];
    if (pts.length === 1) return [copyPt(pts[0]), copyPt(pts[0])];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    if (total < 1e-9) return [copyPt(pts[0]), copyPt(pts[pts.length - 1])];
    const n = Math.max(1, Math.round(total / step));
    const out = [];
    let seg = 1;
    for (let k = 0; k <= n; k++) {
      const s = (total * k) / n;
      while (seg < cum.length - 1 && cum[seg] < s) seg++;
      const span = cum[seg] - cum[seg - 1];
      const u = span > 1e-12 ? (s - cum[seg - 1]) / span : 0;
      out.push(lerpPt(pts[seg - 1], pts[seg], Math.min(1, Math.max(0, u))));
    }
    return out;
  }

  function gaussKernel(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v);
      sum += v;
    }
    return { k: k.map((v) => v / sum), r };
  }

  /**
   * Gaussian smoothing of evenly spaced points. Uses odd reflection at the ends so the
   * end points stay exactly where they are (strokes never shrink).
   * `fields` lists the channels to smooth in addition to x / y ('x','y' are always done).
   */
  function smooth(pts, sigma, fields) {
    const n = pts.length;
    if (n < 3 || sigma <= 0) return pts.map(copyPt);
    const { k, r } = gaussKernel(sigma);
    const chans = ['x', 'y'].concat(fields || []);
    const out = pts.map(copyPt);
    for (const c of chans) {
      if (pts[0][c] === undefined) continue;
      const odd = c === 'x' || c === 'y';
      const get = (i) => {
        if (i < 0) {
          const j = Math.min(n - 1, -i);
          return odd ? 2 * pts[0][c] - pts[j][c] : pts[j][c];
        }
        if (i > n - 1) {
          const j = Math.max(0, 2 * (n - 1) - i);
          return odd ? 2 * pts[n - 1][c] - pts[j][c] : pts[j][c];
        }
        return pts[i][c];
      };
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let d = -r; d <= r; d++) acc += k[d + r] * get(i + d);
        out[i][c] = acc;
      }
    }
    return out;
  }

  /** Unit direction of travel around index i using +-m samples. */
  function dirAt(pts, i, m) {
    const a = pts[Math.max(0, i - m)];
    const b = pts[Math.min(pts.length - 1, i + m)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) return { dx: 1, dy: 0 };
    return { dx: dx / l, dy: dy / l };
  }

  /** Cubic Hermite from (p0, t0) to (p1, t1); returns the interior points only. */
  function hermite(p0, t0, p1, t1, spacing) {
    const d = dist(p0, p1);
    const n = Math.max(1, Math.round(d / spacing));
    const m = d; // tangent magnitude == chord length gives an unhurried S-curve
    const out = [];
    for (let i = 1; i < n; i++) {
      const u = i / n;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      const pt = {
        x: h00 * p0.x + h10 * m * t0.dx + h01 * p1.x + h11 * m * t1.dx,
        y: h00 * p0.y + h10 * m * t0.dy + h01 * p1.y + h11 * m * t1.dy,
      };
      for (const c of CHANNELS) {
        if (p0[c] !== undefined && p1[c] !== undefined) pt[c] = p0[c] + (p1[c] - p0[c]) * u;
      }
      out.push(pt);
    }
    return out;
  }

  /** Catmull-Rom subdivision (k points per span); keeps original points. */
  function catmull(pts, k) {
    if (k <= 1 || pts.length < 3) return pts;
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      for (let j = 0; j < k; j++) {
        const u = j / k;
        const u2 = u * u;
        const u3 = u2 * u;
        const f = (a, b, c, d) =>
          0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
        const pt = { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
        for (const c of CHANNELS) {
          if (p1[c] !== undefined && p2[c] !== undefined) pt[c] = p1[c] + (p2[c] - p1[c]) * u;
        }
        out.push(pt);
      }
    }
    out.push(copyPt(pts[n - 1]));
    return out;
  }

  /** Largest change of direction (degrees) between consecutive segments. */
  function maxTurnDeg(pts) {
    let worst = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x;
      const by = pts[i + 1].y - pts[i].y;
      if (Math.hypot(ax, ay) < 1e-9 || Math.hypot(bx, by) < 1e-9) continue;
      let d = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      d = Math.abs(d) * (180 / Math.PI);
      if (d > worst) worst = d;
    }
    return worst;
  }

  // ---- randomness -------------------------------------------------------------------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rng) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Smooth 1-D value noise in [-1, 1]; lattice spacing 1. */
  function makeNoise(rng) {
    const lattice = [];
    for (let i = 0; i < 64; i++) lattice.push(rng() * 2 - 1);
    return function (x) {
      const i = Math.floor(x);
      const f = x - i;
      const a = lattice[((i % 64) + 64) % 64];
      const b = lattice[(((i + 1) % 64) + 64) % 64];
      const u = f * f * (3 - 2 * f);
      return a + (b - a) * u;
    };
  }

  const api = {
    dist,
    pathLength,
    lerpPt,
    copyPt,
    resample,
    smooth,
    dirAt,
    hermite,
    catmull,
    maxTurnDeg,
    mulberry32,
    gaussian,
    makeNoise,
  };

  root.HW = root.HW || {};
  root.HW.geometry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
