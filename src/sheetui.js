/*
 * The Sheet tab: open a worksheet (PDF or photo), drag a box where each answer goes, type the answer, and see it
 * written in the user's hand. Save gives the PDF back with the ink in it (vector, on top of the page) or one page as PNG.
 *
 * Everything happens in the page. The two libraries (pdf.js to show a page, pdf-lib to write into the file) are big,
 * so they are only loaded the first time a worksheet is opened (loadLib). The logic that does not need a screen is
 * in sheet.js.
 */
(function () {
  'use strict';
  const HW = window.HW;
  const APP = window.HW_APP;
  const $ = (s) => document.querySelector(s);

  const MIN_W = 30; // smallest box, in points
  const MIN_H = 14;
  const STORE_KEY = 'hw.sheet.v1';

  // ---- state -----------------------------------------------------------------------------------
  let src = null; // {bytes (a PDF), name, key}
  let pdf = null; // pdf.js document
  let pageIdx = 0;
  let pageW = 612; // size of the shown page in points
  let pageH = 792;
  let zoom = 1; // screen pixels per point
  let boxes = []; // answer boxes of the whole file
  let selId = null;
  let drawing = false; // the next drag draws a new box
  let styleVersion = 0;
  let nextId = 1;
  let renderTask = null;
  const placedCache = new Map(); // box id -> {key, placed, d}

  const NS = window.HW_PROFILE ? window.HW_PROFILE + ':' : '';
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(NS + k);
        return v ? JSON.parse(v) : d;
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(NS + k, JSON.stringify(v));
      } catch {
        /* storage full or blocked: the boxes just are not remembered */
      }
    },
  };

  // ---- libraries ---------------------------------------------------------------------------------
  const libs = {};
  function loadLib(path) {
    if (!libs[path]) {
      libs[path] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        if (window.HW_LIBS && window.HW_LIBS[path]) {
          s.textContent = window.HW_LIBS[path]; // the protected page carries the library as text
          document.head.appendChild(s);
          resolve();
          return;
        }
        s.src = path;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Could not load ' + path));
        document.head.appendChild(s);
      });
    }
    return libs[path];
  }
  async function loadTools() {
    await loadLib('vendor/pdf.min.js');
    await loadLib('vendor/pdf.worker.min.js'); // an ordinary script: pdf.js then runs it in the page, no Worker needed
    await loadLib('vendor/pdf-lib.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js'; // never fetched, the script above is used
  }

  // ---- small helpers -------------------------------------------------------------------------------
  function say(msg) {
    const w = $('#sheetWarn');
    w.hidden = !msg;
    w.textContent = msg || '';
  }
  function status(msg) {
    $('#status').textContent = msg || '';
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  const baseName = () => (src ? src.name.replace(/\.[^.]+$/, '') : 'worksheet');
  const curBox = () => boxes.find((b) => b.id === selId) || null;
  const pageBoxes = () => boxes.filter((b) => b.page === pageIdx);
  const haveStyle = () => !!(APP.style && APP.style.count > 0);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- remembering the boxes of a file -----------------------------------------------------------------
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!src) return;
      const all = store.get(STORE_KEY, {});
      delete all[src.key]; // re-added last, so the oldest files are the ones dropped
      all[src.key] = boxes.map(({ page, x, y, w, h, text, kind, xhPt, seed, auto }) => ({ page, x, y, w, h, text, kind, xhPt, seed, auto }));
      const keys = Object.keys(all);
      while (keys.length > 30) delete all[keys.shift()];
      store.set(STORE_KEY, all);
    }, 300);
  }
  function restore() {
    const saved = store.get(STORE_KEY, {})[src.key];
    boxes = (saved || []).map((b) => Object.assign({ kind: 'text', seed: 1, auto: true, text: '' }, b, { id: nextId++ }));
  }

  // ---- opening a file -------------------------------------------------------------------------------------
  async function imageToPdf(file) {
    // Redraw through a canvas: this applies the photo's own rotation (EXIF), flattens transparency and keeps
    // the size reasonable (a 12 megapixel photo would make a very large PDF).
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const jpg = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await jpg.arrayBuffer());
    return HW.sheet.pdfFromImage(window.PDFLib, bytes, 'image/jpeg', c.width, c.height);
  }

  async function openFile(file) {
    say('');
    status('Opening the worksheet');
    try {
      await loadTools();
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const bytes = isPdf ? new Uint8Array(await file.arrayBuffer()) : await imageToPdf(file);
      await openBytes(bytes, file.name);
      status('');
    } catch (e) {
      status('');
      say(e && e.name === 'PasswordException' ? 'This PDF is locked with a password. Save an unlocked copy and open that.' : 'Could not open that file: ' + (e && e.message ? e.message : e));
    }
  }

  // so a file with the same name and size but other contents does not get someone else's boxes
  function fingerprint(bytes) {
    let h = 2166136261;
    const step = Math.max(1, Math.floor(bytes.length / 4096));
    for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 16777619);
    return (h >>> 0).toString(36);
  }

  async function openBytes(bytes, name) {
    await loadTools();
    const doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    if (pdf) pdf.destroy();
    pdf = doc;
    src = { bytes, name, key: name + ':' + bytes.length + ':' + doc.numPages + ':' + fingerprint(bytes) };
    pageIdx = 0;
    selId = null;
    placedCache.clear();
    restore();
    $('#sheetEmpty').hidden = true;
    $('#sheetStage').hidden = false;
    await showPage();
    syncUi();
  }

  // ---- showing a page ----------------------------------------------------------------------------------------
  async function showPage() {
    if (!pdf) return;
    const page = await pdf.getPage(pageIdx + 1);
    const vp1 = page.getViewport({ scale: 1 });
    pageW = vp1.width;
    pageH = vp1.height;
    if (page.rotate % 360 !== 0) say('Page ' + (pageIdx + 1) + ' is rotated in the file. It can be shown, but saving a PDF with answers on it is not supported yet. Save as PNG instead.');
    else if (/^Page \d+ is rotated/.test($('#sheetWarn').textContent)) say('');
    const avail = Math.max(280, $('#sheetScroll').clientWidth - 26);
    const cssW = Math.min(avail, 1000);
    zoom = cssW / pageW;
    const stage = $('#sheetStage');
    stage.style.width = cssW + 'px';
    stage.style.height = pageH * zoom + 'px';
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const canvas = $('#sheetCanvas');
    const vp = page.getViewport({ scale: zoom * dpr });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    if (renderTask) renderTask.cancel();
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    try {
      await renderTask.promise;
    } catch (e) {
      if (!e || e.name !== 'RenderingCancelledException') throw e;
    }
    drawBoxes();
    drawInk();
  }

  // ---- the ink of a box --------------------------------------------------------------------------------------------
  const lookNow = () => APP.look();
  function placedFor(box) {
    const look = lookNow();
    const key = [box.text, box.kind, box.xhPt, box.seed, box.auto, Math.round(box.w), Math.round(box.h), styleVersion, JSON.stringify(look)].join('|');
    const hit = placedCache.get(box.id);
    if (hit && hit.key === key) return hit;
    const placed = HW.sheet.layoutBox(APP.style, box, look);
    const entry = { key, placed, d: HW.sheet.inkPath(placed, look), look };
    placedCache.set(box.id, entry);
    return entry;
  }

  let inkQueued = false;
  function queueInk() {
    if (inkQueued) return;
    inkQueued = true;
    requestAnimationFrame(() => {
      inkQueued = false;
      drawInk();
    });
  }

  function drawInk() {
    const svg = $('#sheetInk');
    if (!pdf || !haveStyle()) {
      svg.innerHTML = '';
      return;
    }
    let out = '';
    for (const b of pageBoxes()) {
      if (!b.text.trim()) continue;
      let e;
      try {
        e = placedFor(b);
      } catch (err) {
        say('Could not write "' + b.text.slice(0, 30) + '": ' + err.message);
        continue;
      }
      const k = e.placed.K * zoom;
      const tx = (b.x - e.placed.dx * e.placed.K) * zoom;
      const ty = (b.y - e.placed.dy * e.placed.K) * zoom;
      out += `<path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(5)})" d="${e.d}" fill="${e.look.ink}" fill-rule="nonzero"/>`;
      const el = $('#sheetBoxes [data-id="' + b.id + '"]');
      if (el) el.classList.toggle('over', e.placed.overflow);
    }
    svg.innerHTML = out;
    showBoxNotes();
  }

  function showBoxNotes() {
    const b = curBox();
    const note = $('#sheetBoxWarn');
    if (!b || !b.text.trim() || !haveStyle()) {
      note.hidden = true;
      return;
    }
    const e = placedFor(b);
    const bits = [];
    if (e.placed.overflow) bits.push('It does not fit. Make the box bigger or the letters smaller.');
    else if (e.placed.xhPt < (b.xhPt || HW.sheet.DEFAULT_XH_PT) - 0.05) bits.push('Written smaller (' + e.placed.xhPt.toFixed(1) + ' pt) to fit.');
    if (e.placed.missing.length) bits.push('No sample yet for: ' + e.placed.missing.join(' ') + '.');
    note.hidden = !bits.length;
    note.textContent = bits.join(' ');
  }

  // ---- the boxes on screen ------------------------------------------------------------------------------------------------
  function drawBoxes() {
    const host = $('#sheetBoxes');
    host.innerHTML = '';
    for (const b of pageBoxes()) {
      const el = document.createElement('div');
      el.className = 'sheet-box' + (b.id === selId ? ' sel' : '');
      el.dataset.id = b.id;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', 'Answer box: ' + (b.text || 'empty'));
      place(el, b);
      const grip = document.createElement('div');
      grip.className = 'grip';
      grip.dataset.grip = '1';
      el.appendChild(grip);
      host.appendChild(el);
    }
  }
  function place(el, b) {
    el.style.left = b.x * zoom + 'px';
    el.style.top = b.y * zoom + 'px';
    el.style.width = b.w * zoom + 'px';
    el.style.height = b.h * zoom + 'px';
  }

  function select(id) {
    selId = id;
    $('#sheetBoxes').querySelectorAll('.sheet-box').forEach((el) => el.classList.toggle('sel', Number(el.dataset.id) === id));
    syncForm();
  }

  function syncForm() {
    const b = curBox();
    $('#sheetForm').hidden = !b;
    $('#sheetHint').hidden = !!b;
    if (!b) return;
    if ($('#sheetText').value !== b.text) $('#sheetText').value = b.text;
    document.querySelectorAll('input[name="sheetKind"]').forEach((r) => (r.checked = r.value === b.kind));
    $('#sheetXh').value = b.xhPt || HW.sheet.DEFAULT_XH_PT;
    $('#o-sheetXh').textContent = Number($('#sheetXh').value).toFixed(1) + ' pt';
    $('#sheetAuto').checked = b.auto !== false;
    showBoxNotes();
  }

  function syncUi() {
    const have = !!pdf;
    const n = pdf ? pdf.numPages : 0;
    $('#sheetDraw').disabled = !have;
    $('#sheetPrev').disabled = !have || pageIdx === 0;
    $('#sheetNext').disabled = !have || pageIdx >= n - 1;
    $('#sheetPageNo').textContent = have ? 'Page ' + (pageIdx + 1) + ' of ' + n : 'no page';
    $('#sheetSavePdf').disabled = !have;
    $('#sheetSavePng').disabled = !have;
    $('#sheetDraw').setAttribute('aria-pressed', String(drawing));
    $('#sheetBoxes').classList.toggle('drawing', drawing);
    if (have && !haveStyle()) say('Nothing is written yet because no handwriting has been taught. Use the Teach tab first (or import your file there).');
    else if (/^Nothing is written yet/.test($('#sheetWarn').textContent)) say('');
    syncForm();
  }

  // ---- dragging: draw, move, resize ---------------------------------------------------------------------------------------------
  let drag = null;
  const host = $('#sheetBoxes');
  const pt = (ev) => {
    const r = host.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * pageW, y: ((ev.clientY - r.top) / r.height) * pageH };
  };

  host.addEventListener('pointerdown', (ev) => {
    if (!pdf || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    const boxEl = ev.target.closest('.sheet-box');
    const p = pt(ev);
    if (boxEl && !drawing) {
      const id = Number(boxEl.dataset.id);
      const b = boxes.find((x) => x.id === id);
      select(id);
      drag = { mode: ev.target.dataset.grip ? 'resize' : 'move', id, p0: p, b0: { x: b.x, y: b.y, w: b.w, h: b.h }, el: boxEl, moved: false };
    } else if (drawing) {
      const el = document.createElement('div');
      el.className = 'sheet-box sel';
      host.appendChild(el);
      drag = { mode: 'draw', p0: p, el, rect: null };
      place(el, { x: p.x, y: p.y, w: 0, h: 0 });
    } else {
      select(null);
      return;
    }
    host.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  host.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const p = pt(ev);
    const dx = p.x - drag.p0.x;
    const dy = p.y - drag.p0.y;
    if (drag.mode === 'draw') {
      const x = clamp(Math.min(p.x, drag.p0.x), 0, pageW);
      const y = clamp(Math.min(p.y, drag.p0.y), 0, pageH);
      drag.rect = { x, y, w: clamp(Math.max(p.x, drag.p0.x), 0, pageW) - x, h: clamp(Math.max(p.y, drag.p0.y), 0, pageH) - y };
      place(drag.el, drag.rect);
      return;
    }
    const b = boxes.find((x) => x.id === drag.id);
    if (drag.mode === 'move') {
      b.x = clamp(drag.b0.x + dx, 0, pageW - b.w);
      b.y = clamp(drag.b0.y + dy, 0, pageH - b.h);
    } else {
      b.w = clamp(drag.b0.w + dx, MIN_W, pageW - b.x);
      b.h = clamp(drag.b0.h + dy, MIN_H, pageH - b.y);
    }
    drag.moved = true;
    place(drag.el, b);
    queueInk();
  });

  function endDrag(ev) {
    if (!drag) return;
    const d = drag;
    drag = null;
    try {
      host.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
    if (d.mode === 'draw') {
      d.el.remove();
      drawing = false;
      if (d.rect && d.rect.w >= MIN_W && d.rect.h >= MIN_H) {
        const b = Object.assign({ id: nextId++, page: pageIdx, text: '', kind: 'text', seed: 1, auto: true }, d.rect);
        boxes.push(b);
        drawBoxes();
        select(b.id);
        $('#sheetText').focus();
        persist();
      }
      syncUi();
      return;
    }
    if (d.moved) persist();
  }
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);

  // ---- the form -------------------------------------------------------------------------------------------------------------------------
  function edit(fn) {
    const b = curBox();
    if (!b) return;
    fn(b);
    placedCache.delete(b.id);
    queueInk();
    showBoxNotes();
    persist();
  }
  $('#sheetText').addEventListener('input', () => {
    edit((b) => {
      b.text = $('#sheetText').value;
      const el = $('#sheetBoxes [data-id="' + b.id + '"]');
      if (el) el.setAttribute('aria-label', 'Answer box: ' + (b.text || 'empty'));
    });
  });
  document.querySelectorAll('input[name="sheetKind"]').forEach((r) =>
    r.addEventListener('change', () => {
      if (r.checked) edit((b) => (b.kind = r.value));
    })
  );
  $('#sheetXh').addEventListener('input', () => {
    $('#o-sheetXh').textContent = Number($('#sheetXh').value).toFixed(1) + ' pt';
    edit((b) => (b.xhPt = Number($('#sheetXh').value)));
  });
  $('#sheetAuto').addEventListener('change', () => edit((b) => (b.auto = $('#sheetAuto').checked)));
  $('#sheetAgain').addEventListener('click', () => edit((b) => (b.seed = (b.seed || 1) + 1)));
  $('#sheetDelete').addEventListener('click', () => {
    const b = curBox();
    if (!b) return;
    boxes = boxes.filter((x) => x !== b);
    placedCache.delete(b.id);
    selId = null;
    drawBoxes();
    drawInk();
    syncForm();
    persist();
  });
  document.addEventListener('keydown', (ev) => {
    if ($('#sheet').hidden || !curBox()) return;
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !/^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      $('#sheetDelete').click();
    }
  });

  // ---- toolbar ---------------------------------------------------------------------------------------------------------------------------
  $('#sheetOpen').addEventListener('click', () => $('#sheetFile').click());
  $('#sheetFile').addEventListener('change', () => {
    const f = $('#sheetFile').files[0];
    $('#sheetFile').value = ''; // so choosing the same file again still opens it
    if (f) openFile(f);
  });
  $('#sheetDraw').addEventListener('click', () => {
    drawing = !drawing;
    syncUi();
  });
  async function turn(by) {
    pageIdx = clamp(pageIdx + by, 0, pdf.numPages - 1);
    selId = null;
    await showPage();
    syncUi();
  }
  $('#sheetPrev').addEventListener('click', () => turn(-1));
  $('#sheetNext').addEventListener('click', () => turn(1));

  // ---- saving ----------------------------------------------------------------------------------------------------------------------------
  function itemsFor(list) {
    return list.filter((b) => b.text.trim()).map((b) => ({ box: b, placed: placedFor(b).placed }));
  }

  async function filledPdf() {
    if (!haveStyle()) throw new Error('No handwriting has been taught yet.');
    await loadTools();
    const look = lookNow();
    return HW.sheet.writeInk(window.PDFLib, src.bytes, itemsFor(boxes), { ink: look.ink, pen: look.pen, constant: look.constant });
  }

  $('#sheetSavePdf').addEventListener('click', async () => {
    say('');
    status('Writing the PDF');
    try {
      const out = await filledPdf();
      download(new Blob([out], { type: 'application/pdf' }), baseName() + '-filled.pdf');
    } catch (e) {
      say('Could not save the PDF: ' + e.message);
    }
    status('');
  });

  $('#sheetSavePng').addEventListener('click', async () => {
    say('');
    status('Drawing the page');
    try {
      const S = 3; // pixels per point: about 216 dpi
      const page = await pdf.getPage(pageIdx + 1);
      const vp = page.getViewport({ scale: S });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (haveStyle()) {
        for (const { box, placed } of itemsFor(pageBoxes())) {
          const look = lookNow();
          ctx.save();
          ctx.translate((box.x - placed.dx * placed.K) * S, (box.y - placed.dy * placed.K) * S);
          ctx.scale(placed.K * S, placed.K * S);
          ctx.fillStyle = look.ink;
          ctx.fill(new Path2D(HW.sheet.inkPath(placed, look)), 'nonzero');
          ctx.restore();
        }
      }
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      download(blob, baseName() + '-page' + (pageIdx + 1) + '.png');
    } catch (e) {
      say('Could not save the picture: ' + e.message);
    }
    status('');
  });

  // ---- keeping up with the rest of the app ------------------------------------------------------------------------------------------------
  document.addEventListener('hw:rebuilt', () => {
    styleVersion++;
    if (pdf) {
      syncUi();
      if (!$('#sheet').hidden) drawInk();
    }
  });
  document.addEventListener('hw:tab', (ev) => {
    if (ev.detail === 'sheet' && pdf) showPage().then(syncUi);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdf && !$('#sheet').hidden) showPage();
    }, 200);
  });

  // For the tests: drive the tab without going through a file picker, and read the PDF it would save.
  window.HW_SHEET = {
    open: openBytes,
    filledPdf,
    get boxes() {
      return boxes;
    },
    get zoom() {
      return zoom;
    },
    get page() {
      return { w: pageW, h: pageH, idx: pageIdx };
    },
  };
  syncUi();
})();
