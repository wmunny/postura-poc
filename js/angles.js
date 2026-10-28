// Cálculo de ángulos articulares a partir de los puntos clave.
//
// Dos modos:
//  - '2d': plano de la imagen (en píxeles). Es lo que mide un técnico sobre un vídeo
//          grabado en perpendicular al plano del movimiento (p. ej. vista lateral).
//  - '3d': coordenadas "world" de MediaPipe (metros, origen en el centro de la cadera).
//          Independiente del punto de vista, pero la profundidad es una estimación monocular.
//
// Convenciones: ángulos en grados, sin signo; 0° = postura neutra de referencia.
// La vertical se toma del eje vertical de la cámara: graba con el móvil recto y estable.

import { VISIBILITY_THRESHOLD } from './config.js';
import { invalidPoints, filterSeries, RAZONES } from './filters.js';

const L = {
  nose: 0, earL: 7, earR: 8,
  shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16,
  hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28,
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
function angleBetween(u, v) {
  const n = norm(u) * norm(v);
  if (n < 1e-9) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / n))) * 180) / Math.PI;
}
const flex = (a) => (a == null ? null : 180 - a); // ángulo interno -> flexión

const UP = [0, -1, 0]; // en imagen y en "world" de MediaPipe el eje Y apunta hacia abajo

// Definición de los ángulos. `group` agrupa izquierda/derecha en la misma gráfica.
export const ANGLE_DEFS = [
  {
    id: 'tronco', group: 'tronco', side: 'C', label: 'Tronco',
    help: 'Inclinación del tronco respecto a la vertical (cadera→hombros).',
    needs: [L.shL, L.shR, L.hipL, L.hipR],
    fn: (p) => angleBetween(sub(mid(p[L.shL], p[L.shR]), mid(p[L.hipL], p[L.hipR])), UP),
  },
  {
    id: 'cuello', group: 'cuello', side: 'C', label: 'Cuello',
    help: 'Flexión aproximada del cuello: eje hombros→orejas respecto al eje del tronco.',
    needs: [L.shL, L.shR, L.hipL, L.hipR, L.earL, L.earR],
    fn: (p) => {
      const sh = mid(p[L.shL], p[L.shR]);
      return angleBetween(sub(mid(p[L.earL], p[L.earR]), sh), sub(sh, mid(p[L.hipL], p[L.hipR])));
    },
  },
  ...['L', 'R'].flatMap((s) => {
    const k = (n) => L[n + s];
    const side = s === 'L' ? 'izq.' : 'dch.';
    return [
      {
        id: `hombro_${s}`, group: 'hombro', side: s, label: `Hombro ${side}`,
        help: 'Elevación del brazo: ángulo entre brazo (hombro→codo) y tronco hacia abajo.',
        needs: [k('sh'), k('el'), L.shL, L.shR, L.hipL, L.hipR],
        fn: (p) => angleBetween(sub(p[k('el')], p[k('sh')]),
          sub(mid(p[L.hipL], p[L.hipR]), mid(p[L.shL], p[L.shR]))),
      },
      {
        id: `codo_${s}`, group: 'codo', side: s, label: `Codo ${side}`,
        help: 'Flexión del codo (0° = brazo extendido).',
        needs: [k('sh'), k('el'), k('wr')],
        fn: (p) => flex(angleBetween(sub(p[k('sh')], p[k('el')]), sub(p[k('wr')], p[k('el')]))),
      },
      {
        id: `cadera_${s}`, group: 'cadera', side: s, label: `Cadera ${side}`,
        help: 'Flexión de cadera: ángulo entre tronco y muslo (0° = alineados).',
        needs: [k('sh'), k('hip'), k('kn')],
        fn: (p) => flex(angleBetween(sub(p[k('sh')], p[k('hip')]), sub(p[k('kn')], p[k('hip')]))),
      },
      {
        id: `rodilla_${s}`, group: 'rodilla', side: s, label: `Rodilla ${side}`,
        help: 'Flexión de rodilla (0° = pierna extendida).',
        needs: [k('hip'), k('kn'), k('an')],
        fn: (p) => flex(angleBetween(sub(p[k('hip')], p[k('kn')]), sub(p[k('an')], p[k('kn')]))),
      },
    ];
  }),
];

export const GROUPS = [
  { id: 'tronco', label: 'Tronco · inclinación' },
  { id: 'cuello', label: 'Cuello · flexión (aprox.)' },
  { id: 'hombro', label: 'Hombro · elevación del brazo' },
  { id: 'codo', label: 'Codo · flexión' },
  { id: 'cadera', label: 'Cadera · flexión' },
  { id: 'rodilla', label: 'Rodilla · flexión' },
];

function pointsFor(frame, mode, width, height) {
  if (!frame.lm) return null;
  if (mode === '3d') return frame.wlm ? frame.wlm.map((q) => [q[0], q[1], q[2]]) : null;
  return frame.lm.map((q) => [q[0] * width, q[1] * height, 0]);
}

/** Ángulos de un fotograma: { id: valor|null } */
export function anglesForFrame(frame, mode, width, height) {
  const out = {};
  const pts = pointsFor(frame, mode, width, height);
  for (const def of ANGLE_DEFS) {
    if (!pts) { out[def.id] = null; continue; }
    const visible = def.needs.every((i) => frame.lm[i][3] >= VISIBILITY_THRESHOLD);
    const v = visible ? def.fn(pts) : null;
    out[def.id] = v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10;
  }
  return out;
}

/** Media móvil centrada que respeta los huecos (null). */
function smooth(series, window) {
  if (window <= 1) return series.slice();
  const h = Math.floor(window / 2);
  return series.map((v, i) => {
    if (v == null) return null;
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(series.length - 1, i + h); j++) {
      if (series[j] != null) { s += series[j]; n++; }
    }
    return Math.round((s / n) * 10) / 10;
  });
}

/**
 * Series temporales de todos los ángulos.
 * Con `filtros`, devuelve también la serie sin filtrar (`raw`) y los recuentos por razón (`quality`).
 */
export function computeSeries(frames, { mode = '2d', width, height, smoothWindow = 1, filtros = false } = {}) {
  const times = frames.map((f) => f.t);
  const perFrame = frames.map((f) => anglesForFrame(f, mode, width, height));
  const invalid = filtros ? invalidPoints(frames, width, height) : null;
  const series = {}, raw = {}, quality = {};
  for (const def of ANGLE_DEFS) {
    const q = Object.fromEntries(Object.keys(RAZONES).map((k) => [k, 0]));
    const base = perFrame.map((a) => a[def.id]);
    let vals = base.map((v, i) => {
      if (v == null) { if (frames[i].lm) q.visibilidad++; return null; }
      const why = invalid?.[i] && def.needs.map((k) => invalid[i].get(k)).find(Boolean);
      if (why) { q[why]++; return null; }
      return v;
    });
    if (filtros) vals = filterSeries(vals, times, def.group, q);
    series[def.id] = smooth(vals, smoothWindow);
    raw[def.id] = smooth(base, smoothWindow);
    quality[def.id] = q;
  }
  return { times, series, raw: filtros ? raw : null, quality };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function stats(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const r = (x) => Math.round(x * 10) / 10;
  return {
    n: v.length, mean: r(mean), min: r(v[0]), p50: r(percentile(v, 0.5)),
    p95: r(percentile(v, 0.95)), max: r(v[v.length - 1]),
  };
}
