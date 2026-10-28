// Gráficas de ángulos en el tiempo (pequeños múltiplos con eje temporal compartido).
// Canvas propio, sin dependencias. Cursor sincronizado entre gráficas, tooltip y clic para ir al instante.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class AngleChart {
  constructor(container, { title, series }) {
    this.series = series; // [{id, label, side}]
    this.el = document.createElement('figure');
    this.el.className = 'chart-card';
    const legend = series.length > 1
      ? `<div class="legend">${series.map((s) => `<span class="key"><i class="sw side-${s.side}"></i>${s.label}</span>`).join('')}</div>`
      : '';
    this.el.innerHTML = `<figcaption><span class="chart-title">${title}</span>${legend}</figcaption>
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
    this.pad = { l: 34, r: 10, t: 8, b: 20 };

    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    this.canvas.addEventListener('pointermove', (e) => this.onHover?.(this.xToT(pos(e).x)));
    this.canvas.addEventListener('pointerleave', () => this.onHover?.(null));
    this.canvas.addEventListener('click', (e) => this.onSeek?.(this.xToT(pos(e).x)));
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  setData(times, data) {
    this.times = times;
    this.data = data;
    const vals = this.series.flatMap((s) => data[s.id] || []).filter((v) => v != null);
    const max = vals.length ? Math.max(...vals) : 90;
    this.yMax = Math.max(60, Math.ceil(max / 30) * 30);
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
      return `<div class="row"><i class="sw side-${s.side}"></i><span>${s.label}</span><b>${v == null ? '—' : v.toFixed(0) + '°'}</b></div>`;
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
    const stepY = this.yMax > 120 ? 60 : 30;
    for (let v = 0; v <= this.yMax; v += stepY) {
      const y = Math.round(this.vToY(v)) + 0.5;
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.pad.l, y); ctx.lineTo(w - this.pad.r, y); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'right';
      ctx.fillText(`${v}°`, this.pad.l - 6, y);
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

    // Series (huecos donde no hay detección)
    for (const s of this.series) {
      const vals = this.data[s.id] || [];
      ctx.strokeStyle = css(`--side-${s.side}`);
      ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        const x = this.tToX(this.times[i]), y = this.vToY(v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      });
      ctx.stroke();
    }

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
