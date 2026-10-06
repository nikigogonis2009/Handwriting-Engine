'use strict';
/* A small zip reader for the tests: lists the entries, checks every CRC and returns the contents. */
const zlib = require('zlib');
const { crc32 } = require('../scripts/pack');

function readZip(buf) {
  buf = Buffer.from(buf);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip: no end record');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry ' + i);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (data.length !== size) throw new Error(`${name}: size ${data.length} is not ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: wrong CRC`);
    files.set(name, data);
  }
  return files;
}

module.exports = { readZip };
