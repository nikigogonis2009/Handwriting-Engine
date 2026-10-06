'use strict';
/*
 * What is on the pages of a PDF, so an AI can choose where answers go: page sizes, the printed text with where it is,
 * and the ruled lines (the lines or boxes an answer is written on). Everything is in points from the page's top-left
 * corner, the same way the answer boxes are given to fill_pdf.
 */

let pdfjs = null;
function lib() {
  if (!pdfjs) {
    require('../vendor/pdf.worker.min.js'); // sets globalThis.pdfjsWorker, so pdf.js needs no worker thread
    pdfjs = require('../vendor/pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
  }
  return pdfjs;
}

const round = (v) => Math.round(v * 10) / 10;

/** Text items joined into lines: items whose baselines are within a couple of points and that follow each other. */
function textLines(items, pageH) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const base = pageH - it.transform[5];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    const row = rows.find((r) => Math.abs(r.base - base) < 2.5 && x >= r.right - 2 && x - r.right < 40);
    if (row) {
      row.text += (x - row.right > 1.5 ? ' ' : '') + it.str;
      row.right = x + it.width;
      row.h = Math.max(row.h, h);
    } else rows.push({ text: it.str, x, base, right: x + it.width, h });
  }
  return rows
    .sort((a, b) => a.base - b.base || a.x - b.x)
    .map((r) => ({ text: r.text.trim(), x: round(r.x), y: round(r.base - r.h), w: round(r.right - r.x), h: round(r.h), baseline: round(r.base) }));
}

/** Horizontal rules and thin or flat rectangles that are at least minLen long. */
async function rules(page, pageH, minLen) {
  const { OPS } = lib();
  const ops = await page.getOperatorList();
  const found = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const at = (x, y) => [m[0] * x + m[2] * y + m[4], pageH - (m[1] * x + m[3] * y + m[5])];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() || m;
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.constructPath) {
      const [sub, c] = args;
      let k = 0;
      let cur = null;
      for (const op of sub) {
        if (op === OPS.moveTo) {
          cur = at(c[k], c[k + 1]);
          k += 2;
        } else if (op === OPS.lineTo) {
          const p = at(c[k], c[k + 1]);
          k += 2;
          if (cur && Math.abs(p[1] - cur[1]) < 0.6 && Math.abs(p[0] - cur[0]) >= minLen) found.push({ x: Math.min(p[0], cur[0]), x2: Math.max(p[0], cur[0]), y: (p[1] + cur[1]) / 2 });
          cur = p;
        } else if (op === OPS.rectangle) {
          const a = at(c[k], c[k + 1]);
          const b = at(c[k] + c[k + 2], c[k + 1] + c[k + 3]);
          k += 4;
          const w = Math.abs(b[0] - a[0]);
          const h = Math.abs(b[1] - a[1]);
          if (w >= minLen && h <= 2.5) found.push({ x: Math.min(a[0], b[0]), x2: Math.min(a[0], b[0]) + w, y: (a[1] + b[1]) / 2 });
        } else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    }
  }
  const seen = new Set();
  return found
    .map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.x2 - r.x) }))
    .filter((r) => {
      const key = [r.x, r.y, r.w].join();
      return seen.has(key) ? false : seen.add(key);
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

async function inspect(bytes, opts) {
  const o = Object.assign({ minRule: 36 }, opts);
  const doc = await lib().getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: false, disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const text = await page.getTextContent();
    pages.push({
      page: n,
      width: round(view.width),
      height: round(view.height),
      rotated: page.rotate % 360 !== 0,
      text: textLines(text.items, view.height),
      rules: await rules(page, view.height, o.minRule),
    });
  }
  await doc.destroy();
  return pages;
}

module.exports = { inspect };
