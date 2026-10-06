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

  const api = { layoutBox, writeInk, inkPath, pdfFromImage, hexToRgb, DEFAULT_XH_PT, MIN_XH_PT, ENGINE_XH };
  root.HW = root.HW || {};
  root.HW.sheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
