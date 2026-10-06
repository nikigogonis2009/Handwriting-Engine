/*
 * Putting handwriting onto a sheet (a PDF or a picture of a worksheet). This file is the part that needs no screen:
 * fitting an answer into the box it was given, and writing the ink into the PDF. The screen part is sheetui.js.
 *
 * Boxes are in PDF points, from the top-left corner of the page, the way a person looks at it:
 *   {page, x, y, w, h, text, kind: 'text' | 'math', xhPt, seed, auto}
 */
(function (root) {
  'use strict';

  const Y = typeof require !== 'undefined' ? require('./synth') : root.HW.synth;
  const M = typeof require !== 'undefined' ? require('./math') : root.HW.math;
  const R = typeof require !== 'undefined' ? require('./render') : root.HW.render;

  const ENGINE_XH = 34; // the engine lays out at this x-height in its own pixels; everything is scaled to points afterwards
  const DEFAULT_XH_PT = 9.5; // a lowercase letter this tall looks like handwriting on a letter-size worksheet
  const MIN_XH_PT = 5;

  function inkBounds(strokes) {
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

  /**
   * Write `box.text` in the writer's hand to fit `box`. Text that is too long for the box is made smaller, a little at a
   * time (unless box.auto === false), down to MIN_XH_PT.
   * look: the sliders of the Write tab (messiness, variation, slantDelta, wordSpacing, neatness, wordReuse).
   * Returns {layout, K, xhPt, dx, dy, overflow, missing}: K is points per layout pixel, and the layout belongs at
   * (box.x - dx * K, box.y - dy * K) in points.
   */
  function layoutBox(style, box, look) {
    const text = String(box.text || '');
    let xhPt = box.xhPt || DEFAULT_XH_PT;
    const gen = box.kind === 'math' ? M : Y;
    const pad = 0.1 * ENGINE_XH;
    let out = null;
    for (let tries = 0; tries < 16; tries++) {
      const K = xhPt / ENGINE_XH;
      const lay = gen.layout(
        style,
        text,
        Object.assign({}, look || {}, {
          xh: ENGINE_XH,
          width: Math.max(60, Math.round(box.w / K)),
          lineHeight: box.kind === 'math' ? 3 : 2.5,
          seed: box.seed || 1,
          margin: 8,
        })
      );
      const moved = R.fitLayout(lay, pad);
      const b = inkBounds(lay.strokes);
      // A box about one line tall is an answer line: the writing sits on its bottom edge (descenders cross it, as they
      // do on paper) instead of hanging from the top with a gap above the printed line.
      const oneLine = box.kind !== 'math' && lay.baselines.length === 1 && box.h <= 3.4 * xhPt;
      let dy = moved.dy; // the layout's origin is box.y - dy * K points from the top of the page
      if (oneLine) {
        const top = b.minY - dy; // ink top, below the box top, in layout px
        const down = box.h / K - 0.45 * ENGINE_XH - (lay.baselines[0] - dy); // to put the baseline there
        dy -= Math.max(down, -top); // moving up is limited so the tops of the letters stay in the box
      }
      // where the ink ends, measured from the box's own top-left corner
      const right = (b.maxX - moved.dx) * K;
      const bottom = (b.maxY - dy) * K;
      const overflow = bottom > box.h + (oneLine ? 0.7 * xhPt : 1) || right > box.w + 1;
      out = { layout: lay, K, xhPt, dx: moved.dx, dy, overflow, missing: lay.missing || [] };
      if (!overflow || box.auto === false || xhPt <= MIN_XH_PT) break;
      xhPt = Math.max(MIN_XH_PT, xhPt * 0.93);
    }
    return out;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x1749b3;
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** The ink of a placed box as SVG path data in layout pixels. */
  function inkPath(placed, look) {
    return R.layoutToPath(placed.layout, look.pen === undefined ? 1 : look.pen, look.constant !== false);
  }

  /**
   * Write the boxes' ink into a PDF as vector shapes, on top of what is already on the pages.
   * PDFLib: the pdf-lib module. bytes: the PDF. items: [{box, placed}] with placed from layoutBox.
   * look: {ink: '#rrggbb', pen, constant}. Returns the new PDF's bytes.
   */
  async function writeInk(PDFLib, bytes, items, look) {
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = doc.getPages();
    const [r, g, b] = hexToRgb(look.ink);
    for (const { box, placed } of items) {
      const page = pages[box.page];
      if (!page) continue;
      if (page.getRotation().angle % 360 !== 0) throw new Error('Page ' + (box.page + 1) + ' is rotated, and rotated pages are not supported yet.');
      const view = page.getCropBox ? page.getCropBox() : page.getMediaBox();
      page.drawSvgPath(inkPath(placed, look), {
        x: view.x + box.x - placed.dx * placed.K,
        y: view.y + view.height - (box.y - placed.dy * placed.K),
        scale: placed.K,
        color: PDFLib.rgb(r, g, b),
        borderWidth: 0,
      });
    }
    return doc.save();
  }

  /** A PDF with one page that is the given picture (PNG or JPEG bytes), 612 pt wide, so a photo of a worksheet works like a PDF. */
  async function pdfFromImage(PDFLib, bytes, mime, width, height) {
    const doc = await PDFLib.PDFDocument.create();
    const img = mime === 'image/jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const w = 612;
    const h = (w * height) / width;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    return doc.save();
  }

  // ---- finding the blanks on a page ---------------------------------------------------------------------------------------
  //
  // Works on a picture of the page, not on the PDF's drawing commands, so a scan or a photo of a worksheet works the same
  // as a typed PDF. Two kinds of blank: an answer line (a printed rule or a row of underscores with nothing written on
  // it) and an empty box (any closed outline with nothing inside, which covers table cells too).

  /** Ink map of a page picture: 1 where a pixel is clearly darker than the paper around it. Comparing with the local
   * paper colour, not a fixed grey, is what lets a photo with a shadow across it work. */
  function inkMap(img) {
    const W = img.width;
    const H = img.height;
    const d = img.data;
    const rgba = d.length === W * H * 4;
    const g = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = rgba ? (d[j] * 3 + d[j + 1] * 6 + d[j + 2]) / 10 : d[i];
    // paper colour: the brightest pixel in each block, then the brightest of the blocks around it
    const B = 24;
    const bw = Math.ceil(W / B);
    const bh = Math.ceil(H / B);
    const blk = new Uint8Array(bw * bh);
    for (let y = 0; y < H; y++) {
      const row = ((y / B) | 0) * bw;
      for (let x = 0; x < W; x++) {
        const k = row + ((x / B) | 0);
        if (g[y * W + x] > blk[k]) blk[k] = g[y * W + x];
      }
    }
    const paper = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        for (let yy = Math.max(0, by - 1); yy <= Math.min(bh - 1, by + 1); yy++) {
          for (let xx = Math.max(0, bx - 1); xx <= Math.min(bw - 1, bx + 1); xx++) m = Math.max(m, blk[yy * bw + xx]);
        }
        paper[by * bw + bx] = m;
      }
    }
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = ((y / B) | 0) * bw;
      for (let x = 0; x < W; x++) {
        const p = paper[row + ((x / B) | 0)];
        if (g[y * W + x] < 0.78 * p && p > 90) ink[y * W + x] = 1;
      }
    }
    return ink;
  }

  /** Share of ink pixels in a rectangle of the ink map (pixel coordinates, clipped to the picture). */
  function inkShare(ink, W, H, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(W, Math.round(x1));
    y1 = Math.min(H, Math.round(y1));
    if (x1 <= x0 || y1 <= y0) return 0;
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += ink[y * W + x];
    return n / ((x1 - x0) * (y1 - y0));
  }

  /** Thin horizontal strokes at least minLen pixels long: [{x0, x1, y0, y1}] (y1 inclusive). */
  function horizontalRules(ink, W, H, minLen, gap, maxThick) {
    const open = []; // groups still being extended downwards
    const done = [];
    for (let y = 0; y < H; y++) {
      const runs = [];
      let x = 0;
      while (x < W) {
        if (!ink[y * W + x]) {
          x++;
          continue;
        }
        const start = x;
        let end = x;
        let miss = 0;
        for (x++; x < W; x++) {
          if (ink[y * W + x]) {
            end = x;
            miss = 0;
          } else if (++miss > gap) break;
        }
        if (end - start + 1 >= minLen) runs.push({ x0: start, x1: end });
      }
      const next = [];
      for (const r of runs) {
        // the same rule seen on the row above: the runs mostly overlap
        const g = open.find((o) => o.y1 === y - 1 && !o.used && Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0.8 * Math.min(o.x1 - o.x0, r.x1 - r.x0));
        if (g) {
          g.used = true;
          g.y1 = y;
          g.x0 = Math.min(g.x0, r.x0);
          g.x1 = Math.max(g.x1, r.x1);
          next.push(g);
        } else next.push({ x0: r.x0, x1: r.x1, y0: y, y1: y, used: true });
      }
      for (const o of open) if (!next.includes(o)) done.push(o);
      for (const n of next) n.used = false;
      open.length = 0;
      open.push(...next);
    }
    done.push(...open);
    return done.filter((r) => r.y1 - r.y0 + 1 <= maxThick).map(({ x0, x1, y0, y1 }) => ({ x0, x1, y0, y1 }));
  }

  /** Does ink run straight down (dir 1) or up (dir -1) from (x, y) for at least len pixels, within a couple of pixels
   * either side? */
  function stem(ink, W, H, x, y, len, dir) {
    let n = 0;
    for (let k = 0, yy = y; k < len && yy >= 0 && yy < H; k++, yy += dir) {
      let hit = false;
      for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2) && !hit; xx++) hit = ink[yy * W + xx] === 1;
      if (!hit) break;
      n++;
    }
    return n >= len;
  }

  /** Closed outlines with nothing inside: white regions that do not reach the edge of the page and fill their own
   * bounding rectangle. Returns pixel rectangles [{x0, y0, x1, y1}] of the inside. */
  function emptyBoxes(ink, W, H, s) {
    const label = new Int32Array(W * H);
    const queue = new Int32Array(W * H);
    const out = [];
    let next = 1;
    for (let start = 0; start < W * H; start++) {
      if (ink[start] || label[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      label[start] = next;
      let x0 = W;
      let x1 = 0;
      let y0 = H;
      let y1 = 0;
      let area = 0;
      let edge = false;
      while (head < tail) {
        const i = queue[head++];
        const x = i % W;
        const y = (i - x) / W;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        if (x > 0 && !ink[i - 1] && !label[i - 1]) (label[i - 1] = next), (queue[tail++] = i - 1);
        if (x < W - 1 && !ink[i + 1] && !label[i + 1]) (label[i + 1] = next), (queue[tail++] = i + 1);
        if (y > 0 && !ink[i - W] && !label[i - W]) (label[i - W] = next), (queue[tail++] = i - W);
        if (y < H - 1 && !ink[i + W] && !label[i + W]) (label[i + W] = next), (queue[tail++] = i + W);
      }
      next++;
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      if (edge || w < 36 * s || h < 14 * s) continue;
      if (w * h > 0.5 * W * H) continue; // a frame around the whole page is not an answer box
      if (area < 0.9 * w * h) continue; // not a plain rectangle, or something is written in it
      const m = 2 * s;
      if (inkShare(ink, W, H, x0 + m, y0 + m, x1 - m, y1 - m) > 0.002) continue;
      out.push({ x0, y0, x1, y1 });
    }
    return out;
  }

  /**
   * The blanks on one page. img: {data, width, height}, with data RGBA (from a canvas) or one grey byte per pixel.
   * s: pixels per point of the picture. Returns [{kind: 'line' | 'box', x, y, w, h}] in points from the top-left of the
   * page, already shaped as an answer box: a line's box sits on the line, a box's is its inside.
   */
  function findBlanks(img, s) {
    const W = img.width;
    const H = img.height;
    const ink = inkMap(img);
    const found = [];

    const boxes = emptyBoxes(ink, W, H, s);
    for (const b of boxes) {
      const inset = 3;
      found.push({ kind: 'box', x: b.x0 / s + inset, y: b.y0 / s + inset, w: (b.x1 - b.x0 + 1) / s - 2 * inset, h: (b.y1 - b.y0 + 1) / s - 2 * inset });
    }

    const rules = horizontalRules(ink, W, H, Math.round(30 * s), Math.max(1, Math.round(0.75 * s)), Math.round(3 * s) + 1);
    for (const r of rules) {
      // an edge of a box found above is already offered as that box
      const onBox = boxes.some((b) => (Math.abs(r.y0 - b.y1) <= 4 * s || Math.abs(r.y1 - b.y0) <= 4 * s) && Math.min(r.x1, b.x1) - Math.max(r.x0, b.x0) > 0.5 * (r.x1 - r.x0));
      if (onBox) continue;
      // the top or bottom of a frame or a table, not a line to write on: both its ends turn down, or both turn up
      const len = Math.round(8 * s);
      if (stem(ink, W, H, r.x0, r.y1 + 1, len, 1) && stem(ink, W, H, r.x1, r.y1 + 1, len, 1)) continue;
      if (stem(ink, W, H, r.x0, r.y0 - 1, len, -1) && stem(ink, W, H, r.x1, r.y0 - 1, len, -1)) continue;
      // something is already written on it (or it underlines a heading)
      if (inkShare(ink, W, H, r.x0, r.y0 - 18 * s, r.x1 + 1, r.y0 - 2 * s) > 0.006) continue;
      // how much room there is above it, for the height of the box
      let room = 40;
      for (let k = Math.round(2 * s); k <= 40 * s; k++) {
        if (inkShare(ink, W, H, r.x0, r.y0 - k - 1, r.x1 + 1, r.y0 - k) > 0.02) {
          room = k / s;
          break;
        }
      }
      const h = clamp(room - 3, 14, 28);
      const lineY = r.y0 / s;
      found.push({ kind: 'line', x: r.x0 / s + 1, y: lineY - h, w: (r.x1 - r.x0 + 1) / s - 2, h });
    }
    found.sort((a, b) => a.y + a.h - (b.y + b.h) || a.x - b.x);
    return found;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  const api = { layoutBox, writeInk, inkPath, pdfFromImage, hexToRgb, findBlanks, DEFAULT_XH_PT, MIN_XH_PT, ENGINE_XH };
  root.HW = root.HW || {};
  root.HW.sheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
