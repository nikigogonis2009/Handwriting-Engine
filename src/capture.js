/*
 * The writing pad. Records pen strokes with Pointer Events. Made for Apple Pencil on iPad, but
 * mouse and finger work too. A stroke is [[x, y, t, p], ...] in CSS pixels, t in ms.
 */
(function (root) {
  'use strict';

  class Pad {
    /**
     * @param canvas  <canvas> element
     * @param opts    {xh: px per x-height, height: css px, onChange: fn}
     */
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.xh = (opts && opts.xh) || 52;
      this.height = (opts && opts.height) || 270;
      this.onChange = (opts && opts.onChange) || function () {};
      this.strokes = [];
      this.active = null;
      this.penSeen = false;
      this.penDown = false;
      this.sawPressure = false;
      this.palmReject = true;
      this.t0 = null;
      this.enabled = true;

      canvas.style.touchAction = 'none';
      canvas.style.webkitUserSelect = 'none';
      canvas.style.userSelect = 'none';
      canvas.style.webkitTouchCallout = 'none';
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointerdown', (e) => this._down(e));
      canvas.addEventListener('pointermove', (e) => this._move(e));
      canvas.addEventListener('pointerup', (e) => this._up(e));
      canvas.addEventListener('pointercancel', (e) => this._up(e));
      // iOS: stop the long-press magnifier / text selection from stealing the stroke
      canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

      this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
      if (this._ro) this._ro.observe(canvas.parentElement);
      this.resize();
    }

    get guides() {
      const baseline = Math.round(this.height * 0.7);
      return {
        baseline,
        xh: this.xh,
        xHeightLine: baseline - this.xh,
        ascenderLine: baseline - Math.round(this.xh * 2),
        descenderLine: baseline + Math.round(this.xh * 0.95),
      };
    }

    resize() {
      const w = Math.max(280, Math.floor(this.canvas.parentElement.clientWidth));
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      this.width = w;
      this.canvas.parentElement.style.height = this.height + 'px'; // canvas itself is out of flow
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = this.height + 'px';
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.dpr = dpr;
      this.redraw();
    }

    // ---- input ----------------------------------------------------------------------------

    _pt(ev) {
      const r = this.canvas.getBoundingClientRect();
      if (this.t0 === null) this.t0 = ev.timeStamp;
      let p = ev.pressure;
      if (ev.pointerType === 'pen' && p > 0) this.sawPressure = this.sawPressure || Math.abs(p - 0.5) > 0.001;
      if (!p) p = 0.5; // touch / mouse / pencils without a pressure sensor
      return [
        Math.round((ev.clientX - r.left) * 10) / 10,
        Math.round((ev.clientY - r.top) * 10) / 10,
        Math.round(ev.timeStamp - this.t0),
        Math.round(p * 100) / 100,
      ];
    }

    _down(ev) {
      if (!this.enabled) return;
      if (ev.pointerType === 'pen') {
        this.penSeen = true;
        this.penDown = true;
      } else if (ev.pointerType === 'touch' && this.palmReject && (this.penDown || this.penSeen)) {
        ev.preventDefault();
        return; // palm / finger while using a Pencil
      }
      if (this.active) return;
      ev.preventDefault();
      try {
        this.canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* synthetic events have no active pointer */
      }
      this.active = { id: ev.pointerId, type: ev.pointerType, pts: [this._pt(ev)] };
      this._drawTail(this.active.pts, true);
    }

    _move(ev) {
      const a = this.active;
      if (!a || ev.pointerId !== a.id) return;
      ev.preventDefault();
      const list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null;
      const evs = list && list.length ? list : [ev];
      for (const e of evs) a.pts.push(this._pt(e));
      this._drawTail(a.pts, false);
    }

    _up(ev) {
      if (ev.pointerType === 'pen') this.penDown = false;
      const a = this.active;
      if (!a || ev.pointerId !== a.id) return;
      if (ev.type === 'pointerup') a.pts.push(this._pt(ev));
      this.active = null;
      if (a.pts.length >= 1) {
        // a tap (single sample) becomes a dot
        if (a.pts.length === 1) a.pts.push(a.pts[0].slice());
        this.strokes.push(a.pts);
      }
      this.redraw();
      this.onChange(this);
    }

    // ---- drawing --------------------------------------------------------------------------

    _drawTail(pts, first) {
      const c = this.ctx;
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.strokeStyle = '#1b1f3b';
      c.fillStyle = '#1b1f3b';
      c.lineWidth = 2.6;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      const n = pts.length;
      if (first || n < 2) {
        c.beginPath();
        c.arc(pts[0][0], pts[0][1], 1.4, 0, Math.PI * 2);
        c.fill();
      } else {
        const a = pts[Math.max(0, n - 3)];
        const b = pts[n - 2];
        const d = pts[n - 1];
        c.beginPath();
        c.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        c.quadraticCurveTo(b[0], b[1], (b[0] + d[0]) / 2, (b[1] + d[1]) / 2);
        c.stroke();
      }
      c.restore();
    }

    _drawGuides() {
      const c = this.ctx;
      const g = this.guides;
      const W = this.width;
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.fillStyle = '#fffdf7';
      c.fillRect(0, 0, W, this.height);
      // x-height band
      c.fillStyle = 'rgba(120,150,220,0.07)';
      c.fillRect(0, g.xHeightLine, W, g.baseline - g.xHeightLine);
      c.lineWidth = 1;
      const line = (y, color, dash) => {
        c.strokeStyle = color;
        c.setLineDash(dash);
        c.beginPath();
        c.moveTo(0, y + 0.5);
        c.lineTo(W, y + 0.5);
        c.stroke();
      };
      line(g.ascenderLine, 'rgba(120,150,220,0.35)', [2, 6]);
      line(g.xHeightLine, 'rgba(120,150,220,0.55)', [6, 5]);
      line(g.baseline, 'rgba(70,100,190,0.75)', []);
      line(g.descenderLine, 'rgba(120,150,220,0.35)', [2, 6]);
      c.restore();
    }

    redraw() {
      this._drawGuides();
      const c = this.ctx;
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.strokeStyle = '#1b1f3b';
      c.fillStyle = '#1b1f3b';
      c.lineWidth = 2.6;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      for (const s of this.strokes) {
        if (s.length < 2 || (s.length === 2 && s[0][0] === s[1][0] && s[0][1] === s[1][1])) {
          c.beginPath();
          c.arc(s[0][0], s[0][1], 1.6, 0, Math.PI * 2);
          c.fill();
          continue;
        }
        c.beginPath();
        c.moveTo(s[0][0], s[0][1]);
        for (let i = 1; i < s.length - 1; i++) {
          c.quadraticCurveTo(s[i][0], s[i][1], (s[i][0] + s[i + 1][0]) / 2, (s[i][1] + s[i + 1][1]) / 2);
        }
        c.lineTo(s[s.length - 1][0], s[s.length - 1][1]);
        c.stroke();
      }
      c.restore();
    }

    // ---- editing --------------------------------------------------------------------------

    undo() {
      if (this.strokes.pop()) {
        this.redraw();
        this.onChange(this);
      }
    }

    clear() {
      this.strokes = [];
      this.t0 = null;
      this.redraw();
      this.onChange(this);
    }

    /** Replace the ink (e.g. when going back to a word that was already captured). */
    load(strokes) {
      this.strokes = (strokes || []).map((s) => s.map((p) => p.slice()));
      this.t0 = null;
      this.redraw();
      this.onChange(this);
    }

    /** Snapshot as a raw word for the engine, or null when the pad is empty. */
    snapshot(text) {
      if (!this.strokes.length) return null;
      const g = this.guides;
      const base = this.strokes[0][0][2] || 0;
      return {
        text,
        xh: g.xh,
        baseline: g.baseline,
        pen: this.penSeen,
        strokes: this.strokes.map((s) => s.map((p) => [p[0], p[1], Math.max(0, p[2] - base), p[3]])),
      };
    }

    destroy() {
      if (this._ro) this._ro.disconnect();
    }
  }

  root.HW = root.HW || {};
  root.HW.Pad = Pad;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Pad };
})(typeof globalThis !== 'undefined' ? globalThis : this);
