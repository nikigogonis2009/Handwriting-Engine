'use strict';
/*
 * Draws the ink (SVG path data from render.js: M, L, Z and the small round arcs of the pen's dots) into a PNG, so an
 * AI that calls the tools can look at what was written. Filled with the nonzero rule, like the canvas and the PDF.
 * No dependencies: Node's zlib writes the PNG.
 */
const zlib = require('zlib');

/** Path data -> list of closed polygons [[x, y], ...]. */
function polygons(d) {
  const out = [];
  let cur = null;
  let x = 0;
  let y = 0;
  const re = /([MLZa])([^MLZa]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const n = (m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
    if (m[1] === 'M') {
      cur = [[(x = n[0]), (y = n[1])]];
      out.push(cur);
    } else if (m[1] === 'L' && cur) {
      for (let i = 0; i + 1 < n.length; i += 2) cur.push([(x = n[i]), (y = n[i + 1])]);
    } else if (m[1] === 'a' && cur) {
      // a half circle from here to (x + dx, y), as render.js writes the dots: rx ry rot large sweep dx dy
      const r = n[0];
      const dx = n[5];
      const sweep = n[4] ? 1 : -1;
      const cx = x + dx / 2;
      const a0 = Math.atan2(0, -dx);
      for (let k = 1; k <= 12; k++) {
        const t = a0 + sweep * (Math.PI * k) / 12;
        cur.push([cx + r * Math.cos(t), y + r * Math.sin(t)]);
      }
      x += dx;
    }
  }
  return out;
}

/**
 * Fill polygons (already in pixels) into a width x height grey-coverage buffer, 0..1, 4 sub-scanlines per pixel and
 * exact horizontal coverage.
 */
function coverage(polys, width, height) {
  const cov = new Float32Array(width * height);
  const SUB = 4;
  const edges = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
    }
  }
  const byRow = Array.from({ length: height * SUB }, () => []);
  for (const e of edges) {
    const lo = Math.max(0, Math.ceil(e[1] * SUB - 0.5));
    const hi = Math.min(height * SUB - 1, Math.ceil(e[3] * SUB - 0.5) - 1);
    for (let s = lo; s <= hi; s++) {
      const yy = (s + 0.5) / SUB;
      byRow[s].push([e[0] + ((yy - e[1]) / (e[3] - e[1])) * (e[2] - e[0]), e[4]]);
    }
  }
  for (let s = 0; s < height * SUB; s++) {
    const xs = byRow[s].sort((p, q) => p[0] - q[0]);
    const row = Math.floor(s / SUB) * width;
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i][1];
      if (!wind) continue;
      const x0 = Math.max(0, xs[i][0]);
      const x1 = Math.min(width, xs[i + 1][0]);
      if (x1 <= x0) continue;
      for (let px = Math.floor(x0); px < Math.ceil(x1); px++) cov[row + px] += (Math.min(x1, px + 1) - Math.max(x0, px)) / SUB;
    }
  }
  return cov;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Ink path data (layout pixels) as a PNG on white. scale: output pixels per layout pixel. rgb: [0..255 x3].
 * Returns {png: Buffer, width, height}.
 */
function renderPng(pathData, layoutWidth, layoutHeight, scale, rgb) {
  const width = Math.max(1, Math.min(4000, Math.ceil(layoutWidth * scale)));
  const height = Math.max(1, Math.min(4000, Math.ceil(layoutHeight * scale)));
  const polys = polygons(pathData).map((p) => p.map(([x, y]) => [x * scale, y * scale]));
  const cov = coverage(polys, width, height);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3);
    raw[o] = 0;
    for (let x = 0; x < width; x++) {
      const a = Math.min(1, cov[y * width + x]);
      for (let c = 0; c < 3; c++) raw[o + 1 + x * 3 + c] = Math.round(255 + (rgb[c] - 255) * a);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth
  head[9] = 2; // RGB
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return { png, width, height };
}

module.exports = { renderPng, polygons, coverage };
