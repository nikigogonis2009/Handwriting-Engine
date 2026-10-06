/*
 * Full-line writing. A sentence written in one go is split back into its words, using the text
 * that was asked for: the widest gaps between the strokes are the gaps between words.
 * Each word keeps its exact position on the pad, so spacing, baseline and size drift can be
 * measured from the words later (see rhythm in style.js).
 */
(function (root) {
  'use strict';

  /**
   * raw: {text, xh, baseline, pen, strokes}  (pad pixels, same shape as a captured word)
   * returns {ok, words: [raw word records], confidence, reason}
   */
  function splitLine(raw) {
    const texts = raw.text.split(/\s+/).filter(Boolean);
    const n = texts.length;
    if (!raw.strokes.length || n === 0) return { ok: false, reason: 'empty' };

    const make = (list, i) => ({
      text: texts[i],
      xh: raw.xh,
      baseline: raw.baseline,
      pen: raw.pen,
      pos: i,
      strokes: list.map((s) => s.map((p) => p.slice())),
    });
    if (n === 1) return { ok: true, words: [make(raw.strokes, 0)], confidence: Infinity };

    // x-extent of every stroke, then blocks of strokes that overlap or touch in x
    const items = raw.strokes.map((s, i) => {
      let minX = Infinity;
      let maxX = -Infinity;
      for (const p of s) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
      }
      return { i, minX, maxX };
    });
    items.sort((a, b) => a.minX - b.minX);
    const eps = 0.02 * raw.xh;
    const blocks = [];
    for (const it of items) {
      const last = blocks[blocks.length - 1];
      if (last && it.minX <= last.maxX + eps) {
        last.maxX = Math.max(last.maxX, it.maxX);
        last.ids.push(it.i);
      } else blocks.push({ minX: it.minX, maxX: it.maxX, ids: [it.i] });
    }
    if (blocks.length < n) return { ok: false, reason: 'words touch', found: blocks.length, wanted: n };

    // the n-1 widest gaps are the gaps between words
    const gaps = [];
    for (let k = 0; k + 1 < blocks.length; k++) gaps.push({ k, g: blocks[k + 1].minX - blocks[k].maxX });
    const ranked = gaps.slice().sort((a, b) => b.g - a.g);
    const chosen = ranked.slice(0, n - 1);
    const rest = ranked.slice(n - 1);
    const minChosen = Math.min(...chosen.map((c) => c.g));
    const maxRest = rest.length ? Math.max(...rest.map((c) => c.g)) : 0;
    const confidence = maxRest > 1e-6 ? minChosen / maxRest : Infinity;
    // gaps between words should stand clearly apart from gaps between letters
    if (confidence < 1.25) return { ok: false, reason: 'unclear gaps', confidence, found: countClear(gaps, n), wanted: n };

    const cut = new Set(chosen.map((c) => c.k));
    const groups = [[]];
    blocks.forEach((b, k) => {
      for (const id of b.ids) groups[groups.length - 1].push(raw.strokes[id]);
      if (cut.has(k)) groups.push([]);
    });
    // strokes keep the order they were written in inside a word
    const order = new Map(raw.strokes.map((s, i) => [s, i]));
    groups.forEach((g) => g.sort((a, b) => order.get(a) - order.get(b)));
    return { ok: true, words: groups.map((g, i) => make(g, i)), confidence };
  }

  /** How many gaps look like word gaps (used only to word the error message). */
  function countClear(gaps, n) {
    const sorted = gaps.map((g) => g.g).sort((a, b) => b - a);
    let c = 0;
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (sorted[i] >= 1.25 * sorted[i + 1]) c = i + 1;
      else break;
    }
    return Math.min(c + 1, n);
  }

  const api = { splitLine };
  root.HW = root.HW || {};
  root.HW.lines = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
