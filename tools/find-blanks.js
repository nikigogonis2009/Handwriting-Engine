#!/usr/bin/env node
/*
 * Finds the blanks on worksheet pages (answer lines and empty boxes), with the same code as the Sheet tab, for an
 * assistant filling a PDF from the command line. Takes greyscale page pictures (PGM, as pdftoppm writes them):
 *
 *   pdftoppm -r 144 -gray worksheet.pdf page        # page-1.pgm, page-2.pgm, ... at 2 pixels per point
 *   node tools/find-blanks.js page-*.pgm
 *
 * Prints JSON: [{page, kind, x, y, w, h, line_y?}] in points from the page's top-left, pages numbered from 1 in the
 * order given. Each is already shaped as an answer box, so it can go to fill_pdf as {page, x, y, width: w, height: h}.
 * For a line, line_y is the line itself (fill_pdf also takes {line_y, height} instead of y).
 */
'use strict';
const fs = require('fs');
const Sheet = require('../src/sheet');

/** A binary greyscale PGM (P5, 8 bit) -> {data, width, height}. */
function readPgm(buf) {
  const head = [];
  let i = 0;
  while (head.length < 4) {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++;
    if (buf[i] === 35) {
      while (i < buf.length && buf[i] !== 10) i++; // a comment line
      continue;
    }
    let tok = '';
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) tok += String.fromCharCode(buf[i++]);
    head.push(tok);
  }
  const [magic, w, h, max] = head;
  if (magic !== 'P5' || Number(max) > 255) throw new Error('Not an 8-bit greyscale PGM (use pdftoppm -gray).');
  const width = Number(w);
  const height = Number(h);
  const data = buf.subarray(i + 1, i + 1 + width * height);
  if (data.length !== width * height) throw new Error('The PGM file is cut short.');
  return { data, width, height };
}

function blanksOfPages(files, dpi) {
  const s = (dpi || 144) / 72;
  const out = [];
  files.forEach((f, n) => {
    for (const g of Sheet.findBlanks(readPgm(fs.readFileSync(f)), s)) {
      const r = (v) => Math.round(v * 10) / 10;
      const b = { page: n + 1, kind: g.kind, x: r(g.x), y: r(g.y), w: r(g.w), h: r(g.h) };
      if (g.kind === 'line') b.line_y = r(g.y + g.h);
      out.push(b);
    }
  });
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--dpi');
  const dpi = at >= 0 ? Number(args.splice(at, 2)[1]) : 144;
  if (!args.length) {
    console.error('usage: node tools/find-blanks.js [--dpi 144] page-1.pgm [page-2.pgm ...]');
    process.exit(2);
  }
  console.log(JSON.stringify(blanksOfPages(args, dpi), null, 1));
}
module.exports = { readPgm, blanksOfPages };
