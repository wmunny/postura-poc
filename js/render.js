// Dibujo del esqueleto sobre el vídeo (2D) y visor 3D simple de las coordenadas "world".

import { CONNECTIONS } from './pose.js';
import { VISIBILITY_THRESHOLD } from './config.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Rectángulo que ocupa realmente la imagen dentro del <video> (object-fit: contain). */
function contentRect(video, w, h) {
  const vw = video.videoWidth || w, vh = video.videoHeight || h;
  const s = Math.min(w / vw, h / vh);
  return { x: (w - vw * s) / 2, y: (h - vh * s) / 2, w: vw * s, h: vh * s };
}

const sideColor = (s) => (s === 'C' ? css('--skeleton-c') : css(`--side-${s}`));

export function drawOverlay(canvas, video, frame) {
  const { ctx, w, h } = fitCanvas(canvas);
  if (!frame?.lm) return;
  const r = contentRect(video, w, h);
  const P = frame.lm.map((p) => [r.x + p[0] * r.w, r.y + p[1] * r.h, p[3]]);
  const lw = Math.max(2, Math.min(4, r.w / 250));

  ctx.lineCap = 'round';
  for (const [a, b, s] of CONNECTIONS) {
    const vis = Math.min(P[a][2], P[b][2]) >= VISIBILITY_THRESHOLD;
    ctx.globalAlpha = vis ? 0.95 : 0.25;
    ctx.strokeStyle = sideColor(s);
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); ctx.stroke();
  }
  for (let i = 0; i < P.length; i++) {
    if (i > 0 && i < 11 && i !== 7 && i !== 8) continue; // cara: solo nariz y orejas
    ctx.globalAlpha = P[i][2] >= VISIBILITY_THRESHOLD ? 1 : 0.3;
    ctx.beginPath(); ctx.arc(P[i][0], P[i][1], lw * 1.3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#111'; ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Visor 3D ortográfico con rotación por arrastre. */
export class Viewer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.yaw = 0; this.pitch = 0.15;
    this.frame = null;
    this.center = 0;
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, drag.pitch + (e.clientY - drag.y) * 0.01));
      this.draw();
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setView(name) {
    const views = { camara: [0, 0.15], lateral: [Math.PI / 2, 0.1], superior: [0, 1.4] };
    [this.yaw, this.pitch] = views[name] || views.camara;
    this.draw();
  }

  setFrame(frame) { this.frame = frame; this.draw(); }

  project(p, w, h, scale) {
    // MediaPipe world: x derecha, y abajo, z hacia la cámara (negativo = más cerca).
    // Centramos verticalmente el cuerpo: el origen (cadera) queda a media altura entre cabeza y pies.
    let x = p[0], y = -(p[1] - this.center), z = -p[2];
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    return [w / 2 + x * scale, h * 0.5 - y * scale, z];
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    const scale = Math.min(w, h) / 2.3; // ~2,3 m visibles
    const f = this.frame;
    const ground = f?.wlm ? Math.max(...[27, 28, 29, 30, 31, 32].map((i) => f.wlm[i][1])) : 0.9;
    const top = f?.wlm ? Math.min(...f.wlm.map((q) => q[1])) : -0.8;
    this.center = (ground + top) / 2;

    // Suelo: rejilla de 2 x 2 m en el plano de los pies
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    for (let k = -1; k <= 1.0001; k += 0.25) {
      const a = this.project([k, ground, -1], w, h, scale), b = this.project([k, ground, 1], w, h, scale);
      const c = this.project([-1, ground, k], w, h, scale), d = this.project([1, ground, k], w, h, scale);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
    }
    if (!f?.wlm) {
      ctx.fillStyle = css('--text-muted'); ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Sin persona detectada en este fotograma', w / 2, h / 2);
      return;
    }
    const P = f.wlm.map((p) => this.project(p, w, h, scale));
    const segs = CONNECTIONS.map(([a, b, s]) => ({ a, b, s, z: (P[a][2] + P[b][2]) / 2 }))
      .sort((m, n) => m.z - n.z);
    ctx.lineCap = 'round'; ctx.lineWidth = 3;
    for (const { a, b, s } of segs) {
      ctx.globalAlpha = Math.min(f.lm[a][3], f.lm[b][3]) >= VISIBILITY_THRESHOLD ? 1 : 0.3;
      ctx.strokeStyle = sideColor(s);
      ctx.beginPath(); ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
