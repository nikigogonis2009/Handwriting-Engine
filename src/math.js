/*
 * Math mode: lays out TeX-style input (x^2, x_1, \frac{a}{b}, \sqrt{x}, \lim_{x \to 0}, \int_0^1,
 * \sum_{i=1}^n, brackets that stretch to fit) using the writer's own letters and symbols.
 * A symbol the writer has not written yet is drawn as a plain hand-wobbled stand-in.
 *
 * Boxes are in engine units: x from 0, y up from the baseline, x-height = 1.
 */
(function (root) {
  'use strict';

  const G = typeof require !== 'undefined' ? require('./geometry') : root.HW.geometry;
  const Y = typeof require !== 'undefined' ? require('./synth') : root.HW.synth;

  // ---- reading the input ----------------------------------------------------------------------

  const COMMANDS = {
    to: '→', rightarrow: '→', infty: '∞', pi: 'π', theta: 'θ', alpha: 'α', beta: 'β', lambda: 'λ', mu: 'μ',
    sigma: 'σ', phi: 'φ', omega: 'ω', Delta: 'Δ', partial: '∂', le: '≤', leq: '≤', ge: '≥', geq: '≥',
    ne: '≠', neq: '≠', approx: '≈', pm: '±', times: '×', cdot: '·', div: '÷', prime: "'",
  };
  const TEXT_COMMANDS = new Set(['text', 'textrm', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mbox', 'operatorname']);
  // widths, in x-heights, of the spaces TeX has names for (a plain space between things is ignored, as in TeX)
  const SPACES = { ' ': 0.8, ',': 0.45, ';': 0.6, ':': 0.5, quad: 1.2, qquad: 2.4 };
  const spaceOf = (k) => (Object.prototype.hasOwnProperty.call(SPACES, k) ? SPACES[k] : undefined);
  const WORDS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'det']);
  const RELATIONS = new Set(['=', '<', '>', '≤', '≥', '≠', '≈', '→']);
  const BINARY = new Set(['+', '-', '×', '÷', '±', '·', '*']);
  // One quick sample of these tends to look like a scribble, so wait for two before using the writer's own
  const OPERATORS = new Set(['+', '-', '=', '<', '>', '≤', '≥', '≠', '≈', '±', '×', '÷', '·', '→']);
  const OPEN = new Set(['(', '[', '{']);
  const CLOSE = new Set([')', ']', '}']);

  function tokenize(src) {
    const s = src.replace(/\r/g, '').replace(/->/g, '→').replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/!=/g, '≠').replace(/\+-/g, '±');
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') {
        out.push({ k: 'nl' });
        i++;
      } else if (/[ \t]/.test(c)) {
        while (i < s.length && /[ \t]/.test(s[i])) i++;
        out.push({ k: 'sp' });
      } else if (c === '\\') {
        if (s[i + 1] === '\\') {
          out.push({ k: 'nl' });
          i += 2;
        } else if (/[A-Za-z]/.test(s[i + 1] || '')) {
          let j = i + 1;
          while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
          const name = s.slice(i + 1, j);
          i = j;
          if (TEXT_COMMANDS.has(name)) {
            // \text{some words}: the braces hold plain text, written as it is (spaces count, commands do not)
            let k = i;
            while (k < s.length && /[ \t]/.test(s[k])) k++;
            if (s[k] === '{') {
              let depth = 0;
              let e = k;
              for (; e < s.length; e++) {
                if (s[e] === '{') depth++;
                else if (s[e] === '}' && --depth === 0) break;
              }
              out.push({ k: 'text', v: s.slice(k + 1, e) });
              i = Math.min(s.length, e + 1);
              continue;
            }
          }
          if (spaceOf(name) !== undefined) out.push({ k: 'gap', v: spaceOf(name) });
          else out.push({ k: 'cmd', v: name });
        } else if (spaceOf(s[i + 1]) !== undefined) {
          out.push({ k: 'gap', v: spaceOf(s[i + 1]) }); // "\ " is a space that stays, like \, and \;
          i += 2;
        } else if (s[i + 1] === '!' || i + 1 >= s.length) {
          i += 2;
        } else {
          out.push({ k: 'ch', v: s[i + 1] }); // \% \$ \{ and so on: the character itself
          i += 2;
        }
      } else if (c === '{' || c === '}' || c === '^' || c === '_') {
        out.push({ k: c });
        i++;
      } else if (c === '√' || c === '∛') {
        out.push({ k: 'cmd', v: c === '√' ? 'sqrt' : 'cbrt' });
        i++;
      } else if (/[A-Za-z0-9.']/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9.']/.test(s[j])) j++;
        const word = s.slice(i, j);
        const root = /^(sqrt|cbrt|cubert|cuberoot)(\d[\d.]*)?$/i.exec(word); // typed as words: sqrt(x), cubert 8
        if (root) {
          out.push({ k: 'cmd', v: root[1].toLowerCase() === 'sqrt' ? 'sqrt' : 'cbrt' });
          if (root[2]) out.push({ k: 'run', v: root[2] });
        } else out.push({ k: 'run', v: word });
        i = j;
      } else {
        out.push({ k: 'ch', v: c });
        i++;
      }
    }
    return out;
  }

  /** Tokens -> lines of nodes. A node is {t, ...} with optional .sup / .sub (each a node list). */
  function parse(src) {
    const toks = tokenize(src);
    let i = 0;

    function skipSpace() {
      while (i < toks.length && toks[i].k === 'sp') i++;
    }

    function group() {
      // expects toks[i] to be '{'
      i++;
      const nodes = seq(true);
      if (i < toks.length && toks[i].k === '}') i++;
      return nodes;
    }

    function arg() {
      skipSpace();
      if (i < toks.length && toks[i].k === '{') return group();
      const a = atom(true);
      return a ? [a] : [];
    }

    // parsing can be limited to the tokens before `end`, for sqrt(...) and \sqrt[3]{...}
    let end = Infinity;
    function until(close) {
      // tokens up to the matching close bracket, parsed as a row; leaves i after it
      let depth = 0;
      let j = i;
      for (; j < toks.length; j++) {
        if (toks[j].k === 'ch' && toks[j].v === (close === ')' ? '(' : '[')) depth++;
        else if (toks[j].k === 'ch' && toks[j].v === close && depth-- === 0) break;
      }
      const saved = end;
      end = j;
      const nodes = seq(false);
      end = saved;
      i = Math.min(toks.length, j + 1);
      return nodes;
    }

    function atom(noScripts) {
      skipSpace();
      const t = toks[i];
      if (!t || i >= end || t.k === '}' || t.k === 'nl') return null;
      let n = null;
      if (t.k === 'gap') {
        i++;
        return { t: 'gap', w: t.v };
      } else if (t.k === 'text') {
        i++;
        n = { t: 'text', s: t.v };
      } else if (t.k === '{') {
        n = { t: 'group', a: group() };
      } else if (t.k === 'run') {
        i++;
        n = { t: 'run', s: t.v };
      } else if (t.k === 'ch') {
        i++;
        n = { t: 'sym', c: t.v };
      } else if (t.k === 'cmd') {
        i++;
        if (t.v === 'frac') {
          const a = arg();
          const b = arg();
          n = { t: 'frac', a, b };
        } else if (t.v === 'sqrt' || t.v === 'cbrt') {
          let idx = t.v === 'cbrt' ? [{ t: 'run', s: '3' }] : null;
          skipSpace();
          if (!idx && toks[i] && toks[i].k === 'ch' && toks[i].v === '[') {
            i++;
            idx = until(']');
            skipSpace();
          }
          let body;
          if (toks[i] && toks[i].k === 'ch' && toks[i].v === '(') {
            i++;
            body = until(')'); // sqrt(x + 1)
          } else body = arg();
          n = { t: 'sqrt', a: body, idx };
        } else if (t.v === 'int' || t.v === 'sum' || t.v === 'prod') {
          n = { t: 'big', c: t.v === 'int' ? '∫' : t.v === 'sum' ? '∑' : '∏' };
        } else if (t.v === 'left' || t.v === 'right') {
          skipSpace();
          const f = toks[i];
          if (f && f.k === 'ch') i++;
          return f && f.k === 'ch' && f.v !== '.' ? { t: 'sym', c: f.v } : atom();
        } else if (WORDS.has(t.v)) {
          n = { t: 'run', s: t.v };
        } else if (COMMANDS[t.v]) {
          n = { t: 'sym', c: COMMANDS[t.v] };
        } else {
          n = { t: 'run', s: t.v }; // unknown command: write its name
        }
      } else if (t.k === '^' || t.k === '_') {
        n = { t: 'group', a: [] }; // a script with nothing before it
      } else {
        i++;
        return atom(noScripts);
      }
      // scripts: x^2, x_1, x_i^2 (the argument of a script does not take scripts of its own: _0^1)
      while (!noScripts) {
        const save = i;
        skipSpace();
        const nx = toks[i];
        if (nx && nx.k === '^' && !n.sup) {
          i++;
          n.sup = arg();
        } else if (nx && nx.k === '_' && !n.sub) {
          i++;
          n.sub = arg();
        } else {
          i = save;
          break;
        }
      }
      return n;
    }

    function seq(inGroup) {
      const out = [];
      for (;;) {
        skipSpace();
        const t = toks[i];
        if (!t || i >= end || t.k === 'nl' || (inGroup && t.k === '}')) break;
        if (t.k === '}') {
          i++;
          continue;
        }
        const a = atom();
        if (a) out.push(a);
      }
      return out;
    }

    const lines = [];
    for (;;) {
      lines.push(seq(false));
      if (i < toks.length && toks[i].k === 'nl') i++;
      else break;
    }
    return lines;
  }

  // ---- boxes ----------------------------------------------------------------------------------

  const clone = (strokes, dx, dy, sx, sy) =>
    strokes.map((s) => ({
      taperStart: s.taperStart,
      taperEnd: s.taperEnd,
      pts: s.pts.map((p) => ({ x: dx + p.x * sx, y: dy + p.y * sy, w: p.w })),
    }));

  function measure(strokes) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of strokes) {
      for (const p of s.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  /** A box from strokes: shifted so the ink starts at x = 0. */
  function boxOf(strokes, minUp, minDown) {
    if (!strokes.length) return { w: 0, up: minUp || 0, down: minDown || 0, strokes: [] };
    const m = measure(strokes);
    const moved = clone(strokes, -m.minX, 0, 1, 1);
    return { w: m.maxX - m.minX, up: Math.max(minUp || 0, m.maxY), down: Math.max(minDown || 0, -m.minY), strokes: moved };
  }

  const place = (into, box, dx, dy) => {
    for (const s of clone(box.strokes, dx, dy, 1, 1)) into.push(s);
  };

  // ---- the layout engine ----------------------------------------------------------------------

  function createEngine(style, rng, opts) {
    const messiness = opts.messiness;
    const ctx = { variation: opts.variation, messiness, usage: new Map(), missing: new Set(), rhythm: true };
    const sample = Y.synthWord(style, 'x', G.mulberry32(1), { variation: 0, messiness: 0, usage: new Map(), missing: new Set(), rhythm: true });
    const ws = sample ? sample.strokes.flatMap((s) => s.pts.map((p) => p.w)).sort((a, b) => a - b) : [1.2];
    const PEN = ws[ws.length >> 1] || 1.2;

    /** The writer's own writing of `text`, scaled by sc. */
    function written(text, sc) {
      const w = Y.synthWord(style, text, rng, ctx);
      if (!w) return null;
      const jitter = 1 + 0.03 * messiness * G.gaussian(rng);
      return boxOf(clone(w.strokes, 0, 0, sc * jitter, sc * jitter));
    }

    /** A drawn stand-in: polylines in engine units, densified, smoothed and wobbled like handwriting. */
    function drawn(polys, sc) {
      const strokes = [];
      for (const poly of polys) {
        const pts = [];
        for (let i = 0; i < poly.length - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.04));
          for (let k = 0; k < n; k++) pts.push({ x: a[0] + ((b[0] - a[0]) * k) / n, y: a[1] + ((b[1] - a[1]) * k) / n, w: PEN });
        }
        const last = poly[poly.length - 1];
        pts.push({ x: last[0], y: last[1], w: PEN });
        strokes.push({ pts: pts.length >= 5 ? G.smooth(pts, 2, ['w']) : pts, taperStart: 0.12, taperEnd: 0.12 });
      }
      Y.deform(strokes, rng, messiness, false);
      return boxOf(clone(strokes, 0, 0, sc, sc));
    }

    const line = (x0, y0, x1, y1) => [[x0, y0], [x1, y1]];

    /** Hand-drawn glyphs for symbols the writer has not written. */
    function standIn(c, sc, up, down) {
      const U = up === undefined ? 1.8 : up;
      const D = down === undefined ? 0.4 : down;
      const mid = (U - D) / 2;
      switch (c) {
        case '[': return drawn([[[0.35, U], [0, U], [0, -D], [0.35, -D]]], sc);
        case ']': return drawn([[[0, U], [0.35, U], [0.35, -D], [0, -D]]], sc);
        case '{': return drawn([[[0.4, U], [0.2, U - 0.1], [0.2, mid + 0.15], [0, mid], [0.2, mid - 0.15], [0.2, -D + 0.1], [0.4, -D]]], sc);
        case '}': return drawn([[[0, U], [0.2, U - 0.1], [0.2, mid + 0.15], [0.4, mid], [0.2, mid - 0.15], [0.2, -D + 0.1], [0, -D]]], sc);
        case '(': return drawn([[[0.35, U], [0.08, mid + 0.4], [0.08, mid - 0.4], [0.35, -D]]], sc);
        case ')': return drawn([[[0, U], [0.27, mid + 0.4], [0.27, mid - 0.4], [0, -D]]], sc);
        case '|': return drawn([[[0, U], [0.02, -D]]], sc);
        case '<': return drawn([[[0.55, 0.95], [0, 0.5], [0.55, 0.05]]], sc);
        case '>': return drawn([[[0, 0.95], [0.55, 0.5], [0, 0.05]]], sc);
        case '≤': return drawn([[[0.55, 1.0], [0, 0.6], [0.55, 0.2]], line(0, -0.05, 0.55, -0.05)], sc);
        case '≥': return drawn([[[0, 1.0], [0.55, 0.6], [0, 0.2]], line(0, -0.05, 0.55, -0.05)], sc);
        case '=': return drawn([line(0, 0.35, 0.7, 0.35), line(0, 0.7, 0.7, 0.7)], sc);
        case '≠': return drawn([line(0, 0.3, 0.7, 0.3), line(0, 0.65, 0.7, 0.65), line(0.5, 0.95, 0.2, 0.0)], sc);
        case '≈': return drawn([[[0, 0.3], [0.2, 0.45], [0.45, 0.2], [0.7, 0.35]], [[0, 0.65], [0.2, 0.8], [0.45, 0.55], [0.7, 0.7]]], sc);
        case '+': return drawn([line(0, 0.5, 0.7, 0.5), line(0.35, 0.85, 0.35, 0.15)], sc);
        case '-': return drawn([line(0, 0.45, 0.6, 0.45)], sc);
        case '±': return drawn([line(0, 0.7, 0.7, 0.7), line(0.35, 1.05, 0.35, 0.35), line(0, 0.05, 0.7, 0.05)], sc);
        case '×': return drawn([line(0, 0.15, 0.6, 0.85), line(0, 0.85, 0.6, 0.15)], sc);
        case '÷': return drawn([line(0, 0.5, 0.7, 0.5), [[0.35, 0.9], [0.36, 0.92]], [[0.35, 0.1], [0.36, 0.12]]], sc);
        case '·': return drawn([[[0, 0.5], [0.02, 0.52]]], sc);
        case '→': return drawn([line(0, 0.5, 1.0, 0.5), [[0.75, 0.8], [1.0, 0.5], [0.75, 0.2]]], sc);
        case '∞': {
          const p = [];
          for (let i = 0; i <= 40; i++) {
            const t = (i / 40) * 2 * Math.PI;
            p.push([0.5 + 0.5 * Math.sin(t), 0.5 + 0.3 * Math.sin(t) * Math.cos(t)]);
          }
          return drawn([p], sc);
        }
        case '∫': return drawn([[[0.5, 1.9], [0.38, 2.0], [0.28, 1.85], [0.25, 1.4], [0.2, 0.5], [0.15, -0.2], [0.05, -0.65], [-0.08, -0.55]]], sc);
        case '∑': return drawn([[[1.0, 1.5], [0.1, 1.5], [0.7, 0.5], [0.0, -0.45], [1.0, -0.45]]], sc);
        case '∏': return drawn([line(0, 1.5, 1.0, 1.5), line(0.15, 1.5, 0.12, -0.45), line(0.85, 1.5, 0.88, -0.45)], sc);
        default: return null;
      }
    }

    /** A box for a single symbol: the writer's own if they have written it, else a stand-in. */
    function symbol(c, sc, up, down) {
      const have = style.byChar.get(c);
      const mine = have && have.length >= (OPERATORS.has(c) ? 2 : 1) ? written(c, sc) : null;
      if (mine) return mine;
      const stand = standIn(c, sc, up, down);
      if (stand) {
        stand.stand = true; // drawn, not the writer's own
        return stand;
      }
      ctx.missing.add(c);
      return null;
    }

    /** A bracket stretched to cover content from -down up to up (in this box's own scale). */
    function fence(c, sc, up, down) {
      const natural = symbol(c, sc);
      if (!natural) return null;
      const wantUp = up + 0.2 * sc;
      const wantDown = down + 0.2 * sc;
      if (natural.up >= wantUp - 0.05 && natural.down >= wantDown - 0.05) return natural;
      if (natural.stand) return standIn(c, 1, wantUp, wantDown);
      // the writer's own bracket, stretched
      const sy = (wantUp + wantDown) / (natural.up + natural.down);
      const sx = Math.min(1.5, Math.sqrt(sy));
      const strokes = natural.strokes.map((s) => ({
        taperStart: s.taperStart,
        taperEnd: s.taperEnd,
        pts: s.pts.map((p) => ({ x: p.x * sx, y: (p.y + natural.down) * sy - wantDown, w: p.w })),
      }));
      return { w: natural.w * sx, up: wantUp, down: wantDown, strokes };
    }

    return { ctx, written, drawn, standIn, symbol, fence, PEN, line };
  }

  function layoutNodes(E, nodes, sc) {
    const items = [];
    for (const n of nodes) {
      const it = layoutAtom(E, n, sc);
      if (it) items.push(it);
    }
    // brackets stretch to what is inside them
    const stack = [];
    items.forEach((it, idx) => {
      if (it.kind === 'open') stack.push(idx);
      else if (it.kind === 'close' && stack.length) {
        const o = stack.pop();
        let up = 0;
        let down = 0;
        for (let k = o + 1; k < idx; k++) {
          up = Math.max(up, items[k].box.up);
          down = Math.max(down, items[k].box.down);
        }
        if (up > 1.4 * sc || down > 0.5 * sc) {
          const a = E.fence(items[o].c, sc, up, down);
          const b = E.fence(it.c, sc, up, down);
          if (a) items[o].box = a;
          if (b) it.box = b;
        }
      }
    });
    return items;
  }

  function gapBetween(a, b, atStart) {
    if (!a) return 0;
    const unary = b.c === '-' && (atStart || a.kind === 'open' || a.kind === 'rel' || a.kind === 'bin');
    if (a.kind === 'gap' || b.kind === 'gap') return 0; // a space that was asked for is the whole gap
    if (a.kind === 'rel' || b.kind === 'rel') return 0.55;
    if (a.kind === 'bin' && !(a.unary)) return 0.35;
    if (b.kind === 'bin' && !unary) return 0.35;
    if (a.kind === 'open' || b.kind === 'close') return 0.05;
    if (a.kind === 'punct') return 0.3;
    if (b.kind === 'punct') return 0.04;
    if (a.kind === 'big' || b.kind === 'big') return 0.15;
    if (a.kind === 'frac' || b.kind === 'frac' || a.kind === 'sqrt' || b.kind === 'sqrt') return 0.2;
    if (a.kind === 'run' && b.kind === 'run') return 0.3;
    return 0.12;
  }

  /** Lay items left to right on one baseline. Returns a box. */
  function row(E, nodes, sc) {
    const items = layoutNodes(E, nodes, sc);
    const out = [];
    let x = 0;
    let up = 0;
    let down = 0;
    items.forEach((it, i) => {
      const prev = items[i - 1];
      if (prev && prev.kind === 'bin' && prev.c === '-' && (i === 1 || (items[i - 2] && ['open', 'rel', 'bin'].includes(items[i - 2].kind)))) prev.unary = true;
      x += gapBetween(prev, it, i === 0) * sc;
      place(out, it.box, x, it.dy || 0);
      x += it.box.w;
      up = Math.max(up, it.box.up + (it.dy || 0));
      down = Math.max(down, it.box.down - (it.dy || 0));
    });
    return { w: x, up, down, strokes: out };
  }

  function attachScripts(E, n, box, sc) {
    if (!n.sup && !n.sub) return box;
    const out = [];
    place(out, box, 0, 0);
    const ssc = sc * 0.7;
    const sup = n.sup ? row(E, n.sup, ssc) : null;
    const sub = n.sub ? row(E, n.sub, ssc) : null;
    const x = box.w + 0.05 * sc;
    let w = box.w;
    let up = box.up;
    let down = box.down;
    if (sup) {
      const base = Math.max(0.6 * sc, box.up - 0.45 * sc);
      place(out, sup, x, base);
      w = Math.max(w, x + sup.w);
      up = Math.max(up, base + sup.up);
    }
    if (sub) {
      const base = -Math.max(0.3 * sc, box.down * 0.6 + 0.15 * sc);
      place(out, sub, x, base);
      w = Math.max(w, x + sub.w);
      down = Math.max(down, -base + sub.down);
    }
    return { w, up, down, strokes: out };
  }

  function layoutAtom(E, n, sc) {
    if (n.t === 'run') {
      const under = n.s === 'lim' && n.sub;
      let box = E.written(n.s, sc);
      if (!box) {
        for (const c of Array.from(n.s)) E.ctx.missing.add(c);
        return null;
      }
      if (under) {
        const lo = row(E, n.sub, sc * 0.7);
        const w = Math.max(box.w, lo.w);
        const out = [];
        place(out, box, (w - box.w) / 2, 0);
        place(out, lo, (w - lo.w) / 2, -box.down - 0.25 * sc - lo.up);
        return { kind: 'run', box: { w, up: box.up, down: box.down + 0.25 * sc + lo.up + lo.down, strokes: out } };
      }
      box = attachScripts(E, n, box, sc);
      return { kind: 'run', box };
    }
    if (n.t === 'gap') return { kind: 'gap', box: { w: n.w * sc, up: 0, down: 0, strokes: [] } };
    if (n.t === 'text') {
      // plain text inside math: each word written as a word, with word gaps between (and no operator spacing in "-int")
      const out = [];
      let x = /^\s/.test(n.s) ? 0.4 * sc : 0; // spaces at the ends of the braces are real: \text{ so }
      let up = 0;
      let down = 0;
      for (const w of n.s.split(/\s+/).filter(Boolean)) {
        const box = E.written(w, sc);
        if (!box) {
          for (const c of Array.from(w)) E.ctx.missing.add(c);
          continue;
        }
        if (out.length) x += 0.3 * sc;
        place(out, box, x, 0);
        x += box.w;
        up = Math.max(up, box.up);
        down = Math.max(down, box.down);
      }
      if (!out.length) return null;
      if (/\s$/.test(n.s)) x += 0.4 * sc;
      return { kind: 'run', box: attachScripts(E, n, { w: x, up, down, strokes: out }, sc) };
    }
    if (n.t === 'sym') {
      const c = n.c;
      const kind = RELATIONS.has(c) ? 'rel' : BINARY.has(c) ? 'bin' : OPEN.has(c) ? 'open' : CLOSE.has(c) ? 'close' : c === ',' || c === ';' || c === ':' ? 'punct' : 'ord';
      let box = E.symbol(c, sc);
      if (!box) return null;
      box = attachScripts(E, n, box, sc);
      return { kind, c, box };
    }
    if (n.t === 'group') {
      const box = attachScripts(E, n, row(E, n.a, sc), sc);
      return { kind: 'run', box };
    }
    if (n.t === 'frac') {
      const fs = sc * 0.88;
      const a = row(E, n.a, fs);
      const b = row(E, n.b, fs);
      const w = Math.max(a.w, b.w) + 0.3 * sc;
      const axis = 0.5 * sc;
      const gap = 0.22 * sc;
      const bar = E.drawn([E.line(0, 0, w / sc, 0.01)], sc);
      const out = [];
      place(out, bar, 0, axis);
      place(out, a, (w - a.w) / 2, axis + gap + a.down);
      place(out, b, (w - b.w) / 2, axis - gap - b.up);
      const box = { w, up: axis + gap + a.down + a.up, down: -(axis - gap - b.up) + b.down, strokes: out };
      return { kind: 'frac', box: attachScripts(E, n, box, sc) };
    }
    if (n.t === 'sqrt') {
      const inner = row(E, n.a, sc);
      const top = Math.max(inner.up, 1.0 * sc) + 0.25 * sc;
      const bottom = -(inner.down + 0.05 * sc);
      const h = top - bottom;
      const index = n.idx && n.idx.length ? row(E, n.idx, sc * 0.55) : null; // the 3 of a cube root, small at the hook
      const lead = index ? Math.max(0, index.w - 0.12 * sc) : 0;
      const rw = 0.55 * sc;
      const poly = [[0, bottom + 0.45 * h], [0.15 * sc, bottom + 0.55 * h], [0.32 * sc, bottom], [rw, top], [rw + inner.w + 0.2 * sc, top]];
      const rad = E.drawn([poly.map(([x, y]) => [x / sc, y / sc])], sc);
      const out = [];
      place(out, rad, lead, 0);
      place(out, inner, lead + rw + 0.08 * sc, 0);
      let boxUp = top;
      if (index) {
        const iy = bottom + 0.5 * h;
        place(out, index, 0, iy);
        boxUp = Math.max(top, iy + index.up);
      }
      const box = { w: lead + rw + inner.w + 0.2 * sc, up: boxUp, down: Math.max(inner.down, -bottom), strokes: out };
      return { kind: 'sqrt', box: attachScripts(E, n, box, sc) };
    }
    if (n.t === 'big') {
      const bsc = sc * (n.c === '∫' ? 1.15 : 1);
      const glyph = E.symbol(n.c, bsc);
      if (!glyph) return null;
      const out = [];
      place(out, glyph, 0, 0);
      let w = glyph.w;
      let up = glyph.up;
      let down = glyph.down;
      const lsc = sc * 0.65;
      const hi = n.sup ? row(E, n.sup, lsc) : null;
      const lo = n.sub ? row(E, n.sub, lsc) : null;
      if (n.c === '∫') {
        if (hi) {
          place(out, hi, glyph.w * 0.7, glyph.up - 0.5 * sc);
          w = Math.max(w, glyph.w * 0.7 + hi.w);
          up = Math.max(up, glyph.up - 0.5 * sc + hi.up);
        }
        if (lo) {
          place(out, lo, glyph.w * 0.15, -glyph.down - lo.up + 0.25 * sc);
          w = Math.max(w, glyph.w * 0.15 + lo.w);
          down = Math.max(down, glyph.down + lo.up + lo.down - 0.25 * sc);
        }
      } else {
        const width = Math.max(glyph.w, hi ? hi.w : 0, lo ? lo.w : 0);
        out.length = 0;
        place(out, glyph, (width - glyph.w) / 2, 0);
        if (hi) {
          place(out, hi, (width - hi.w) / 2, glyph.up + 0.2 * sc + hi.down);
          up = glyph.up + 0.2 * sc + hi.down + hi.up;
        }
        if (lo) {
          place(out, lo, (width - lo.w) / 2, -glyph.down - 0.2 * sc - lo.up);
          down = glyph.down + 0.2 * sc + lo.up + lo.down;
        }
        w = width;
      }
      return { kind: 'big', box: { w, up, down, strokes: out } };
    }
    return null;
  }

  // ---- page -----------------------------------------------------------------------------------

  /**
   * Same result shape as synth.layout: {width, height, strokes, missing, baselines, xh, lineHeightPx}.
   * opts: {xh (px), width (px), lineHeight (x-heights), messiness, variation, seed, margin (px)}
   */
  function layout(style, text, opts) {
    const o = Object.assign({ xh: 34, width: 900, lineHeight: 3.1, messiness: 0.3, variation: 0.4, slantDelta: 0, seed: 1 }, opts || {});
    const rng = G.mulberry32(o.seed);
    const E = createEngine(style, rng, o);
    const xh = o.xh;
    const margin = o.margin != null ? o.margin : xh * 1.2;
    const tanS = Math.tan(style.slant + (o.slantDelta * Math.PI) / 180);
    const lines = parse(text).map((nodes) => row(E, nodes, 1));

    const baselines = [];
    const strokes = [];
    let base = margin;
    let widest = 0;
    lines.forEach((ln, i) => {
      const up = Math.max(ln.up, 1.7);
      base = i === 0 ? margin + up * xh : base + Math.max(o.lineHeight * xh, (lines[i - 1].down + up + 0.7) * xh);
      baselines.push(base);
      const drift = (rng() * 2 - 1) * 0.02 * o.messiness * xh;
      for (const s of ln.strokes) {
        strokes.push({
          taperStart: s.taperStart,
          taperEnd: s.taperEnd,
          pts: s.pts.map((p) => ({ x: margin + (p.x + p.y * tanS) * xh, y: base - p.y * xh + drift, w: p.w })),
        });
      }
      widest = Math.max(widest, ln.w + Math.max(0, ln.up) * Math.abs(tanS));
    });
    const last = lines[lines.length - 1] || { down: 0 };
    const height = (baselines.length ? baselines[baselines.length - 1] : margin) + (Math.max(last.down, 0.8) + 0.8) * xh + margin * 0.5;
    return {
      width: Math.max(o.width, widest * xh + 2 * margin),
      height,
      strokes,
      words: [],
      missing: Array.from(E.ctx.missing),
      baselines,
      xh,
      lineHeightPx: o.lineHeight * xh,
    };
  }

  const api = { layout, parse, tokenize };
  root.HW = root.HW || {};
  root.HW.math = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
