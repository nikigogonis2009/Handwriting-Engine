/*
 * Cuts one captured word into letters.
 * Coordinates: y up, baseline at 0, x-height = 1, slant removed.
 * The cuts follow the pen path instead of a vertical line, so loops and joins stay with the
 * right letter. It is a small DP over candidate cut points, using how cheap a place is to cut,
 * the expected letter widths, and whether a letter's height fits (ascender, x-height, descender).
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;

  const STEP = 0.03; // resampling step, in x-heights
  // Gaussian smoothing of raw pen data, in samples. Small, quick handwriting has pen tremor that
  // shows up as jagged strokes once it is enlarged, so this is fairly strong.
  const SMOOTH_SIGMA = 2.4;

  // ---- priors ---------------------------------------------------------------------------

  const LOWER = {
    a: 0.95, b: 0.9, c: 0.8, d: 0.95, e: 0.85, f: 0.7, g: 0.95, h: 0.95, i: 0.45, j: 0.5,
    k: 0.9, l: 0.5, m: 1.4, n: 0.95, o: 0.9, p: 0.95, q: 0.95, r: 0.75, s: 0.75, t: 0.7,
    u: 0.95, v: 0.85, w: 1.3, x: 0.9, y: 0.9, z: 0.8,
  };
  const PUNCT = {
    '.': 0.3, ',': 0.3, "'": 0.25, '"': 0.5, '-': 0.6, '!': 0.3, '?': 0.75, ':': 0.3, ';': 0.35,
    '(': 0.45, ')': 0.45, '/': 0.6, '&': 1.1, '@': 1.3, '#': 1.0, '%': 1.3, '+': 0.8, '=': 0.8,
    '*': 0.6, $: 0.8,
  };

  function defaultWidth(ch) {
    if (LOWER[ch] !== undefined) return LOWER[ch];
    if (PUNCT[ch] !== undefined) return PUNCT[ch];
    if (ch >= 'A' && ch <= 'Z') {
      if (ch === 'M') return 1.6;
      if (ch === 'W') return 1.7;
      if (ch === 'I') return 0.45;
      if (ch === 'J') return 0.8;
      return 1.2;
    }
    if (ch >= '0' && ch <= '9') return ch === '1' ? 0.6 : 0.9;
    return 0.9;
  }

  const classCache = new Map();
  function heightClass(ch) {
    let c = classCache.get(ch);
    if (!c) {
      c = {
        asc: 'bdfhkl'.includes(ch),
        tee: ch === 't',
        tall: /[A-Z0-9]/.test(ch),
        low: 'acemnorsuvwxz'.includes(ch),
        desc: 'gjpqy'.includes(ch),
        noDesc: 'abcdehiklmnorstuvwx'.includes(ch),
      };
      classCache.set(ch, c);
    }
    return c;
  }

  let boxBuf = new Float64Array(0);

  function heightCostK(k, minY, maxY) {
    let c = 0;
    if (k.asc) c += Math.max(0, 1.45 - maxY) * 2;
    else if (k.tee) c += Math.max(0, 0.95 - maxY) * 2 + Math.max(0, maxY - 1.8) * 1.5;
    else if (k.tall) c += Math.max(0, 1.35 - maxY) * 2;
    else if (k.low) c += Math.max(0, maxY - 1.3) * 2 + Math.max(0, 0.7 - maxY) * 2;
    if (k.desc) c += Math.max(0, minY + 0.35) * 2;
    else if (k.noDesc) c += Math.max(0, -0.4 - minY) * 1.5;
    return c;
  }

  /** How badly a letter's vertical extent contradicts what the character should look like. */
  function heightCost(ch, b) {
    return heightCostK(heightClass(ch), b.minY, b.maxY);
  }

  // ---- normalisation --------------------------------------------------------------------

  const IDENTITY = { s: 1, dy: 0 };
  // How tall / deep letters usually are, in x-heights. learnProfile() replaces these with the
  // writer's own numbers once enough words have been measured.
  const DEFAULT_PROFILE = { asc: 1.85, tee: 1.35, tall: 1.8, dot: 1.55, desc: -0.85 };

  /**
   * raw = {text, strokes:[[ [x,y,t,p], ... ]], xh, baseline}; canvas pixels, y down.
   * view = {s, dy}: the writer's real x-height as a fraction of the guide's, and how far below
   * the guide baseline their real baseline sits (in guide x-heights). Words are normalised to
   * their own baseline and x-height, since people rarely write exactly at the guide size.
   */
  function normalize(raw, view) {
    const v = view || IDENTITY;
    const xh = raw.xh * v.s;
    const base = raw.baseline + v.dy * raw.xh;
    let minX = Infinity;
    for (const s of raw.strokes) for (const pt of s) minX = Math.min(minX, pt[0]);
    const out = [];
    for (const s of raw.strokes) {
      const pts = [];
      for (const pt of s) {
        const q = {
          x: (pt[0] - minX) / xh,
          y: (base - pt[1]) / xh,
          t: pt[2] || 0,
          p: pt[3] == null ? 0.5 : pt[3],
        };
        const last = pts[pts.length - 1];
        if (last && Math.abs(last.x - q.x) < 1e-9 && Math.abs(last.y - q.y) < 1e-9) continue;
        pts.push(q);
      }
      if (pts.length) out.push(pts);
    }
    return out;
  }

  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /** Resample + smooth one stroke and attach a width factor `w` per point. */
  function cleanStroke(s, stats) {
    const rs = G.resample(s, STEP);
    const sm = rs.length >= 8 ? G.smooth(rs, SMOOTH_SIGMA, ['p']) : rs;
    if (stats && stats.hasPressure) {
      const pm = stats.pMean || 0.5;
      for (const pt of sm) pt.w = clamp(0.5 + 0.5 * (pt.p / pm), 0.4, 1.8);
    } else {
      // speed based: faster -> thinner, like a real pen
      const v = [];
      for (let i = 0; i < sm.length; i++) {
        const a = sm[Math.max(0, i - 1)];
        const b = sm[Math.min(sm.length - 1, i + 1)];
        const dt = Math.max(1, b.t - a.t);
        v.push((G.dist(a, b) / dt) * 1000);
      }
      const vs = sm.length >= 8 ? G.smooth(v.map((x) => ({ x, y: 0 })), 3).map((q) => q.x) : v;
      const vm = (stats && stats.vMed) || median(vs) || 1;
      for (let i = 0; i < sm.length; i++) sm[i].w = clamp(1.12 - 0.2 * (vs[i] / vm - 1), 0.7, 1.3);
    }
    return sm;
  }

  function estimateSlant(strokes) {
    const sx = [];
    const sy = [];
    const sw = [];
    let total = 0;
    for (const s of strokes) {
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1];
        const b = s[i];
        const ym = (a.y + b.y) / 2;
        if (ym < 0.05 || ym > 1.25) continue;
        const dy = Math.abs(b.y - a.y);
        sx.push((a.x + b.x) / 2);
        sy.push(ym);
        sw.push(dy);
        total += dy;
      }
    }
    if (total < 0.8) return null;
    const BINS = 512;
    const hist = new Float64Array(BINS);
    let best = 0;
    let bestScore = -1;
    for (let th = -0.45; th <= 0.65; th += 0.025) {
      const tn = Math.tan(th);
      hist.fill(0);
      for (let i = 0; i < sx.length; i++) {
        const bin = Math.floor((sx[i] - sy[i] * tn) / 0.05) + 64;
        if (bin >= 0 && bin < BINS) hist[bin] += sw[i];
      }
      let score = 0;
      for (let i = 0; i < BINS; i++) score += hist[i] * hist[i];
      score *= 1 - 0.15 * Math.abs(th); // mild preference for upright on ties
      if (score > bestScore) {
        bestScore = score;
        best = th;
      }
    }
    return best;
  }

  /** Clean strokes + raw slant estimate (null when there is too little to judge from). */
  function preprocess(raw, stats, view) {
    const v = view || IDENTITY;
    const strokes = normalize(raw, v).map((s) => cleanStroke(s, stats));
    return { strokes, slant: strokes.length ? estimateSlant(strokes) : null, view: v };
  }

  /**
   * First guess at a word's baseline and x-height. The word's text says roughly how tall and
   * how deep its ink should be (a "b" reaches ~1.9 x-heights, a "g" drops ~0.85, an "o" only
   * fills the x-height), so the ink extent gives the size and the ink bottom gives the baseline.
   */
  function initialView(raw, prof) {
    const P = prof || DEFAULT_PROFILE;
    let top = Infinity;
    let bottom = -Infinity;
    for (const s of raw.strokes) {
      for (const p of s) {
        top = Math.min(top, p[1]);
        bottom = Math.max(bottom, p[1]);
      }
    }
    if (!isFinite(top) || bottom - top < 1) return IDENTITY;
    let up = 1.0; // nominal top of the tallest letter, in x-heights
    let down = 0; // nominal depth of the deepest letter
    for (const ch of Array.from(raw.text)) {
      const k = heightClass(ch);
      if (k.asc) up = Math.max(up, P.asc);
      else if (k.tall) up = Math.max(up, P.tall);
      else if (ch === 'i' || ch === 'j') up = Math.max(up, P.dot);
      else if (k.tee) up = Math.max(up, P.tee);
      if (k.desc) down = Math.min(down, P.desc);
      else if (ch === ',' || ch === ';') down = Math.min(down, -0.3);
    }
    const s = clamp((bottom - top) / raw.xh / (up - down), 0.25, 1.6);
    // baseline (canvas y) = ink bottom raised by the nominal depth
    const baselinePx = bottom + down * s * raw.xh;
    return { s, dy: (baselinePx - raw.baseline) / raw.xh };
  }

  /**
   * Correct a word's baseline and x-height using its own aligned letters. The bottoms of
   * letters that don't descend should sit at 0; the tops of x-height letters at 1, and the tops
   * of tall letters at the writer's usual ascender height. Every letter votes, using medians so
   * a few badly cut ones don't matter.
   */
  function refinedView(view, units, prof) {
    const P = prof || DEFAULT_PROFILE;
    const bottoms = [];
    for (const u of units) {
      const k = heightClass(u.ch);
      if (k.low || k.asc || k.tee || k.tall) bottoms.push(u.box.minY);
    }
    if (bottoms.length < 2) return view;
    const b = median(bottoms);
    const votes = [];
    for (const u of units) {
      const k = heightClass(u.ch);
      const h = u.box.maxY - b;
      if (k.low) votes.push(h);
      else if (k.asc) votes.push(h / P.asc);
      else if (k.tall) votes.push(h / P.tall);
    }
    if (votes.length < 2) return view;
    const h = median(votes);
    if (!(h > 0.2)) return view;
    return { s: clamp(view.s * h, 0.2, 2), dy: view.dy - b * view.s };
  }

  // Letter spacing is judged by nearest ink, like a writer does by eye, not by bounding boxes: a
  // loop, tail or crossbar shouldn't push the next letter away. The ink of a letter is summarised
  // as its rightmost and leftmost x in each horizontal band.
  const PB = 0.1; // band height, x-heights
  const PY0 = -1.4;
  const PN = 40;

  function inkProfile(u) {
    if (u._prof) return u._prof;
    const R = new Float64Array(PN).fill(-Infinity);
    const L = new Float64Array(PN).fill(Infinity);
    const add = (pts) => {
      for (const p of pts) {
        const b = Math.floor((p.y - PY0) / PB);
        if (b < 0 || b >= PN) continue;
        if (p.x > R[b]) R[b] = p.x;
        if (p.x < L[b]) L[b] = p.x;
      }
    };
    for (const s of u.strokes) add(s.pts);
    for (const m of u.marks) add(m.pts);
    u._prof = { R, L };
    return u._prof;
  }

  /**
   * How much the translation of B must exceed A's so the nearest ink of the two is exactly 0 apart;
   * i.e. "base": placing B at tx_B = tx_A + clearance - base leaves `clearance` between them.
   * Bands next to each other count, so a diagonal approach is seen. null if they never overlap
   * vertically (a comma beside a t, say).
   */
  function inkBase(a, b) {
    const pa = inkProfile(a);
    const pb = inkProfile(b);
    let base = Infinity;
    for (let i = 0; i < PN; i++) {
      if (!isFinite(pa.R[i])) continue;
      for (let d = -1; d <= 1; d++) {
        const j = i + d;
        if (j < 0 || j >= PN || !isFinite(pb.L[j])) continue;
        base = Math.min(base, pb.L[j] - pa.R[i]);
      }
    }
    return isFinite(base) ? base : null;
  }

  /** How far a letter's height is from this writer's usual for that letter (0 = typical). */
  function deviation(u, prof) {
    const k = heightClass(u.ch);
    if (k.low) return Math.abs(u.box.maxY - 1);
    if (k.asc) return Math.abs(u.box.maxY - prof.asc) / prof.asc;
    if (k.tall) return Math.abs(u.box.maxY - prof.tall) / prof.tall;
    if (k.tee) return Math.abs(u.box.maxY - prof.tee) / prof.tee;
    if (k.desc) return Math.abs(u.box.minY - prof.desc) / Math.abs(prof.desc);
    return 0;
  }

  /**
   * The writer's own letter proportions, measured on words whose size is reliably known (those
   * with several x-height letters, so the x-height itself can be read off them).
   * aligned: [{units, ...}] as returned by alignWord for a fitted word.
   */
  function learnProfile(aligned) {
    const pick = (test, val) => {
      const v = [];
      for (const w of aligned) {
        if (!w.ok) continue;
        if (w.units.filter((u) => heightClass(u.ch).low).length < 3) continue;
        for (const u of w.units) if (test(u.ch)) v.push(val(u));
      }
      return v.length >= 6 ? median(v) : null;
    };
    const P = Object.assign({}, DEFAULT_PROFILE);
    const asc = pick((c) => heightClass(c).asc, (u) => u.box.maxY);
    const tee = pick((c) => c === 't', (u) => u.box.maxY);
    const tall = pick((c) => heightClass(c).tall, (u) => u.box.maxY);
    const desc = pick((c) => heightClass(c).desc, (u) => u.box.minY);
    // how big, and where on the pad's baseline, this writer's x-height is (read off the same words)
    const views = aligned.filter((w) => w.ok && w.view && w.units.filter((u) => heightClass(u.ch).low).length >= 3).map((w) => w.view);
    if (views.length >= 5) {
      P.s = median(views.map((v) => v.s));
      P.dy = median(views.map((v) => v.dy));
    }
    if (asc) P.asc = clamp(asc, 1.3, 2.6);
    if (tee) P.tee = clamp(tee, 1.0, 2.0);
    if (tall) P.tall = clamp(tall, 1.3, 2.6);
    if (desc) P.desc = clamp(desc, -1.4, -0.4);
    return P;
  }

  /**
   * Find the baseline and x-height of a word: start from the text-based guess, align, measure
   * the result against what the letters should look like, and repeat until it settles.
   * Returns {prep, res}: the prepared word (strokes normalised to that baseline and x-height)
   * and its alignment.
   */
  function fitView(raw, stats, prof) {
    let view = initialView(raw, prof);
    let best = null;
    for (let round = 0; round < 4; round++) {
      const prep = preprocess(raw, stats, view);
      let res;
      try {
        res = alignWord(raw, { stats, prepared: prep });
      } catch {
        res = { ok: false };
      }
      const q = res.ok ? res.quality : Infinity;
      if (!best || q < best.q) best = { prep, res, q };
      if (!res.ok) break;
      const next = refinedView(view, res.units, prof);
      const moved = Math.abs(next.s / view.s - 1) + Math.abs(next.dy - view.dy) / view.s;
      view = next;
      if (moved < 0.04) break;
    }
    if (best) return { prep: best.prep, res: best.res };
    return { prep: preprocess(raw, stats, initialView(raw, prof)), res: { ok: false } };
  }

  /** Words made only of symbols have nothing to size them by, so they take the writer's usual size and baseline. */
  function fitFixed(raw, stats, view) {
    const prep = preprocess(raw, stats, view);
    let res;
    try {
      res = alignWord(raw, { stats, prepared: prep });
    } catch {
      res = { ok: false };
    }
    return { prep, res };
  }

  function strokeInfo(s) {
    let minX = Infinity;
    let maxX = -Infinity;
    let sx = 0;
    let sy = 0;
    for (const p of s) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      sx += p.x;
      sy += p.y;
    }
    return { minX, maxX, cx: sx / s.length, cy: sy / s.length, len: G.pathLength(s) };
  }

  /** Small strokes written *after* something further right (i-dots, t-bars written late). */
  function splitDelayed(strokes) {
    const primary = [];
    const delayed = [];
    let maxX = -Infinity;
    for (const s of strokes) {
      const info = strokeInfo(s);
      if (primary.length && info.len < 2.2 && info.cy > 0.25 && info.cx < maxX - 0.4) delayed.push(s);
      else {
        primary.push(s);
        maxX = Math.max(maxX, info.maxX);
      }
    }
    return { primary, delayed };
  }

  // ---- cut costs ------------------------------------------------------------------------

  /** Do two polylines cross each other? (bounding-box pruned segment intersection) */
  function polylinesCross(a, b) {
    const ccw = (p, q, r) => (r.y - p.y) * (q.x - p.x) - (q.y - p.y) * (r.x - p.x);
    for (let i = 1; i < a.length; i++) {
      const a0 = a[i - 1];
      const a1 = a[i];
      const ax0 = Math.min(a0.x, a1.x);
      const ax1 = Math.max(a0.x, a1.x);
      const ay0 = Math.min(a0.y, a1.y);
      const ay1 = Math.max(a0.y, a1.y);
      for (let j = 1; j < b.length; j++) {
        const b0 = b[j - 1];
        const b1 = b[j];
        if (Math.max(b0.x, b1.x) < ax0 || Math.min(b0.x, b1.x) > ax1 || Math.max(b0.y, b1.y) < ay0 || Math.min(b0.y, b1.y) > ay1) continue;
        if (ccw(a0, a1, b0) * ccw(a0, a1, b1) < 0 && ccw(b0, b1, a0) * ccw(b0, b1, a1) < 0) return true;
      }
    }
    return false;
  }

  /** 0..1: how much of the narrower of two strokes' x-ranges lies inside the other's. */
  function xOverlap(a, b) {
    const w = Math.max(0.15, Math.min(a.maxX - a.minX, b.maxX - b.minX));
    return clamp((Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) / w, 0, 1);
  }

  function computeCutCosts(P, first, sStart, sEnd, sId, strokeMaxX, strokeDot, together) {
    const N = P.length;
    const cost = new Float64Array(N + 1).fill(Infinity);
    const W = 4;
    for (let k = 1; k < N; k++) {
      if (first[k]) {
        const prevMax = strokeMaxX[sId[k] - 1];
        const over = prevMax - P[k].x;
        cost[k] = clamp((over - 0.25) * 1.5, 0, 2) + (strokeDot[sId[k]] ? 2.5 : 0); // a dot belongs to the letter before it
        cost[k] += together[sId[k]]; // strokes that cross or sit on top of each other are one letter (x, a t and its bar)
        continue;
      }
      const si = sId[k];
      if (k - sStart[si] < W || sEnd[si] - k < W) continue;
      const a = P[k - W];
      const b = P[k + W];
      const m = P[k];
      const v1x = m.x - a.x;
      const v1y = m.y - a.y;
      const v2x = b.x - m.x;
      const v2y = b.y - m.y;
      const turn = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
      const cx = b.x - a.x;
      const cl = Math.hypot(cx, b.y - a.y) || 1e-9;
      const dxn = cx / cl;
      let c = 0.5;
      const y = m.y;
      if (y >= -0.05 && y <= 0.6) c += 0;
      else if (y > 0.6 && y <= 1.15) c += 0.4;
      else c += 3;
      c += 2.5 * Math.max(0, 0.15 - dxn) * 4;
      c += 1.5 * (turn / (Math.PI / 2));
      cost[k] = c;
    }
    return cost;
  }

  // ---- main entry -----------------------------------------------------------------------

  /**
   * @param raw   {text, strokes, xh, baseline}
   * @param opts  {stats: {hasPressure, pMean, vMed}, slantHint (rad), prepared (from preprocess), widths}
   * @returns {ok, units, slant, quality, reason}
   */
  function alignWord(raw, opts) {
    opts = opts || {};
    const chars = Array.from(raw.text);
    const n = chars.length;
    const prep = opts.prepared || preprocess(raw, opts.stats);
    const strokes = prep.strokes.map((s) => s.map(G.copyPt)); // deslanting below edits in place
    if (!strokes.length || n === 0) return { ok: false, reason: 'empty' };

    // de-slant. A single short word has too few upright strokes to judge slant from, so when
    // the caller knows the writer's overall slant, a word may only deviate a little from it.
    const hint = opts.slantHint;
    let slant = prep.slant;
    if (slant === null) slant = hint !== undefined ? hint : 0;
    else if (hint !== undefined) slant = clamp(slant, hint - 0.1, hint + 0.1);
    const tn = Math.tan(slant);
    for (const s of strokes) for (const p of s) p.x -= p.y * tn;
    // shift so the word starts at x = 0
    let minX = Infinity;
    for (const s of strokes) for (const p of s) minX = Math.min(minX, p.x);
    for (const s of strokes) for (const p of s) p.x -= minX;

    if (n === 1) {
      const unit = buildUnit(chars[0], strokes.map((pts) => ({ pts, entryMid: false, exitMid: false })), []);
      return { ok: true, units: [unit], slant, quality: 0, view: prep.view };
    }

    const { primary, delayed } = splitDelayed(strokes);

    // path
    const P = [];
    const sId = [];
    const first = [];
    const sStart = [];
    const sEnd = [];
    const strokeMaxX = [];
    const strokeDot = [];
    const strokeInfos = [];
    primary.forEach((s, si) => {
      sStart.push(P.length);
      let mx = -Infinity;
      s.forEach((pt, k) => {
        P.push(pt);
        sId.push(si);
        first.push(k === 0);
        mx = Math.max(mx, pt.x);
      });
      sEnd.push(P.length - 1);
      strokeMaxX.push(mx);
      const inf = strokeInfo(s);
      strokeDot.push(inf.len < 0.35 && inf.cy > 1.0);
      strokeInfos.push(inf);
    });
    const N = P.length;
    if (N < n * 3) return { ok: false, reason: 'too short' };

    // how strongly each stroke belongs with the one before it
    const together = primary.map((st, si) => {
      if (si === 0 || strokeDot[si]) return 0;
      let c = 0;
      if (polylinesCross(primary[si - 1], st)) c += 3;
      c += 1.5 * Math.max(0, xOverlap(strokeInfos[si - 1], strokeInfos[si]) - 0.4);
      return c;
    });
    const cutCost = computeCutCosts(P, first, sStart, sEnd, sId, strokeMaxX, strokeDot, together);
    const isMid = (c) => c > 0 && c < N && !first[c];

    // expected widths
    const widths = opts.widths || {};
    const prior = chars.map((c) => (widths[c] !== undefined ? widths[c] : defaultWidth(c)));
    const priorSum = prior.reduce((a, b) => a + b, 0);
    let allMin = Infinity;
    let allMax = -Infinity;
    for (const p of P) {
      allMin = Math.min(allMin, p.x);
      allMax = Math.max(allMax, p.x);
    }
    const alpha = clamp((allMax - allMin) / priorSum, 0.6, 1.8);
    const LW = 2.0; // weight of the width term
    const HW = 2.0; // weight of the ascender / descender term
    const hk = chars.map(heightClass);
    const wMaxAll = 3 * alpha * Math.max.apply(null, prior) + 0.8;

    // candidate nodes
    const nodes = [0];
    for (let k = 1; k < N; k++) {
      if (first[k]) nodes.push(k);
      else if (k % 2 === 0 && cutCost[k] < 3.0) nodes.push(k);
    }
    nodes.push(N);
    const M = nodes.length;
    if (M - 1 < n) return { ok: false, reason: 'too few cut points' };

    // extents of every node pair, only while a segment can still have a plausible width
    const need = M * M * 4;
    if (boxBuf.length < need) boxBuf = new Float64Array(need);
    const bb = boxBuf;
    const jEnd = new Int32Array(M);
    for (let i = 0; i < M - 1; i++) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      let k = nodes[i];
      jEnd[i] = i;
      for (let j = i + 1; j < M; j++) {
        const c = nodes[j];
        while (k < c) {
          const p = P[k];
          if (p.x < x0) x0 = p.x;
          if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
          k++;
        }
        let bx0 = x0;
        let bx1 = x1;
        let by0 = y0;
        let by1 = y1;
        if (isMid(c)) {
          const p = P[c];
          if (p.x < bx0) bx0 = p.x;
          if (p.x > bx1) bx1 = p.x;
          if (p.y < by0) by0 = p.y;
          if (p.y > by1) by1 = p.y;
        }
        if (bx1 - bx0 > wMaxAll) break;
        const o = (i * M + j) * 4;
        bb[o] = bx0;
        bb[o + 1] = bx1;
        bb[o + 2] = by0;
        bb[o + 3] = by1;
        jEnd[i] = j;
      }
    }

    const segCost = (l, o) => {
      const e = alpha * prior[l];
      const r = (bb[o + 1] - bb[o] - e) / Math.max(e, 0.35);
      return LW * r * r + HW * heightCostK(hk[l], bb[o + 2], bb[o + 3]);
    };

    // DP
    const INF = 1e18;
    let prev = new Float64Array(M).fill(INF);
    prev[0] = 0;
    const back = [];
    for (let l = 0; l < n; l++) {
      const cur = new Float64Array(M).fill(INF);
      const bk = new Int32Array(M).fill(-1);
      const e = alpha * prior[l];
      const wLimit = 3 * e + 0.8; // beyond this the width term alone is > 8: never optimal
      for (let j = 1; j < M; j++) {
        const last = j === M - 1;
        if (l < n - 1 && last) continue;
        if (l === n - 1 && !last) continue;
        const cj = last ? 0 : cutCost[nodes[j]];
        if (l === 0) {
          if (jEnd[0] >= j) {
            cur[j] = segCost(l, j * 4) + cj; // starts at node 0
            bk[j] = 0;
          }
          continue;
        }
        for (let i = j - 1; i >= 1; i--) {
          if (jEnd[i] < j) break;
          const o = (i * M + j) * 4;
          if (bb[o + 1] - bb[o] > wLimit) break;
          if (prev[i] >= INF) continue;
          const v = prev[i] + segCost(l, o) + cj;
          if (v < cur[j]) {
            cur[j] = v;
            bk[j] = i;
          }
        }
      }
      back.push(bk);
      prev = cur;
    }
    if (prev[M - 1] >= INF) return { ok: false, reason: 'no alignment' };
    const seq = [M - 1];
    for (let l = n - 1; l >= 0; l--) seq.push(back[l][seq[seq.length - 1]]);
    seq.reverse(); // node indices: 0 .. M-1, length n+1
    const quality = prev[M - 1] / n;

    // units
    const units = [];
    for (let l = 0; l < n; l++) {
      const a = nodes[seq[l]];
      const c = nodes[seq[l + 1]];
      const lastIdx = isMid(c) ? c : c - 1;
      const pieces = [];
      let curPiece = null;
      for (let k = a; k <= lastIdx; k++) {
        if (!curPiece || curPiece.sid !== sId[k] || (first[k] && k !== a)) {
          curPiece = { sid: sId[k], pts: [] };
          pieces.push(curPiece);
        }
        curPiece.pts.push(G.copyPt(P[k]));
      }
      const entryMid = a > 0 && !first[a];
      const exitMid = isMid(c);
      const strokesOut = pieces.map((pc, idx) => ({
        pts: pc.pts,
        entryMid: idx === 0 ? entryMid : false,
        exitMid: idx === pieces.length - 1 ? exitMid : false,
      }));
      units.push(buildUnit(chars[l], strokesOut, []));
    }

    // attach delayed strokes (i-dots, t-bars, ...)
    for (const d of delayed) assignMark(units, d);

    return { ok: true, units, slant, quality, view: prep.view };
  }

  function boxOf(pieces) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pc of pieces) {
      for (const p of pc.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  function buildUnit(ch, strokesOut, marks) {
    const firstPiece = strokesOut[0];
    const lastPiece = strokesOut[strokesOut.length - 1];
    const f = firstPiece.pts[0];
    const l = lastPiece.pts[lastPiece.pts.length - 1];
    const fd = G.dirAt(firstPiece.pts, 0, 4);
    const ld = G.dirAt(lastPiece.pts, lastPiece.pts.length - 1, 4);
    return {
      ch,
      strokes: strokesOut,
      marks,
      entry: { x: f.x, y: f.y, dx: fd.dx, dy: fd.dy, mid: firstPiece.entryMid },
      exit: { x: l.x, y: l.y, dx: ld.dx, dy: ld.dy, mid: lastPiece.exitMid },
      box: boxOf(strokesOut),
      hc: heightCost(ch, boxOf(strokesOut)),
    };
  }

  function assignMark(units, stroke) {
    const info = strokeInfo(stroke);
    const owners = 'ijtf:;!?"\'';
    const score = (u) => {
      const lo = u.box.minX - 0.1;
      const hi = u.box.maxX + 0.1;
      let d = 0;
      if (info.cx < lo) d = lo - info.cx;
      else if (info.cx > hi) d = info.cx - hi;
      if (owners.includes(u.ch)) d -= 0.15;
      return d + 0.001 * Math.abs(info.cx - (u.box.minX + u.box.maxX) / 2);
    };
    // a long bar spanning several t/f letters is cut between them
    if (info.len > 0.9 && info.maxX - info.minX > 0.8) {
      const tu = units.filter((u) => 'tf'.includes(u.ch) && (u.box.minX + u.box.maxX) / 2 > info.minX && (u.box.minX + u.box.maxX) / 2 < info.maxX);
      if (tu.length >= 2) {
        const centers = tu.map((u) => (u.box.minX + u.box.maxX) / 2);
        const cuts = [];
        for (let i = 0; i < centers.length - 1; i++) cuts.push((centers[i] + centers[i + 1]) / 2);
        let pieces = [[]];
        let ci = 0;
        for (const p of stroke) {
          if (ci < cuts.length && p.x > cuts[ci]) {
            const prevPt = pieces[pieces.length - 1].slice(-1)[0];
            const shared = G.copyPt(p);
            if (prevPt) pieces[pieces.length - 1].push(shared);
            pieces.push([G.copyPt(p)]);
            ci++;
          } else pieces[pieces.length - 1].push(p);
        }
        pieces.forEach((pts, i) => {
          if (pts.length >= 2 && tu[i]) tu[i].marks.push({ pts });
        });
        return;
      }
    }
    let best = units[0];
    let bs = Infinity;
    for (const u of units) {
      // a late bar or dot that crosses a letter's strokes belongs to that letter
      const crosses = u.strokes.some((p) => polylinesCross(p.pts, stroke));
      const s = score(u) - (crosses ? 1 : 0);
      if (s < bs) {
        bs = s;
        best = u;
      }
    }
    best.marks.push({ pts: stroke });
  }

  const api = { alignWord, preprocess, fitView, fitFixed, initialView, learnProfile, deviation, inkBase, DEFAULT_PROFILE, heightCost, defaultWidth, normalize, cleanStroke, estimateSlant, splitDelayed, median, STEP };
  root.HW = root.HW || {};
  root.HW.align = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
