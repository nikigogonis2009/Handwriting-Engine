/*
 * The Download button (bottom left): one .zip with the app's code, the MCP server and the setup guide, and, if asked, the
 * user's own handwriting. The published site carries those files, already deflated, in window.HW_PACK (scripts/pack.js);
 * this only puts them in a zip. On a plain local checkout there is no pack, so the button stays hidden.
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  if (!window.HW_PACK || !$('#dl')) return;

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
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

  /** entries: [{name, method (0 stored, 8 deflated), crc, size, data}] -> a zip as one Uint8Array. */
  function makeZip(entries) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // names are UTF-8
      local.setUint16(8, e.method, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, e.crc, true);
      local.setUint32(18, e.data.length, true);
      local.setUint32(22, e.size, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, e.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, e.method, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.data.length, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + e.data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  function build(withSamples) {
    const entries = window.HW_PACK.map(([name, size, crc, b64]) => ({ name, method: 8, crc, size, data: fromBase64(b64) }));
    if (withSamples) {
      const bytes = new TextEncoder().encode(window.HW.style.toJSON(window.HW_APP.words));
      entries.push({ name: top + 'my-handwriting.json', method: 0, crc: crc32(bytes), size: bytes.length, data: bytes });
    }
    return makeZip(entries);
  }

  const guest = window.HW_PROFILE_KIND === 'ai'; // the small part hands over a small zip for the person's AI, with their handwriting in it
  const top = guest ? 'handwriting-for-ai/' : 'handwriting-engine/';
  const panel = $('#dlPanel');
  const have = () => (window.HW_APP && window.HW_APP.words ? window.HW_APP.words.length : 0);
  $('#dl').hidden = false;
  if (guest) {
    $('#btnDownloadAll').textContent = 'Download for my AI';
    $('#dlTitle').textContent = 'Download for my AI';
    $('#dlText').textContent = 'A zip with your handwriting, the program your AI runs, and a note that tells it what to do.';
    $('#dlSamplesRow').hidden = true;
    $('#dlKeep').hidden = true;
    $('#dlGo').textContent = 'Download zip';
  }
  $('#btnDownloadAll').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    const n = have();
    if (guest) {
      $('#dlSamples').checked = n > 0;
      $('#dlGo').disabled = !n;
      $('#dlText').textContent = n ? 'A zip with your handwriting, the program your AI runs, and a note that tells it what to do.' : 'Nothing has been taught in this browser yet. Do the rounds in the Teach tab first, then come back.';
      return;
    }
    $('#dlSamples').disabled = !n;
    if (!n) $('#dlSamples').checked = false;
    $('#dlSamplesNote').textContent = n ? `(${n} words taught in this browser)` : '(nothing taught in this browser yet)';
  });
  $('#dlClose').addEventListener('click', () => (panel.hidden = true));
  $('#dlGo').addEventListener('click', () => {
    const blob = new Blob([build($('#dlSamples').checked)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = guest ? 'handwriting-for-ai.zip' : 'handwriting-engine.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    panel.hidden = true;
  });
  window.HW_DOWNLOAD = { build };
})();
