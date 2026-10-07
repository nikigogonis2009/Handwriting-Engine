/* App wiring: Teach tab (capture words) and Write tab (generate handwriting). */
(function () {
  'use strict';
  const HW = window.HW;
  const $ = (s, el) => (el || document).querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---- persistence (all wrapped: Safari private mode / quota can throw) -------------------
  // another part of the site (a different password) keeps its own data, so two people on one browser never mix
  const NS = window.HW_PROFILE ? window.HW_PROFILE + ':' : '';
  const store = {
    get(key, dflt) {
      try {
        const v = localStorage.getItem(NS + key);
        return v ? JSON.parse(v) : dflt;
      } catch {
        return dflt;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(NS + key, JSON.stringify(val));
        return true;
      } catch {
        return false;
      }
    },
    del(key) {
      try {
        localStorage.removeItem(NS + key);
      } catch {
        /* ignore */
      }
    },
  };

  // ---- state ------------------------------------------------------------------------------
  let words = store.get('hw.words.v1', []).filter((w) => w && w.text && Array.isArray(w.strokes));
  let customSentences = store.get('hw.custom.v1', []);
  let style = null;
  let seed = 1;
  let lastLayout = null;
  let cur = { r: 0, i: 0 };
  let rebuildTimer = null;
  let renderQueued = false;

  const rounds = () => {
    const list = HW.prompts.ROUNDS.slice();
    customSentences.forEach((s, n) => list.push({ id: 'c' + n, title: 'Mine ' + (n + 1), blurb: 'Your own sentence.', sentences: [s], custom: true }));
    return list;
  };
  const tokensOf = (r) => HW.prompts.tokens(rounds()[r]);
  // a sentence written as a line is stored as its words; the line counts as done when they exist
  const capturedKeys = () => new Set(words.map((w) => w.key).concat(words.filter((w) => w.line).map((w) => w.line)));

  // ---- style -----------------------------------------------------------------------------
  function rebuild() {
    style = HW.style.buildStyle(words);
    updateStatus();
    updateRhythmNotes();
    renderCoverage();
    renderInspect();
    renderGallery();
    renderRounds();
    renderPrompt();
    if (!$('#write').hidden) queueRender();
    document.dispatchEvent(new Event('hw:rebuilt')); // the Sheet tab redraws its answers
  }
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 120);
  }
  // Fix mode: letters the writer has accepted on the page stay put when one is replaced. They are pinned
  // by example id, which is only meaningful for the samples they were chosen from, hence the version.
  let dataVersion = 0;
  let pinState = null; // {text, version, ids: [[unit id | null per letter] per word]}
  const fixStack = []; // what has been replaced, newest last, so it can be undone

  function persist() {
    dataVersion++;
    const ok = store.set('hw.words.v1', words);
    if (!ok) $('#status').textContent = 'Could not save in this browser (storage full?). Use Export to keep a copy.';
  }

  function updateRhythmNotes() {
    const r = style && style.rhythm;
    const note = $('#rhythmNote');
    const hint = $('#rhythmHint');
    if (r && r.learned) {
      note.textContent = 'Your line rhythm: learned from ' + r.lines + ' lines (word gaps, baseline, size and slant drift).';
      hint.hidden = false;
      hint.textContent = 'Uses the spacing and drift measured from your lines. 30% is the default; lower is neater, higher exaggerates.';
    } else {
      const n = r ? r.lines : 0;
      note.textContent = n
        ? 'Full lines: ' + n + ' so far, at least 3 are needed to learn your rhythm.'
        : 'Write a few lines in the Full lines round so spacing and drift come from your own writing.';
      hint.hidden = true;
    }
  }

  function updateStatus() {
    const n = style ? style.count : 0;
    const chars = style ? style.byChar.size : 0;
    $('#status').textContent = n ? n + ' words, ' + chars + ' characters learned' : 'No samples yet';
  }

  // ---- teach: rounds & prompt --------------------------------------------------------------
  const pad = new HW.Pad($('#pad'), { xh: 52, height: 270, onChange: onPadChange });

  function renderRounds() {
    const host = $('#rounds');
    host.textContent = '';
    const keys = capturedKeys();
    rounds().forEach((round, r) => {
      const toks = tokensOf(r);
      const done = toks.filter((t) => keys.has(t.key)).length;
      const b = el('button', 'round' + (r === cur.r ? ' cur' : '') + (done === toks.length ? ' done' : ''));
      b.type = 'button';
      b.append(el('b', '', round.title), el('span', '', done + ' / ' + toks.length));
      b.addEventListener('click', () => {
        if (commit() === 'failed') return;
        goTo(r, firstOpen(r));
      });
      host.appendChild(b);
    });
  }

  function firstOpen(r) {
    const keys = capturedKeys();
    const toks = tokensOf(r);
    const i = toks.findIndex((t) => !keys.has(t.key));
    return i < 0 ? 0 : i;
  }

  function renderPrompt() {
    const round = rounds()[cur.r];
    const toks = tokensOf(cur.r);
    const keys = capturedKeys();
    const tok = toks[cur.i];
    $('#roundBlurb').textContent = round.blurb || '';
    $('#wordCount').textContent = (tok.kind === 'line' ? 'Line ' : tok.iso ? 'Letter ' : 'Word ') + (cur.i + 1) + ' of ' + toks.length;
    setHint(tok.kind === 'line' ? LINE_HINT : tok.iso ? LETTER_HINT : WORD_HINT, false);
    const host = $('#prompt');
    host.textContent = '';
    if (tok.kind === 'line') {
      host.appendChild(el('span', 'w cur', tok.text));
    } else if (round.chars) {
      host.append(el('span', 'muted small', tok.iso ? 'Write this letter: ' : 'Write this mark: '), el('span', 'big', tok.text));
    } else {
      const sentence = round.sentences[tok.si];
      sentence
        .split(/\s+/)
        .filter(Boolean)
        .forEach((w, wi) => {
          const k = round.id + '.' + tok.si + '.' + wi;
          const span = el('span', 'w' + (wi === tok.wi ? ' cur' : keys.has(k) ? ' done' : ''), w);
          host.append(span, ' ');
        });
    }
    onPadChange();
  }

  const WORD_HINT = $('#padHint').textContent;
  const LETTER_HINT = 'Write just this letter, a little bigger and clearer than usual, sitting on the solid line.';
  const LINE_HINT = 'Write the whole sentence on one line, at your normal size and speed, with normal gaps between words.';
  function setHint(text, problem) {
    const h = $('#padHint');
    h.textContent = text;
    h.classList.toggle('problem', !!problem);
  }

  function onPadChange() {
    const empty = !pad.strokes.length;
    if ($('#padHint').classList.contains('problem')) {
      const tok = tokensOf(cur.r)[cur.i];
      setHint(tok.kind === 'line' ? LINE_HINT : tok.iso ? LETTER_HINT : WORD_HINT, false); // writing again clears the warning
    }
    const toks = tokensOf(cur.r);
    const last = cur.r === rounds().length - 1 && cur.i === toks.length - 1;
    $('#btnNext').textContent = empty ? 'Skip' : last ? 'Save' : 'Next';
    $('#btnUndo').disabled = empty;
    $('#btnClear').disabled = empty;
    const pen = pad.penSeen;
    $('#penState').textContent = !pen
      ? ''
      : pad.sawPressure
      ? 'Apple Pencil detected, pressure sensing on'
      : 'Apple Pencil detected, no pressure sensor, so line weight follows how fast you write';
  }

  function loadCurrentInk() {
    const tok = tokensOf(cur.r)[cur.i];
    if (tok.kind === 'line') {
      // a line is stored as its words, at their exact pad positions: put them back together
      const parts = words.filter((w) => w.line === tok.key).sort((a, b) => a.pos - b.pos);
      pad.load(parts.flatMap((w) => w.strokes));
      return;
    }
    const existing = words.find((w) => w.key === tok.key);
    pad.load(existing ? existing.strokes : []);
  }

  function goTo(r, i) {
    cur = { r, i };
    loadCurrentInk();
    renderRounds();
    renderPrompt();
  }

  /**
   * Save whatever is on the pad for the current word or line.
   * Returns 'saved', 'empty' (nothing written), or 'failed' (a line couldn't be split into words;
   * the pad is left as it is so it can be rewritten).
   */
  function commit() {
    const tok = tokensOf(cur.r)[cur.i];
    const snap = pad.snapshot(tok.text);
    if (!snap) return 'empty';
    if (tok.kind === 'line') {
      const res = HW.lines.splitLine(snap);
      if (!res.ok) {
        setHint(
          res.reason === 'words touch'
            ? 'The words run together, so I can\'t tell where each one starts. Leave a clear gap between words and write the line again.'
            : 'I couldn\'t tell where the words are. Leave clearer gaps between words (wider than the gaps between letters) and write the line again.',
          true
        );
        return 'failed';
      }
      words = words.filter((w) => w.line !== tok.key);
      res.words.forEach((w, i) => {
        w.line = tok.key;
        w.key = tok.key + '.w' + i;
        words.push(w);
      });
      persist();
      scheduleRebuild();
      return 'saved';
    }
    snap.key = tok.key;
    if (tok.iso) snap.iso = true; // a letter written on its own: no cutting needed
    const at = words.findIndex((w) => w.key === tok.key);
    if (at >= 0) words[at] = snap;
    else words.push(snap);
    persist();
    scheduleRebuild();
    return 'saved';
  }

  function advance() {
    const toks = tokensOf(cur.r);
    if (cur.i < toks.length - 1) goTo(cur.r, cur.i + 1);
    else if (cur.r < rounds().length - 1) goTo(cur.r + 1, firstOpen(cur.r + 1));
    else goTo(cur.r, cur.i);
  }

  function back() {
    if (cur.i > 0) goTo(cur.r, cur.i - 1);
    else if (cur.r > 0) goTo(cur.r - 1, tokensOf(cur.r - 1).length - 1);
  }

  $('#btnNext').addEventListener('click', () => {
    if (commit() === 'failed') return;
    advance();
  });
  $('#btnPrev').addEventListener('click', () => {
    if (commit() === 'failed') return;
    back();
  });
  $('#btnUndo').addEventListener('click', () => pad.undo());
  $('#btnClear').addEventListener('click', () => pad.clear());
  $('#palm').addEventListener('change', (e) => {
    pad.palmReject = e.target.checked;
  });
  document.addEventListener('keydown', (e) => {
    if ($('#teach').hidden) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#btnNext').click();
    } else if (e.key === 'ArrowLeft') $('#btnPrev').click();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      pad.undo();
    }
  });

  $('#btnCustom').addEventListener('click', () => {
    const v = $('#customText').value.trim().replace(/\s+/g, ' ');
    if (!v) return;
    if (commit() === 'failed') return;
    customSentences.push(v);
    store.set('hw.custom.v1', customSentences);
    $('#customText').value = '';
    goTo(rounds().length - 1, 0);
  });

  // ---- teach: coverage & gallery -------------------------------------------------------------
  let inspecting = null; // the letter being checked in the letter check

  function renderCoverage() {
    const host = $('#coverage');
    host.textContent = '';
    const cov = style ? HW.style.coverage(style) : {};
    HW.prompts.CHAR_GROUPS.forEach((g) => {
      host.appendChild(el('div', 'gtitle', g.title));
      const grid = el('div', 'chipgrid');
      for (const ch of g.chars) {
        const n = cov[ch] || 0;
        const chip = el('button', 'chip' + (n ? ' on' : '') + (ch === inspecting ? ' sel' : ''), ch);
        chip.type = 'button';
        if (n) chip.appendChild(el('sub', '', String(n)));
        chip.addEventListener('click', () => {
          inspecting = inspecting === ch ? null : ch;
          renderCoverage();
          renderInspect();
        });
        grid.appendChild(chip);
      }
      host.appendChild(grid);
    });
    const lower = 'abcdefghijklmnopqrstuvwxyz'.split('').filter((c) => !cov[c]);
    $('#missing').textContent = lower.length ? 'Still missing lowercase: ' + lower.join(' ') : 'All lowercase letters covered.';
  }

  function thumbSVG(w, index) {
    const S = 22;
    let maxX = 1;
    w.units.forEach((u) => {
      maxX = Math.max(maxX, u.box.maxX);
      u.marks.forEach((m) => m.pts.forEach((p) => (maxX = Math.max(maxX, p.x))));
    });
    const W = Math.ceil(maxX * S + 12);
    const H = Math.ceil(3.4 * S);
    let paths = '';
    w.units.forEach((u, i) => {
      const color = 'hsl(' + ((i * 53 + 210) % 360) + ',62%,42%)';
      let d = '';
      const conv = (p) => ({ x: p.x * S + 6, y: (2.3 - p.y) * S, w: p.w });
      u.strokes.forEach((s) => (d += HW.render.strokeToPath({ pts: s.pts.map(conv) }, 2.2, S)));
      u.marks.forEach((m) => (d += HW.render.strokeToPath({ pts: m.pts.map(conv) }, 2.2, S)));
      paths += '<path d="' + d + '" fill="' + color + '"/>';
    });
    const base = 2.3 * S;
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" stroke="#c9d3ee" stroke-width="1"/>' + paths + '</svg>'
    );
  }

  function unitSVG(u) {
    const S = 40;
    let minX = u.box.minX;
    let maxX = u.box.maxX;
    u.marks.forEach((m) => m.pts.forEach((p) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }));
    const W = Math.max(40, Math.ceil((maxX - minX) * S + 16));
    const H = Math.ceil(3.6 * S);
    const base = 2.4 * S;
    const conv = (p) => ({ x: (p.x - minX) * S + 8, y: (2.4 - p.y) * S, w: p.w });
    let d = '';
    u.strokes.forEach((s) => (d += HW.render.strokeToPath({ pts: s.pts.map(conv) }, 2.4, S)));
    u.marks.forEach((m) => (d += HW.render.strokeToPath({ pts: m.pts.map(conv) }, 2.4, S)));
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" stroke="#c9d3ee"/>' +
      '<line x1="0" x2="' + W + '" y1="' + (base - S) + '" y2="' + (base - S) + '" stroke="#e6ebf8" stroke-dasharray="3 3"/>' +
      '<path d="' + d + '" fill="#1b1f3b"/></svg>'
    );
  }

  /** Every example of one letter, so the ones that were cut wrongly can be crossed out. */
  function renderInspect() {
    const host = $('#inspect');
    host.textContent = '';
    if (!inspecting || !style) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const list = style.allByChar.get(inspecting) || [];
    const out = list.filter((u) => u.skipped).length;
    host.appendChild(
      el('p', 'muted small', list.length
        ? 'All ' + list.length + ' examples of "' + inspecting + '". Tap one that does not look like the letter to leave it out' + (out ? ' (' + out + ' left out)' : '') + '.'
        : 'No examples of "' + inspecting + '" yet.')
    );
    const grid = el('div', 'gallery');
    list.forEach((u) => {
      const tile = el('button', 'thumb unit' + (u.skipped ? ' out' : ''));
      tile.type = 'button';
      tile.innerHTML = unitSVG(u);
      tile.appendChild(el('small', '', u.word.text));
      tile.addEventListener('click', () => {
        const raw = words[u.wid];
        if (!raw) return;
        const cur = (raw.skip || []).filter((c) => !(c.i === u.idx && c.ch === u.ch));
        if (!u.skipped) cur.push({ i: u.idx, ch: u.ch });
        raw.skip = cur;
        persist();
        rebuild();
      });
      grid.appendChild(tile);
    });
    host.appendChild(grid);
  }

  function renderGallery() {
    const host = $('#gallery');
    host.textContent = '';
    if (!style) return;
    let bad = 0;
    style.words.forEach((w, i) => {
      const raw = words[i];
      const box = el('div', 'thumb');
      if (!w.ok) {
        box.classList.add('bad');
        box.append(el('small', '', w.text + ' (could not read)'));
        bad++;
      } else {
        box.innerHTML = thumbSVG(w, i);
        const suspect = !!w.suspect;
        if (suspect) {
          box.classList.add('bad');
          bad++;
        }
        box.appendChild(el('small', '', (suspect ? 'check: ' : '') + w.text));
      }
      const x = el('button', 'x', '×');
      x.type = 'button';
      x.title = 'Delete this sample';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        words.splice(i, 1);
        persist();
        rebuild();
      });
      box.appendChild(x);
      box.addEventListener('click', () => {
        const home = raw.line || raw.key;
        const at = rounds().findIndex((_, r) => tokensOf(r).some((t) => t.key === home));
        if (at < 0) return;
        if (commit() === 'failed') return;
        goTo(at, tokensOf(at).findIndex((t) => t.key === home));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      host.appendChild(box);
    });
    $('#samplesNote').textContent = style.words.length ? ', ' + style.words.length + ' words' + (bad ? ', ' + bad + ' need a second look' : '') : '';
  }

  // backup
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
  $('#btnExport').addEventListener('click', () => {
    download(new Blob([HW.style.toJSON(words)], { type: 'application/json' }), 'my-handwriting.json');
  });
  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const incoming = HW.style.fromJSON(await f.text());
      incoming.forEach((w, n) => {
        if (!w.key) w.key = 'import.' + Date.now() + '.' + n;
        const at = words.findIndex((x) => x.key === w.key);
        if (at >= 0) words[at] = w;
        else words.push(w);
      });
      persist();
      rebuild();
      $('#status').textContent = 'Imported ' + incoming.length + ' words';
    } catch {
      alert('That file is not a handwriting export.');
    }
  });
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('Delete all your handwriting samples from this browser?')) return;
    words = [];
    dataVersion++;
    customSentences = [];
    store.del('hw.words.v1');
    store.del('hw.custom.v1');
    pad.clear();
    goTo(0, 0);
    rebuild();
  });

  // ---- write ------------------------------------------------------------------------------------
  const CONTROLS = ['xh', 'messiness', 'drift', 'variation', 'neatness', 'wordReuse', 'slantDelta', 'wordSpacing', 'lineHeight', 'pen'];
  const fmt = {
    xh: (v) => v + ' px',
    messiness: (v) => Math.round(v * 100) + '%',
    drift: (v) => Math.round(v * 100) + '%',
    variation: (v) => Math.round(v * 100) + '%',
    neatness: (v) => Math.round(v * 100) + '%',
    wordReuse: (v) => Math.round(v * 100) + '%',
    slantDelta: (v) => (v > 0 ? '+' : '') + v + '°',
    wordSpacing: (v) => Number(v).toFixed(2) + '×',
    lineHeight: (v) => Number(v).toFixed(1) + '×',
    pen: (v) => Number(v).toFixed(2) + '×',
  };

  function readOpts() {
    const o = {};
    CONTROLS.forEach((k) => (o[k] = Number($('#' + k).value)));
    return o;
  }

  function syncOutputs() {
    CONTROLS.forEach((k) => ($('#o-' + k).textContent = fmt[k]($('#' + k).value)));
  }

  function saveSettings() {
    const s = { text: $('#text').value, paperKind: $('#paperKind').value, ink: $('#ink').value, penStyle: $('#penStyle').value, mathMode: $('#mathMode').checked };
    CONTROLS.forEach((k) => (s[k] = $('#' + k).value));
    store.set('hw.settings.v1', s);
  }

  /** Select an ink colour; one that is not in the list becomes a "Custom" entry. */
  function setInk(hex) {
    const sel = $('#ink');
    if (!Array.from(sel.options).some((op) => op.value === hex)) {
      let c = Array.from(sel.options).find((op) => op.dataset.custom);
      if (!c) {
        c = document.createElement('option');
        c.dataset.custom = '1';
        c.textContent = 'Custom';
        sel.appendChild(c);
      }
      c.value = hex;
    }
    sel.value = hex;
    if (/^#[0-9a-f]{6}$/i.test(hex)) $('#inkPicker').value = hex;
  }

  function loadSettings() {
    const s = store.get('hw.settings.v1', null);
    if (!s) return;
    if (typeof s.text === 'string') $('#text').value = s.text;
    $('#mathMode').checked = !!s.mathMode;
    $('#mathHelp').hidden = !s.mathMode;
    ['paperKind', 'penStyle'].forEach((k) => {
      if (s[k]) $('#' + k).value = s[k];
    });
    if (s.ink) setInk(s.ink);
    CONTROLS.forEach((k) => {
      if (s[k] !== undefined) $('#' + k).value = s[k];
    });
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderOutput();
    });
  }

  function paperOptions() {
    const o = readOpts();
    return { ink: $('#ink').value, pen: o.pen, constant: $('#penStyle').value === 'constant', paper: $('#paperKind').value };
  }

  function renderOutput() {
    if (!style) return;
    const canvas = $('#paper');
    const host = $('#paperhost');
    const empty = style.count === 0;
    $('#empty').hidden = !empty;
    const text = $('#text').value;
    const o = readOpts();
    const math = $('#mathMode').checked;

    const W = Math.max(320, Math.min(1100, Math.floor(host.clientWidth)));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    let lay;
    if (empty) lay = { width: W, height: 260, xh: o.xh, strokes: [], baselines: [80], lineHeightPx: o.lineHeight * o.xh, missing: [] };
    else if (math) lay = HW.math.layout(style, text, Object.assign({}, o, { width: W, seed }));
    else {
      const pins = pinState && pinState.version === dataVersion && pinState.text === text ? pinState.ids : undefined;
      lay = HW.synth.layout(style, text, Object.assign({}, o, { width: W, seed, pins }));
    }
    const missing = empty ? [] : math ? lay.missing : HW.style.missingChars(style, text);
    const warn = $('#warn');
    if (missing.length) {
      warn.hidden = false;
      warn.textContent = 'No sample yet for: ' + missing.join(' ') + '. Those characters are skipped. Add them in the Teach tab.';
    } else warn.hidden = true;
    lastLayout = lay;
    canvas.width = Math.round(lay.width * dpr);
    canvas.height = Math.round(Math.ceil(lay.height) * dpr);
    canvas.style.height = Math.ceil(lay.height) * (host.clientWidth / lay.width) + 'px';
    HW.render.drawToCanvas(canvas.getContext('2d'), lay, paperOptions(), dpr);
  }

  CONTROLS.concat(['paperKind', 'ink', 'penStyle']).forEach((k) => {
    $('#' + k).addEventListener('input', () => {
      syncOutputs();
      saveSettings();
      queueRender();
    });
  });
  $('#inkPicker').addEventListener('input', () => {
    setInk($('#inkPicker').value);
    saveSettings();
    queueRender();
  });
  $('#ink').addEventListener('change', () => {
    if (/^#[0-9a-f]{6}$/i.test($('#ink').value)) $('#inkPicker').value = $('#ink').value;
  });
  $('#mathMode').addEventListener('change', () => {
    clearFixes();
    syncFixMode();
    $('#mathHelp').hidden = !$('#mathMode').checked;
    saveSettings();
    queueRender();
  });
  $('#text').addEventListener('input', () => {
    clearFixes();
    saveSettings();
    queueRender();
  });
  $('#btnAgain').addEventListener('click', () => {
    clearFixes();
    seed = (seed * 48271 + 11) % 2147483647;
    queueRender();
  });
  window.addEventListener('resize', () => {
    if (!$('#write').hidden) queueRender();
  });

  // ---- fix mode: tap a letter that looks wrong ---------------------------------------------------
  function clearFixes() {
    pinState = null;
    fixStack.length = 0;
    showFixNote('');
  }

  function showFixNote(text) {
    $('#fixText').textContent = text;
    $('#fixNote').hidden = !text;
    $('#btnFixUndo').hidden = !fixStack.length;
  }

  function syncFixMode() {
    const math = $('#mathMode').checked;
    $('#fixRow').hidden = math; // letters of math are not traced back to examples (yet)
    if (math) $('#fixMode').checked = false;
    $('#paperhost').classList.toggle('fixing', $('#fixMode').checked);
    $('#fixHelp').hidden = !$('#fixMode').checked;
  }

  /** The letter under a point of the page, as {wi, ci} (word and letter number), or null. */
  function letterAt(lay, x, y) {
    let best = null;
    const tol = 0.15 * lay.xh;
    (lay.words || []).forEach((w, wi) => {
      if (!w || y < w.top || y > w.bottom) return;
      w.spans.forEach(([lo, hi], ci) => {
        if (x < lo - tol || x > hi + tol) return;
        const d = Math.abs(x - (lo + hi) / 2) / Math.max(1, hi - lo);
        if (!best || d < best.d) best = { wi, ci, d };
      });
    });
    return best;
  }

  function replaceLetter(wi, ci) {
    const lay = lastLayout;
    const unit = lay.words[wi].choices[ci];
    const raw = words[unit.wid];
    if (!raw) return;
    const idsNow = lay.words.map((w) => (w ? w.ids.slice() : null));
    const pins = idsNow.map((ids, k) => (ids ? ids.map((id, j) => (k === wi && j === ci ? null : id)) : null));
    raw.skip = (raw.skip || []).filter((c) => !(c.i === unit.idx && c.ch === unit.ch)).concat([{ i: unit.idx, ch: unit.ch }]);
    persist(); // changes dataVersion, so the pins are set after it
    pinState = { text: $('#text').value, version: dataVersion, ids: pins };
    fixStack.push({ wid: unit.wid, idx: unit.idx, ch: unit.ch, ids: idsNow });
    rebuild();
    showFixNote('Replaced that “' + unit.ch + '” (it came from “' + unit.word.text + '”) and left out of what gets written. The rest of the page is as it was.');
  }

  function undoFix() {
    const f = fixStack.pop();
    if (!f) return;
    const raw = words[f.wid];
    if (raw) raw.skip = (raw.skip || []).filter((c) => !(c.i === f.idx && c.ch === f.ch));
    persist();
    pinState = { text: $('#text').value, version: dataVersion, ids: f.ids };
    rebuild();
    showFixNote('Put that letter back.');
  }

  $('#paper').addEventListener('click', (e) => {
    if (!$('#fixMode').checked || !lastLayout || !lastLayout.words || $('#mathMode').checked) return;
    const r = $('#paper').getBoundingClientRect();
    const x = ((e.clientX - r.left) * lastLayout.width) / r.width;
    const y = ((e.clientY - r.top) * Math.ceil(lastLayout.height)) / r.height;
    const hit = letterAt(lastLayout, x, y);
    if (hit) replaceLetter(hit.wi, hit.ci);
  });
  $('#fixMode').addEventListener('change', syncFixMode);
  $('#btnFixUndo').addEventListener('click', undoFix);

  $('#btnSVG').addEventListener('click', () => {
    if (!lastLayout) return;
    download(new Blob([HW.render.toSVG(lastLayout, paperOptions())], { type: 'image/svg+xml' }), 'handwriting.svg');
  });
  $('#btnPNG').addEventListener('click', async () => {
    if (!lastLayout) return;
    const c = document.createElement('canvas');
    const sc = 2;
    c.width = lastLayout.width * sc;
    c.height = Math.ceil(lastLayout.height) * sc;
    HW.render.drawToCanvas(c.getContext('2d'), lastLayout, paperOptions(), sc);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'handwriting.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    download(blob, 'handwriting.png');
  });

  if (window.HW_PROFILE_KIND === 'ai') $('#guestNote').hidden = false; // the small part: three steps at the top

  // ---- tabs -------------------------------------------------------------------------------------
  const TABS = ['teach', 'write', 'sheet'];
  function showTab(name) {
    TABS.forEach((t) => {
      $('#' + t).hidden = t !== name;
      $('#tab-' + t).setAttribute('aria-selected', String(t === name));
    });
    if (name === 'teach') pad.resize();
    else if (name === 'write') queueRender();
    document.dispatchEvent(new CustomEvent('hw:tab', { detail: name }));
    try {
      history.replaceState(null, '', '#' + name);
    } catch {
      /* file:// in some browsers */
    }
  }
  $('#tab-teach').addEventListener('click', () => {
    showTab('teach');
  });
  ['write', 'sheet'].forEach((name) =>
    $('#tab-' + name).addEventListener('click', () => {
      if (commit() === 'failed') return;
      showTab(name);
    })
  );

  // On the password-protected site the login page provides HW_LOCK
  if (window.HW_LOCK) {
    $('#btnLock').hidden = false;
    $('#btnLock').addEventListener('click', window.HW_LOCK);
  }

  // ---- boot -------------------------------------------------------------------------------------
  loadSettings();
  syncFixMode();
  syncOutputs();
  goTo(0, firstOpen(0));
  const hash = (location.hash || '').replace('#', '');
  showTab(TABS.includes(hash) ? hash : words.length >= 20 ? 'write' : 'teach');
  // The first build of a large saved set takes a few seconds. Let the page paint first so it never looks frozen.
  if (words.length) $('#status').textContent = 'Loading your handwriting';
  requestAnimationFrame(() => setTimeout(rebuild, 30));

  window.HW_APP = {
    pad,
    get style() {
      return style;
    },
    get words() {
      return words;
    },
    get layout() {
      return lastLayout;
    },
    rebuild,
    goTo,
    commit,
    advance,
    get cur() {
      return cur;
    },
    tokensOf,
    rounds,
    letterAt,
    // what the Sheet tab needs to write like the Write tab does: the sliders and the pen
    look() {
      return Object.assign(readOpts(), paperOptions());
    },
  };
})();
