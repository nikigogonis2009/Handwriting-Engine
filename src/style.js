/*
 * What the app knows about one person's handwriting: the aligned letters, coverage, slant.
 * It is rebuilt from the raw captured words, so only those need to be saved.
 */
(function (root) {
  'use strict';
  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;
  const A = typeof require !== 'undefined' ? require('./align') : root.HW.align;

  /** Pressure / speed statistics over every captured point. */
  function computeStats(rawWords) {
    const ps = [];
    const speeds = [];
    for (const w of rawWords) {
      for (const s of w.strokes) {
        for (let i = 0; i < s.length; i++) {
          if (s[i][3] != null) ps.push(s[i][3]);
          if (i > 0) {
            const dt = s[i][2] - s[i - 1][2];
            if (dt > 0) {
              const d = Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]) / w.xh;
              speeds.push((d / dt) * 1000);
            }
          }
        }
      }
    }
    let hasPressure = false;
    let pMean = 0.5;
    if (ps.length > 20) {
      const m = ps.reduce((a, b) => a + b, 0) / ps.length;
      const v = ps.reduce((a, b) => a + (b - m) * (b - m), 0) / ps.length;
      const distinct = new Set(ps.map((p) => Math.round(p * 50))).size;
      hasPressure = v > 0.003 && distinct > 5;
      pMean = m || 0.5;
    }
    const vMed = speeds.length ? A.median(speeds) : 1;
    return { hasPressure, pMean, vMed };
  }

  // Per-word work is cached (keyed by the raw word object) so adding one word to a large set
  // only costs one alignment. The cache is invalidated when the pressure / speed statistics
  // or the writer's overall slant move noticeably.
  const cache = new WeakMap();

  function statsKey(stats) {
    return [stats.hasPressure ? 1 : 0, Math.round((stats.pMean || 0.5) * 20), Math.round(Math.log(stats.vMed || 1) * 5)].join('|');
  }

  // Words that use none of the writer's ascender / descender proportions (only a, c, e, m, n, o,
  // r, s, u, v, w, x, z) are sized from their own x-height alone, so a new profile can't change them.
  const needsProfile = (text) => /[^acemnorsuvwxz\s.,]/.test(text);
  const symbolOnly = (text) => !/[A-Za-z0-9]/.test(text);

  function alignAll(rawWords, stats) {
    const sk = statsKey(stats);
    const entries = rawWords.map((raw) => {
      let e = cache.get(raw);
      if (!e) {
        e = {};
        cache.set(raw, e);
      }
      if (e.sk !== sk) {
        e.sk = sk;
        e.fit1 = null;
        e.pk = null;
        e.aligned = null;
      }
      return e;
    });

    // Pass 1: size each word from its own letters, then learn this writer's proportions
    // (how tall their b/d/h/k/l are, how deep their descenders go).
    entries.forEach((e, i) => {
      if (!e.fit1) e.fit1 = A.fitView(rawWords[i], stats);
    });
    const profile = A.learnProfile(entries.map((e) => e.fit1.res));
    // coarse key, so adding one word doesn't re-size every word that was already done
    const pk = [profile.asc, profile.tee, profile.tall, profile.desc].map((v) => v.toFixed(1)).join('|') + '|' + (profile.s === undefined ? 'x' : profile.s.toFixed(2) + '|' + profile.dy.toFixed(1));

    // Pass 2: re-size words that depend on those proportions.
    entries.forEach((e, i) => {
      if (e.pk !== pk) {
        const text = rawWords[i].text;
        if (profile.s !== undefined && symbolOnly(text)) e.fit2 = A.fitFixed(rawWords[i], stats, { s: profile.s, dy: profile.dy });
        else e.fit2 = needsProfile(text) ? A.fitView(rawWords[i], stats, profile) : e.fit1;
        e.pk = pk;
        e.aligned = null;
      }
    });

    const slants = entries.filter((e) => e.fit2.prep.slant !== null).map((e) => e.fit2.prep.slant);
    const slantHint = slants.length >= 3 ? A.median(slants) : undefined;
    const hk = slantHint === undefined ? 'none' : Math.round(slantHint / 0.02);
    const aligned = rawWords.map((raw, i) => {
      const e = entries[i];
      if (!e.aligned || e.hk !== hk) {
        const own = e.fit2.prep.slant;
        const sameAsFit = e.fit2.res && e.fit2.res.ok && own !== null && (slantHint === undefined || Math.abs(own - slantHint) <= 0.1);
        let res = e.fit2.res;
        if (!sameAsFit) {
          try {
            res = A.alignWord(raw, { stats, slantHint, prepared: e.fit2.prep });
          } catch (err) {
            res = { ok: false, reason: String(err && err.message ? err.message : err) };
          }
        }
        e.aligned = Object.assign({ text: raw.text, ownSlant: own }, res);
        e.hk = hk;
      }
      return e.aligned;
    });
    return { aligned, profile };
  }

  /** ~20 points spread along all of a unit's ink, left edge at x = 0 (baseline stays at y = 0). */
  function shapeSample(u) {
    if (u._shape) return u._shape;
    const strokes = u.strokes.map((s) => s.pts).concat(u.marks.map((m) => m.pts));
    const lens = strokes.map((pts) => G.pathLength(pts));
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    const out = [];
    strokes.forEach((pts, i) => {
      const n = Math.max(2, Math.round((20 * lens[i]) / total));
      for (const p of G.resample(pts, Math.max(lens[i] / n, 1e-3))) out.push([p.x - u.box.minX, p.y]);
    });
    u._shape = out;
    return out;
  }

  /** Mean nearest-point distance both ways between two point sets. */
  function shapeDistance(a, b) {
    const oneWay = (p, q) => {
      let sum = 0;
      for (const [x, y] of p) {
        let best = Infinity;
        for (const [u, v] of q) {
          const d = (x - u) * (x - u) + (y - v) * (y - v);
          if (d < best) best = d;
        }
        sum += Math.sqrt(best);
      }
      return sum / p.length;
    };
    return 0.5 * (oneWay(a, b) + oneWay(b, a));
  }

  /** The shape of a unit alone: its ink stretched to fill a 1 x 1 box, so size doesn't matter. */
  function shapeOnly(u) {
    if (u._shapeOnly) return u._shapeOnly;
    const pts = shapeSample(u);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = Math.max(maxX - minX, 0.15);
    const h = Math.max(maxY - minY, 0.15);
    u._shapeOnly = pts.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
    return u._shapeOnly;
  }

  /** How different two units look: shape first, then how far apart their sizes are. */
  function lookDistance(a, b) {
    const ha = Math.max(a.box.maxY - a.box.minY, 0.15);
    const hb = Math.max(b.box.maxY - b.box.minY, 0.15);
    const wa = Math.max(a.box.maxX - a.box.minX, 0.15);
    const wb = Math.max(b.box.maxX - b.box.minX, 0.15);
    return shapeDistance(shapeOnly(a), shapeOnly(b)) + 0.1 * Math.abs(Math.log(ha / hb)) + 0.06 * Math.abs(Math.log(wa / wb));
  }

  /**
   * Letters written on their own are always cut correctly, so they are a clean reference for what
   * each letter looks like. A cut-out letter (from a word) that looks clearly more like a
   * *different* letter's reference than its own was probably cut in the wrong place, and gets
   * u.wrong = 1. Only letters with at least two references can be judged.
   */
  // Letters that have the same shape once size is removed (a stem is a stem at any height), so a
  // letter that looks like one of these is not a sign it was cut wrongly.
  const LOOKALIKES = ['il1|!jI', 'oO0', ".,'`"];
  // Plain strokes and punctuation: their shape alone says too little (and two isolated examples
  // can't show how they look when written in a word), so they are never called wrong.
  const NO_SHAPE_CHECK = "il1|!jI.,'`:;";
  function lookAlike(a, b) {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    return LOOKALIKES.some((g) => g.includes(a) && g.includes(b));
  }

  function markWrongOnes(byChar) {
    const refs = [];
    for (const [ch, list] of byChar) {
      const iso = list.filter((u) => u.iso);
      if (iso.length >= 2 && /[A-Za-z0-9]/.test(ch)) refs.push({ ch, units: iso });
    }
    // recompute only when a new letter gets references, or every few more references, not for each one added
    const sig = refs.map((r) => r.ch).join('') + ':' + Math.floor(refs.reduce((n, r) => n + r.units.length, 0) / 6);
    if (refs.length < 6) {
      for (const list of byChar.values()) for (const u of list) u.wrong = 0;
      return;
    }
    for (const [ch, list] of byChar) {
      const own = refs.find((r) => r.ch === ch);
      for (const u of list) {
        if (u.iso || !own || NO_SHAPE_CHECK.includes(ch)) {
          u.wrong = 0;
          continue;
        }
        if (u._wrongSig === sig) continue;
        u._wrongSig = sig;
        const dist = (units) => (units.length ? Math.min(...units.map((v) => lookDistance(u, v))) : Infinity);
        const dOwn = dist(own.units);
        let dOther = Infinity;
        for (const r of refs) if (!lookAlike(ch, r.ch)) dOther = Math.min(dOther, dist(r.units));
        u._dOwn = dOwn;
        u.wrong = dOther < 0.6 * dOwn && dOwn - dOther > 0.03 ? 1 : 0;
      }
    }
    // Safety valve: if this would call more than one letter in ten wrong, the references and the
    // words probably look too different (neat single letters against quick writing) for the
    // comparison to mean anything for this writer, so don't act on it.
    const cut = [];
    for (const list of byChar.values()) for (const u of list) if (!u.iso) cut.push(u);
    if (cut.length >= 30 && cut.filter((u) => u.wrong).length > 0.1 * cut.length) for (const u of cut) u.wrong = 0;
  }

  const oddCache = new Map(); // char -> the units it was last computed for

  /**
   * Flag examples of a letter that look unlike the writer's other examples of it. A letter that
   * was cut in the wrong place (half of a neighbour, a stray loop) differs from its siblings, so
   * u.odd gets large and the synthesizer avoids it. Needs a few examples of the letter. Groups
   * that haven't changed since the last build are skipped.
   */
  function markOddOnes(byChar) {
    for (const [ch, list] of byChar) {
      const prev = oddCache.get(ch);
      if (prev && prev.length === list.length && prev.every((u, i) => u === list[i])) continue;
      oddCache.set(ch, list.slice());
      for (const u of list) u.odd = 0;
      if (list.length < 4) continue;
      const shapes = list.map(shapeSample);
      // compare each example with at most 14 others, evenly spread
      const step = Math.max(1, Math.floor(list.length / 14));
      const score = list.map((_, i) => {
        const d = [];
        for (let j = 0; j < list.length; j += step) if (j !== i) d.push(shapeDistance(shapes[i], shapes[j]));
        return A.median(d);
      });
      const med = A.median(score);
      const mad = A.median(score.map((v) => Math.abs(v - med)));
      list.forEach((u, i) => {
        u.odd = Math.min(4, Math.max(0, (score[i] - med) / (mad * 1.5 + 0.03)));
      });
    }
  }

  // ---- rhythm: how this writer's lines behave -------------------------------------------

  /** Robust standard deviation (median absolute deviation), 0 for fewer than 3 values. */
  function robustSd(v) {
    if (v.length < 3) return 0;
    const m = A.median(v);
    return 1.4826 * A.median(v.map((x) => Math.abs(x - m)));
  }

  /** Lag-1 correlation within lines, pooled; series is a list of arrays. */
  function pooledRho(series) {
    let num = 0;
    let den = 0;
    for (const s of series) {
      for (let i = 0; i < s.length; i++) den += s[i] * s[i];
      for (let i = 1; i < s.length; i++) num += s[i] * s[i - 1];
    }
    return den > 1e-12 ? Math.max(0, Math.min(0.9, num / den)) : 0;
  }

  /**
   * Measure how the writer's full lines behave, from words written as part of a line:
   * gaps between words, how the baseline wanders and slopes, how size and slant drift.
   * Distances are in the writer's own x-heights. Returns {learned: false} until there are
   * enough lines, in which case the synthesizer uses generic values.
   */
  function computeRhythm(rawWords, aligned) {
    const lines = new Map();
    rawWords.forEach((raw, i) => {
      const a = aligned[i];
      if (!raw.line || !a || !a.ok || !a.view) return;
      let left = Infinity;
      let right = -Infinity;
      for (const st of raw.strokes) for (const p of st) {
        if (p[0] < left) left = p[0];
        if (p[0] > right) right = p[0];
      }
      if (!lines.has(raw.line)) lines.set(raw.line, []);
      lines.get(raw.line).push({
        pos: raw.pos || 0,
        left,
        right,
        xh: raw.xh * a.view.s,
        base: raw.baseline + a.view.dy * raw.xh,
        slant: a.ownSlant,
      });
    });
    const gaps = [];
    const baseSeries = [];
    const sizeSeries = [];
    const slopes = [];
    const slantDev = [];
    let nLines = 0;
    for (const words of lines.values()) {
      if (words.length < 3) continue;
      words.sort((p, q) => p.pos - q.pos);
      nLines++;
      const xhLine = A.median(words.map((w) => w.xh));
      for (let k = 1; k < words.length; k++) gaps.push((words[k].left - words[k - 1].right) / xhLine);
      // baseline: straight-line fit across the line, then what is left over
      const cx = words.map((w) => (w.left + w.right) / 2);
      const n = words.length;
      const mx = cx.reduce((a, b) => a + b, 0) / n;
      const my = words.reduce((a, w) => a + w.base, 0) / n;
      let sxx = 0;
      let sxy = 0;
      cx.forEach((x, i) => {
        sxx += (x - mx) * (x - mx);
        sxy += (x - mx) * (words[i].base - my);
      });
      const slope = sxx > 1e-9 ? sxy / sxx : 0;
      slopes.push(Math.atan(slope));
      baseSeries.push(words.map((w, i) => (w.base - (my + slope * (cx[i] - mx))) / xhLine));
      const logs = words.map((w) => Math.log(w.xh / xhLine));
      const lm = logs.reduce((a, b) => a + b, 0) / n;
      sizeSeries.push(logs.map((v) => v - lm));
      const sl = words.filter((w) => w.slant !== null && w.slant !== undefined).map((w) => w.slant);
      if (sl.length >= 3) {
        const med = A.median(sl);
        sl.forEach((v) => slantDev.push(v - med));
      }
    }
    if (nLines < 3 || gaps.length < 10) return { learned: false, lines: nLines };
    // Each word's size / baseline / slant is itself an estimate, and a noisy one for short words
    // or ambiguous letters, so measured drift is partly measurement noise (on real handwriting it
    // comes out several times larger than people actually vary). Keep it within human ranges,
    // and assume drift is smooth along a line, since noise also hides the correlation.
    const gapMean = Math.max(0.2, A.median(gaps));
    return {
      learned: true,
      lines: nLines,
      gapMean,
      gapSd: Math.min(robustSd(gaps), 0.35 * gapMean),
      baseSd: Math.min(robustSd(baseSeries.flat()), 0.1),
      baseRho: Math.max(0.4, pooledRho(baseSeries)),
      sizeSd: Math.min(robustSd(sizeSeries.flat()), 0.1),
      sizeRho: Math.max(0.4, pooledRho(sizeSeries)),
      slopeSd: Math.min(robustSd(slopes), 0.03),
      slantSd: Math.min(robustSd(slantDev), 0.07),
    };
  }

  /**
   * 0..1 for how far a cut-out letter is from this writer's own single-letter version of it,
   * relative to the other cut-outs of that letter (0 = typical, 1 = among the furthest).
   */
  function markFarOnes(byChar) {
    for (const list of byChar.values()) {
      const cut = list.filter((u) => !u.iso && typeof u._dOwn === 'number' && isFinite(u._dOwn));
      if (cut.length < 6) {
        for (const u of list) u.far = 0;
        continue;
      }
      const d = cut.map((u) => u._dOwn).sort((a, b) => a - b);
      const q50 = d[d.length >> 1];
      const q90 = d[Math.floor(d.length * 0.9)];
      const span = Math.max(q90 - q50, 1e-6);
      for (const u of list) u.far = u.iso || typeof u._dOwn !== 'number' ? 0 : Math.min(1, Math.max(0, (u._dOwn - q50) / span));
    }
  }

  // ---- closed bowls -------------------------------------------------------------------------
  function segCross(a, b, c, d) {
    const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return o(a, b, c) > 0 !== o(a, b, d) > 0 && o(c, d, a) > 0 !== o(c, d, b) > 0;
  }

  /** Does a pen stroke of this letter close on itself (cross itself, or come back to where it was)? */
  function hasBowl(u) {
    if (u._bowl !== undefined) return u._bowl;
    let found = false;
    for (const s of u.strokes) {
      const p = s.pts;
      const n = p.length;
      if (n < 8 || found) continue;
      const len = [0];
      for (let i = 1; i < n; i++) len.push(len[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y));
      for (let i = 0; i < n - 1 && !found; i++) {
        for (let j = i + 6; j < n - 1; j++) {
          if (segCross(p[i], p[i + 1], p[j], p[j + 1])) {
            found = true;
            break;
          }
        }
      }
      for (let i = 0; i < n && !found; i++) {
        for (let j = i + 1; j < n; j++) {
          if (len[j] - len[i] > 0.9 && Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y) < 0.1) {
            found = true;
            break;
          }
        }
      }
    }
    u._bowl = found;
    return found;
  }

  /**
   * For letters this writer's single-letter version closes (a, e, o, d, ...) and which they close
   * in most of their words too, a cut-out copy that stays open is probably cut wrongly (an "a" that
   * reads as a "u"). Flag those.
   */
  function markOpenOnes(byChar) {
    for (const list of byChar.values()) {
      const iso = list.filter((u) => u.iso);
      const cut = list.filter((u) => !u.iso);
      const refsClosed = iso.length >= 2 && iso.every(hasBowl);
      const closedShare = cut.length ? cut.filter(hasBowl).length / cut.length : 0;
      const applies = refsClosed && cut.length >= 6 && closedShare >= 0.6;
      for (const u of list) u.open = applies && !u.iso && !hasBowl(u) ? 1 : 0;
    }
  }

  // ---- stray scraps ---------------------------------------------------------------------------
  function pieceLength(piece) {
    let n = 0;
    for (let i = 1; i < piece.pts.length; i++) n += Math.hypot(piece.pts[i].x - piece.pts[i - 1].x, piece.pts[i].y - piece.pts[i - 1].y);
    return n;
  }

  /**
   * A cut-out letter that has more pen pieces than this writer's single-letter version, where the extra
   * ones are tiny, has picked up a scrap of its neighbour (the dot of an i, the end of a comma): the
   * "or" that turns into "ori". Flag those.
   */
  function markStrayOnes(byChar) {
    for (const list of byChar.values()) {
      const iso = list.filter((u) => u.iso).map((u) => u.strokes.length + u.marks.length);
      const k = iso.length >= 2 && iso.every((n) => n === iso[0]) ? iso[0] : 0;
      for (const u of list) {
        u.stray = 0;
        if (!k || u.iso) continue;
        const pieces = u.strokes.concat(u.marks);
        if (pieces.length <= k) continue;
        const lens = pieces.map(pieceLength).sort((a, b) => a - b);
        const extra = lens.slice(0, pieces.length - k).reduce((a, b) => a + b, 0);
        if (extra < 0.6) u.stray = 1;
      }
    }
  }

  function inkExtent(u) {
    let a = Infinity;
    let b = -Infinity;
    let c = Infinity;
    let d = -Infinity;
    for (const s of u.strokes) {
      for (const p of s.pts) {
        if (p.x < a) a = p.x;
        if (p.x > b) b = p.x;
        if (p.y < c) c = p.y;
        if (p.y > d) d = p.y;
      }
    }
    return { w: b - a, h: d - c };
  }

  /**
   * Letters written on their own come out wider and taller than the same letters inside a word.
   * Replace each single letter by a copy shrunk by how this writer's in-word versions compare
   * (never enlarged). The originals are left alone, so this can run on every rebuild.
   */
  /** A copy of a unit scaled by f.fx across and f.fy up, from its left edge and the baseline. The original is untouched. */
  function scaleUnit(u, f) {
    const x0 = u.box.minX;
    const mapPt = (p) => ({ ...p, x: x0 + (p.x - x0) * f.fx, y: p.y * f.fy });
    const dir = (e) => {
      const dx = e.dx * f.fx;
      const dy = e.dy * f.fy;
      const l = Math.hypot(dx, dy) || 1;
      return { ...e, x: x0 + (e.x - x0) * f.fx, y: e.y * f.fy, dx: dx / l, dy: dy / l };
    };
    return {
      ...u,
      strokes: u.strokes.map((st) => ({ ...st, pts: st.pts.map(mapPt) })),
      marks: u.marks.map((m) => ({ ...m, pts: m.pts.map(mapPt) })),
      entry: dir(u.entry),
      exit: dir(u.exit),
      box: { minX: x0, maxX: x0 + (u.box.maxX - x0) * f.fx, minY: u.box.minY * f.fy, maxY: u.box.maxY * f.fy },
    };
  }

  /**
   * A slash written on the pad is often far taller than anything else the writer makes (three x-heights against
   * letters that top out around two), which looks wrong in "9/5". Scale it down, evenly, to the writer's own
   * ascender height. Copies replace the originals, so this can run on every rebuild.
   */
  function tidyTallSymbols(byChar, allByChar, profile) {
    const top = (profile && profile.asc ? profile.asc : 1.85) + 0.25;
    for (const ch of ['/']) {
      const list = allByChar.get(ch);
      if (!list) continue;
      const pool = byChar.get(ch);
      list.forEach((u, i) => {
        const h = u.box.maxY - Math.min(0, u.box.minY);
        if (h <= top) return;
        const c = scaleUnit(u, { fx: top / h, fy: top / h });
        list[i] = c;
        if (pool) pool.forEach((p, k) => p === u && (pool[k] = c));
      });
    }
  }

  /**
   * A letter written on its own often starts with a short, nearly flat run-in stroke before it turns down into the
   * letter (the little tail on an "m"), which the writer does not make inside a word. Cut that run-in off: a copy
   * of the unit without it. Anything else is returned as it is.
   */
  function trimRunIn(u) {
    const st0 = u.strokes[0];
    if (!st0 || st0.pts.length < 8) return u;
    const pts = st0.pts;
    const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
    // the opening direction, from the first few points
    const a0 = ang(pts[0], pts[Math.min(3, pts.length - 1)]);
    if (Math.abs(Math.sin(a0)) > 0.55 || Math.cos(a0) < 0) return u; // not an opening that runs to the right, flat-ish
    let len = 0;
    let k = -1;
    for (let i = 1; i < pts.length - 2; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (len > 0.45) break;
      const next = ang(pts[i], pts[Math.min(i + 3, pts.length - 1)]);
      if (next < -1.0 && next > -2.4 && len > 0.04) {
        // now heading steeply down (y is up, so a negative angle is down): the run-in ends here
        k = i;
        break;
      }
    }
    if (k < 0) return u;
    const rest = pts.slice(k);
    const strokes = [{ ...st0, pts: rest }].concat(u.strokes.slice(1));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const piece of strokes.concat(u.marks)) {
      for (const p of piece.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const d = Math.hypot(rest[2].x - rest[0].x, rest[2].y - rest[0].y) || 1;
    const entry = { ...u.entry, x: rest[0].x, y: rest[0].y, dx: (rest[2].x - rest[0].x) / d, dy: (rest[2].y - rest[0].y) / d };
    return { ...u, strokes, entry, box: { minX, maxX, minY, maxY }, trimmed: true };
  }

  function shrinkSingleLetters(byChar, allByChar) {
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const kind = (ch) => (/[a-z]/.test(ch) ? 'l' : /[A-Z]/.test(ch) ? 'u' : /[0-9]/.test(ch) ? 'd' : null);
    const per = new Map();
    const pooled = { l: { x: [], y: [] }, u: { x: [], y: [] }, d: { x: [], y: [] } };
    for (const [ch, list] of allByChar) {
      const k = kind(ch);
      if (!k) continue;
      const iso = list.filter((u) => u.iso && !u.skipped).map(inkExtent);
      const cut = list.filter((u) => !u.iso && !u.skipped).map(inkExtent);
      if (!iso.length || cut.length < 3) continue;
      const fx = med(cut.map((e) => e.w)) / med(iso.map((e) => e.w));
      const fy = med(cut.map((e) => e.h)) / med(iso.map((e) => e.h));
      if (!isFinite(fx) || !isFinite(fy)) continue;
      per.set(ch, { fx, fy, n: cut.length });
      pooled[k].x.push(fx);
      pooled[k].y.push(fy);
    }
    const clamp = (v) => Math.min(1, Math.max(0.6, v));
    const factorFor = (ch) => {
      const k = kind(ch);
      if (!k || pooled[k].x.length < 3) return null;
      const px = med(pooled[k].x);
      const py = med(pooled[k].y);
      const own = per.get(ch);
      if (!own) return { fx: clamp(px), fy: clamp(py) };
      const wgt = own.n / (own.n + 1); // a few examples are enough to go on; none at all falls back to the pooled ratio
      return { fx: clamp(wgt * own.fx + (1 - wgt) * px), fy: clamp(wgt * own.fy + (1 - wgt) * py) };
    };
    for (const [ch, list] of allByChar) {
      const f = factorFor(ch);
      const swap = new Map();
      if (!f || (f.fx > 0.98 && f.fy > 0.98)) {
        // no shrinking needed, but a run-in stroke is still trimmed
        list.forEach((u, i) => {
          if (!u.iso) return;
          const c = trimRunIn(u);
          if (c === u) return;
          swap.set(u, c);
          list[i] = c;
        });
        const pool = byChar.get(ch);
        if (pool) pool.forEach((u, i) => swap.has(u) && (pool[i] = swap.get(u)));
        continue;
      }
      list.forEach((u, i) => {
        if (!u.iso) return;
        const c = scaleUnit(trimRunIn(u), f);
        swap.set(u, c);
        list[i] = c;
      });
      const inPool = byChar.get(ch);
      if (inPool) inPool.forEach((u, i) => swap.has(u) && (inPool[i] = swap.get(u)));
    }
  }

  function buildStyle(rawWords) {
    const words = rawWords.filter((w) => w && w.strokes && w.strokes.length && w.text);
    const stats = computeStats(words);
    const { aligned, profile } = alignAll(words, stats);

    const byChar = new Map();
    const allByChar = new Map();
    const slants = [];
    const gaps = [];
    let joinsMid = 0;
    let joins = 0;
    const failed = [];
    const suspect = [];

    aligned.forEach((w, wi) => {
      if (!w.ok) {
        failed.push({ index: wi, text: w.text, reason: w.reason });
        return;
      }
      slants.push(w.slant);
      w.units.forEach((u, idx) => {
        u.wid = wi;
        u.idx = idx;
        u.id = wi + ':' + idx;
        u.word = w;
        u.iso = !!(words[wi] && words[wi].iso); // written on its own, so never mis-cut
        u.dev = A.deviation(u, profile);
        // letters the writer has crossed out in the letter check stay out of the pool
        const crossed = words[wi] && words[wi].skip;
        u.skipped = !!(crossed && crossed.some((c) => c.i === idx && c.ch === u.ch));
        if (!allByChar.has(u.ch)) allByChar.set(u.ch, []);
        allByChar.get(u.ch).push(u);
        if (!u.skipped) {
          if (!byChar.has(u.ch)) byChar.set(u.ch, []);
          byChar.get(u.ch).push(u);
        }
        if (idx > 0) {
          const p = w.units[idx - 1];
          joins++;
          if (p.exit.mid && u.entry.mid) joinsMid++;
          else if (!p.exit.mid && !u.entry.mid) gaps.push(u.box.minX - p.box.maxX);
        }
      });
    });

    // Words worth a second look: alignment cost that is an outlier against this writer's own
    // words, or a letter whose shape contradicts its character (e.g. a descender on an "s").
    const qs = aligned.filter((w) => w.ok && w.units.length > 1).map((w) => w.quality);
    const qMed = A.median(qs);
    const qMad = A.median(qs.map((q) => Math.abs(q - qMed)));
    const qLimit = Math.max(qMed + 4 * qMad, qMed * 2, 0.8);
    aligned.forEach((w, wi) => {
      if (!w.ok) return;
      const badShape = w.units.some((u) => u.hc > 0.8);
      if ((w.units.length > 1 && qs.length >= 5 && w.quality > qLimit) || badShape) {
        suspect.push({ index: wi, text: w.text, quality: w.quality });
        w.suspect = true;
      }
    });

    markOddOnes(byChar);
    markWrongOnes(byChar);
    markFarOnes(byChar);
    markOpenOnes(byChar);
    markStrayOnes(byChar);
    shrinkSingleLetters(byChar, allByChar);
    tidyTallSymbols(byChar, allByChar, profile);

    // how close this writer lets neighbouring (unjoined) letters get, by nearest ink
    const clears = [];
    for (const w of aligned) {
      if (!w.ok) continue;
      for (let i = 1; i < w.units.length; i++) {
        const p = w.units[i - 1];
        const u = w.units[i];
        if (p.exit.mid || u.entry.mid || /[^a-zA-Z]/.test(p.ch + u.ch)) continue;
        const c = A.inkBase(p, u);
        if (c !== null) clears.push(c);
      }
    }
    const clearance = clears.length >= 20 ? { median: A.median(clears), sd: robustSd(clears) } : null;

    const liftGap = gaps.length ? Math.min(0.5, Math.max(-0.05, A.median(gaps))) : 0.1;
    const unitById = new Map();
    for (const list of allByChar.values()) for (const u of list) unitById.set(u.id, u);
    // Words the writer actually wrote, by their letters, so a typed word they have written can be written back
    // from their own strokes. Single letters, words the aligner was unsure of, and words with a crossed-out or
    // implausible letter are left out.
    const wholeWords = new Map();
    for (const w of aligned) {
      if (!w.ok || w.suspect || !w.units.length || w.units.some((u) => u.iso || u.skipped || (u.hc || 0) > 0.8)) continue;
      const core = w.units.map((u) => u.ch).join('').replace(/[.,!?;:]+$/, '');
      if (core.length < 2) continue;
      if (!wholeWords.has(core)) wholeWords.set(core, []);
      wholeWords.get(core).push(w);
    }
    return {
      words: aligned,
      byChar,
      allByChar,
      unitById,
      wholeWords,
      profile,
      clearance,
      rhythm: computeRhythm(words, aligned),
      slant: slants.length ? A.median(slants) : 0,
      liftGap,
      connectivity: joins ? joinsMid / joins : 0,
      hasPressure: stats.hasPressure,
      stats,
      failed,
      suspect,
      count: aligned.filter((w) => w.ok).length,
    };
  }

  /** Characters (from `text`) we have no sample for. */
  function missingChars(style, text) {
    const miss = new Set();
    for (const ch of Array.from(text)) {
      if (/\s/.test(ch)) continue;
      if (!style.byChar.has(normalizeChar(ch)) && !fallbackFor(style, normalizeChar(ch))) miss.add(ch);
    }
    return Array.from(miss);
  }

  const CHAR_MAP = {
    '‘': "'", '’': "'", '‚': ',', '‛': "'", '“': '"', '”': '"',
    '„': '"', '–': '-', '—': '-', '−': '-', '…': '...', ' ': ' ',
  };

  function normalizeChar(ch) {
    return CHAR_MAP[ch] || ch;
  }

  /** {ch, scale} to use when there is no sample for `ch`, or null. */
  function fallbackFor(style, ch) {
    if (style.byChar.has(ch)) return { ch, scale: 1 };
    if (ch >= 'A' && ch <= 'Z' && style.byChar.has(ch.toLowerCase())) return { ch: ch.toLowerCase(), scale: 1.55 };
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base !== ch && base.length === 1) return fallbackFor(style, base);
    return null;
  }

  function coverage(style) {
    const out = {};
    for (const [ch, list] of style.byChar) out[ch] = list.length;
    return out;
  }

  function toJSON(rawWords) {
    return JSON.stringify({ version: 1, words: rawWords });
  }

  function fromJSON(str) {
    const o = JSON.parse(str);
    if (!o || !Array.isArray(o.words)) throw new Error('Not a handwriting style file');
    return o.words;
  }

  const api = { buildStyle, computeRhythm, missingChars, coverage, normalizeChar, fallbackFor, toJSON, fromJSON, computeStats, lookDistance, hasBowl, trimRunIn };
  root.HW = root.HW || {};
  root.HW.style = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
