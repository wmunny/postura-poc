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
// `alts`: cálculos alternativos, en orden de preferencia, si falta algún punto de `needs`
// (por ejemplo, de perfil o con un lado tapado se usa solo el lado visible).
const side = (s) => ({ sh: L[`sh${s}`], hip: L[`hip${s}`], ear: L[`ear${s}`] });
export const ANGLE_DEFS = [
  {
    id: 'tronco', group: 'tronco', side: 'C', label: 'Tronco',
    help: 'Inclinación del tronco respecto a la vertical (cadera→hombros).',
    needs: [L.shL, L.shR, L.hipL, L.hipR],
    fn: (p) => angleBetween(sub(mid(p[L.shL], p[L.shR]), mid(p[L.hipL], p[L.hipR])), UP),
    alts: ['L', 'R'].map((s) => {
      const k = side(s);
      return { needs: [k.sh, k.hip], fn: (p) => angleBetween(sub(p[k.sh], p[k.hip]), UP) };
    }),
  },
  {
    id: 'cuello', group: 'cuello', side: 'C', label: 'Cuello',
    help: 'Flexión aproximada del cuello: eje hombros→orejas respecto al eje del tronco.',
    needs: [L.shL, L.shR, L.hipL, L.hipR, L.earL, L.earR],
    fn: (p) => {
      const sh = mid(p[L.shL], p[L.shR]);
      return angleBetween(sub(mid(p[L.earL], p[L.earR]), sh), sub(sh, mid(p[L.hipL], p[L.hipR])));
    },
    alts: [
      // Una sola oreja visible, con el eje del tronco completo.
      ...['L', 'R'].map((s) => ({
        needs: [L.shL, L.shR, L.hipL, L.hipR, side(s).ear],
        fn: (p) => {
          const sh = mid(p[L.shL], p[L.shR]);
          return angleBetween(sub(p[side(s).ear], sh), sub(sh, mid(p[L.hipL], p[L.hipR])));
        },
      })),
      // Solo un lado: oreja, hombro y cadera del mismo lado.
      ...['L', 'R'].map((s) => {
        const k = side(s);
        return { needs: [k.sh, k.hip, k.ear], fn: (p) => angleBetween(sub(p[k.ear], p[k.sh]), sub(p[k.sh], p[k.hip])) };
      }),
    ],
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
        // Eje del tronco con el hombro y la cadera del mismo lado o, si no, con la cadera del otro lado.
        alts: [k('hip'), L[`hip${s === 'L' ? 'R' : 'L'}`]].map((hip) => ({
          needs: [k('sh'), k('el'), hip],
          fn: (p) => angleBetween(sub(p[k('el')], p[k('sh')]), sub(p[hip], p[k('sh')])),
        })),
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
        // Eje del tronco con el hombro del otro lado (de perfil, casi paralelo).
        alts: [{
          needs: [L[`sh${s === 'L' ? 'R' : 'L'}`], k('hip'), k('kn')],
          fn: (p) => flex(angleBetween(sub(p[L[`sh${s === 'L' ? 'R' : 'L'}`]], p[k('hip')]), sub(p[k('kn')], p[k('hip')]))),
        }],
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

/** Primera variante del ángulo (principal o alternativa) cuyos puntos son todos utilizables. */
function pickVariant(def, frame, exclude) {
  const usable = (i) => frame.lm[i][3] >= VISIBILITY_THRESHOLD && !exclude?.has(i);
  return [def, ...(def.alts || [])].find((v) => v.needs.every(usable)) || null;
}

/** Todos los puntos de los que puede depender un ángulo (principal y alternativas). */
export const allNeeds = (def) => [...new Set([def, ...(def.alts || [])].flatMap((v) => v.needs))];

/**
 * Ángulos de un fotograma: { id: valor|null }.
 * `exclude` (Map o Set de índices): puntos que no se deben usar aunque sean visibles.
 * Si se pasa `used`, se rellena con los puntos que ha usado cada ángulo.
 */
export function anglesForFrame(frame, mode, width, height, exclude = null, used = null) {
  const out = {};
  const pts = pointsFor(frame, mode, width, height);
  for (const def of ANGLE_DEFS) {
    if (!pts) { out[def.id] = null; continue; }
    const variant = pickVariant(def, frame, exclude);
    const v = variant ? variant.fn(pts) : null;
    out[def.id] = v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10;
    if (used) used[def.id] = out[def.id] == null ? null : variant.needs;
  }
  return out;
}

/** Media móvil centrada que respeta los huecos (null). */
export function smooth(series, window) {
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
 * Con `filtros`, devuelve también la serie sin filtrar (`raw`), los recuentos por razón (`quality`)
 * y qué valores son huecos rellenados por interpolación (`interp`).
 * `exclude`: por fotograma, Set de puntos que no se deben usar (los que rechaza Argon en los escenarios C y D).
 * `used`: si se pasa un array, se rellena por fotograma con los puntos que ha usado cada ángulo.
 */
export function computeSeries(frames, {
  mode = '2d', width, height, smoothWindow = 1, filtros = false, exclude = null, used = null,
} = {}) {
  const times = frames.map((f) => f.t);
  const base = frames.map((f, i) => anglesForFrame(f, mode, width, height, exclude?.[i]));
  // Los filtros de puntos trabajan sobre lo que queda tras `exclude`.
  const visibleFrames = exclude
    ? frames.map((f, i) => (exclude[i]?.size && f.lm
      ? { ...f, lm: f.lm.map((p, k) => (exclude[i].has(k) ? [p[0], p[1], p[2], 0] : p)) } : f))
    : frames;
  const invalid = filtros ? invalidPoints(visibleFrames, width, height) : null;
  const merged = invalid
    ? frames.map((f, i) => new Map([...[...(exclude?.[i] || [])].map((k) => [k, 'argon']), ...(invalid[i] || [])]))
    : exclude;
  const clean = frames.map((f, i) => {
    if (!invalid && !used) return base[i];
    const u = used ? {} : null;
    const a = anglesForFrame(f, mode, width, height, merged?.[i], u);
    if (used) used[i] = u;
    return a;
  });
  const series = {}, raw = {}, quality = {}, interp = {};
  for (const def of ANGLE_DEFS) {
    const q = Object.fromEntries(Object.keys(RAZONES).map((k) => [k, 0]));
    const b = base.map((a) => a[def.id]);
    let vals = clean.map((a, i) => {
      const v = a[def.id];
      if (b[i] == null) { if (frames[i].lm) q.visibilidad++; return null; }
      if (v == null && invalid) {
        const why = allNeeds(def).map((k) => invalid[i]?.get(k)).find(Boolean);
        if (why) q[why]++;
      }
      return v;
    });
    if (filtros) vals = filterSeries(vals, times, def.group, q);
    interp[def.id] = vals.map((v, i) => v != null && clean[i][def.id] == null);
    series[def.id] = smooth(vals, smoothWindow);
    raw[def.id] = smooth(b, smoothWindow);
    quality[def.id] = q;
  }
  return { times, series, raw: filtros ? raw : null, quality, interp };
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
