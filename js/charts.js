// Gráficas de ángulos en el tiempo (pequeños múltiplos con eje temporal compartido).
// Canvas propio, sin dependencias. Cursor sincronizado entre gráficas, tooltip y clic para ir al instante.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class AngleChart {
  /** `yLabels`: si se pasa, el eje Y son categorías (0, 1, 2…) con esas etiquetas en vez de grados. */
  constructor(container, { title, series, yLabels = null, note = '' }) {
    this.series = series; // [{id, label, side}]
    this.yLabels = yLabels;
    this.el = document.createElement('figure');
    this.el.className = 'chart-card';
    const legend = series.length > 1
      ? `<div class="legend">${series.map((s) => `<span class="key"><i class="sw side-${s.side}"></i>${s.label}</span>`).join('')}</div>`
      : '';
    this.el.innerHTML = `<figcaption><span class="chart-title">${title}</span>${legend}</figcaption>${note ? `<p class="micro chart-note">${note}</p>` : ''}
      <div class="chart-wrap"><canvas></canvas><div class="tooltip" hidden></div></div>`;
    container.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas');
    this.tooltip = this.el.querySelector('.tooltip');
    this.ctx = this.canvas.getContext('2d');
    this.times = [];
    this.data = {};
    this.hoverT = null;
    this.playT = null;
    this.onSeek = null;
    this.onHover = null;
    this.pad = { l: yLabels ? 62 : 34, r: 10, t: 8, b: 20 };

    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    this.canvas.addEventListener('pointermove', (e) => this.onHover?.(this.xToT(pos(e).x)));
    this.canvas.addEventListener('pointerleave', () => this.onHover?.(null));
    this.canvas.addEventListener('click', (e) => this.onSeek?.(this.xToT(pos(e).x)));
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  /**
   * `ghost`: serie de referencia que se dibuja tenue debajo (la serie en bruto).
   * `bands`: tramos [inicio, fin, tipo] que se sombrean: 'rechazo' (rojo) o 'aprox' (ámbar), de Argon.
   */
  setData(times, data, ghost = null, bands = null) {
    this.times = times;
    this.data = data;
    this.ghost = ghost;
    this.bands = bands;
    const vals = this.series.flatMap((s) => [...(data[s.id] || []), ...(ghost?.[s.id] || [])]).filter((v) => v != null);
    const max = vals.length ? Math.max(...vals) : 90;
    this.yMax = this.yLabels ? this.yLabels.length - 1 : Math.max(60, Math.ceil(max / 30) * 30);
    this.tMax = times.length ? times[times.length - 1] : 1;
    this.draw();
  }

  get w() { return this.canvas.clientWidth; }
  get h() { return this.canvas.clientHeight; }
  tToX(t) { return this.pad.l + (t / (this.tMax || 1)) * (this.w - this.pad.l - this.pad.r); }
  xToT(x) {
    const t = ((x - this.pad.l) / (this.w - this.pad.l - this.pad.r)) * this.tMax;
    return Math.max(0, Math.min(this.tMax, t));
  }
  vToY(v) { return this.pad.t + (1 - v / this.yMax) * (this.h - this.pad.t - this.pad.b); }
  fmt(v) { return v == null ? '—' : this.yLabels ? this.yLabels[Math.round(v)] : `${v.toFixed(0)}°`; }

  indexAt(t) {
    const a = this.times;
    if (!a.length || t == null) return -1;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(a[lo - 1] - t) < Math.abs(a[lo] - t)) lo--;
    return lo;
  }

  setHover(t) { this.hoverT = t; this.draw(); this.updateTooltip(); }
  setPlayhead(t) { this.playT = t; this.draw(); }

  updateTooltip() {
    const i = this.indexAt(this.hoverT);
    if (this.hoverT == null || i < 0) { this.tooltip.hidden = true; return; }
    const rows = this.series.map((s) => {
      const v = this.data[s.id]?.[i];
      const g = this.ghost?.[s.id]?.[i];
      const ref = this.ghost && g !== v ? ` <span class="muted">(${this.fmt(g)})</span>` : '';
      return `<div class="row"><i class="sw side-${s.side}"></i><span>${s.label}</span><b>${this.fmt(v)}${ref}</b></div>`;
    }).join('');
    this.tooltip.innerHTML = `<div class="tt-time">${this.times[i].toFixed(2)} s</div>${rows}`;
    this.tooltip.hidden = false;
    const x = this.tToX(this.times[i]);
    const tw = this.tooltip.offsetWidth;
    this.tooltip.style.left = `${x + 12 + tw > this.w ? x - tw - 12 : x + 12}px`;
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h, ctx } = this;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const grid = css('--grid'), muted = css('--text-muted');
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Rejilla y eje Y
    const stepY = this.yLabels ? 1 : this.yMax > 120 ? 60 : 30;
    for (let v = 0; v <= this.yMax; v += stepY) {
      const y = Math.round(this.vToY(v)) + 0.5;
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.pad.l, y); ctx.lineTo(w - this.pad.r, y); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'right';
      ctx.fillText(this.yLabels ? this.yLabels[v] : `${v}°`, this.pad.l - 6, y);
    }
    // Eje X
    if (this.times.length) {
      const span = this.tMax;
      const stepT = span > 120 ? 30 : span > 60 ? 10 : span > 20 ? 5 : span > 8 ? 2 : 1;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let t = 0; t <= span + 1e-6; t += stepT) {
        ctx.fillStyle = muted;
        ctx.fillText(`${t}s`, this.tToX(t), h - this.pad.b + 5);
      }
    }

    // Tramos corregidos
    if (this.bands?.length) {
      for (const [a, b, kind] of this.bands) {
        ctx.fillStyle = css(kind === 'aprox' ? '--band-aprox' : '--band');
        const x0 = this.tToX(Math.max(0, a)), x1 = this.tToX(Math.min(this.tMax, b));
        ctx.fillRect(x0, this.pad.t, Math.max(2, x1 - x0), h - this.pad.t - this.pad.b);
      }
    }

    // Series (huecos donde no hay detección); la referencia, tenue y debajo
    const line = (vals, color, width, alpha) => {
      ctx.strokeStyle = color; ctx.globalAlpha = alpha;
      ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        const x = this.tToX(this.times[i]), y = this.vToY(v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (this.ghost) for (const s of this.series) line(this.ghost[s.id] || [], css(`--side-${s.side}`), 1.5, 0.28);
    for (const s of this.series) line(this.data[s.id] || [], css(`--side-${s.side}`), 2, 1);

    // Cabezal de reproducción
    if (this.playT != null) {
      const x = Math.round(this.tToX(this.playT)) + 0.5;
      ctx.strokeStyle = css('--text-secondary'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, this.pad.t); ctx.lineTo(x, h - this.pad.b); ctx.stroke();
    }
    // Cursor de hover + marcadores
    const i = this.indexAt(this.hoverT);
    if (this.hoverT != null && i >= 0) {
      const x = Math.round(this.tToX(this.times[i])) + 0.5;
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, this.pad.t); ctx.lineTo(x, h - this.pad.b); ctx.stroke();
      ctx.setLineDash([]);
      for (const s of this.series) {
        const v = this.data[s.id]?.[i];
        if (v == null) continue;
        ctx.beginPath(); ctx.arc(x, this.vToY(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = css(`--side-${s.side}`); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = css('--surface'); ctx.stroke();
      }
    }
  }
}
