// Escenarios B y C con Gemini 4 Argon.
//
//  B · Argon solo: el modelo ve el vídeo, marca las articulaciones en cada fotograma que muestrea
//      (puntos 2D) y estima los ángulos 3D, más el contexto. Los ángulos 2D de B los calcula
//      nuestro código a partir de esos puntos, igual que en A; los puntos se dibujan sobre el vídeo.
//      Sirve para ver qué percibe Argon: no es fiable para medir.
//  C · Argon revisor: el modelo ve un vídeo con el original y el esqueleto de MediaPipe en bruto
//      lado a lado, y señala por articulación y tramo dónde está mal colocado, no se ve, está solo
//      aproximado o tiene los lados invertidos, con la prueba que lo apoya. No da coordenadas ni
//      ángulos: qué se hace con cada punto lo decide la política de js/review-policy.js.
//      También estima la muñeca por categorías (fase y lado): MediaPipe no la mide con fiabilidad.
//  D · Reglas + Argon: la misma revisión de Argon y, después, los filtros mecánicos (js/filters.js).

import { ANGLE_DEFS, computeSeries, smooth, allNeeds } from './angles.js';
import { GEMINI, POLITICA } from './config.js';
import { videoPart, interact } from './gemini.js';
import { PUNTOS, decideRun, consensus, applyActions } from './review-policy.js';

export { PUNTOS };

/**
 * Instrucciones de Argon: están en prompts/*.md para poder revisarlas y ajustarlas sin tocar el código.
 * Los comentarios HTML del archivo no se envían; {{CLAVE}} se sustituye por `vars.CLAVE`.
 */
async function loadPrompt(name, vars) {
  const res = await fetch(new URL(`../prompts/${name}.md`, import.meta.url), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`No se han podido cargar las instrucciones de Argon (prompts/${name}.md).`);
  const text = (await res.text()).replace(/<!--[\s\S]*?-->/g, '').trim();
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

const IDS = ANGLE_DEFS.map((d) => d.id);
const num = { type: 'number' };
const numOrNull = { type: ['number', 'null'] };
const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const arr = (items) => ({ type: 'array', items });
const tramo = (extra = {}) => obj({ inicio: num, fin: num, ...extra });

const CONTEXTO = obj({
  tarea: { type: 'string', description: 'Qué hace el trabajador, en una frase.' },
  fases: arr(tramo({ descripcion: str, riesgo: { type: 'string', enum: ['alto', 'medio', 'bajo'] } })),
  carga: obj({ manipula: { type: 'boolean' }, descripcion: str, peso_estimado_kg: numOrNull }),
  agarre: { type: 'string', enum: ['bueno', 'regular', 'malo', 'inaceptable', 'no_aplica'] },
  torsion_tronco: arr(tramo({ grados_aprox: numOrNull })),
  inclinacion_lateral_tronco: arr(tramo({ grados_aprox: numOrNull })),
  piernas: {
    type: 'string',
    enum: ['bipedestacion_estable', 'apoyo_unipodal_o_inestable', 'sentado', 'arrodillado_o_en_cuclillas', 'caminando', 'variable'],
  },
  observaciones: str,
});
const OCLUSIONES = arr(tramo({ articulaciones: arr({ type: 'string', enum: IDS }), motivo: str }));

// [y, x] normalizados a 0–1000, la convención nativa de Gemini para señalar puntos.
const punto = { type: ['array', 'null'], items: { type: 'integer' }, minItems: 2, maxItems: 2 };

const SCHEMA_B = obj({
  resumen: str,
  muestras: arr(obj({
    t: num,
    puntos: obj(Object.fromEntries(Object.keys(PUNTOS).map((k) => [k, punto]))),
    ...Object.fromEntries(IDS.map((id) => [id, numOrNull])),
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
  })),
  oclusiones: OCLUSIONES,
  contexto: CONTEXTO,
});

// Lo que dice Argon. Qué se hace con cada veredicto lo decide js/review-policy.js.
export const VEREDICTOS = {
  mal_colocada: 'Mal colocada',
  no_visible: 'No visible',
  aproximada: 'Aproximada',
  lado_invertido: 'Lado invertido',
};

// Muñeca por categorías, como la usan REBA y RULA. Estimación visual, no medida.
export const MUNECA_FLEXION = {
  neutra: 'Neutra',
  hasta_15: 'Hasta 15°',
  mas_15: 'Más de 15°',
  no_visible: 'No visible',
};
export const SI_NO = { si: 'Sí', no: 'No', no_se_sabe: 'No se sabe' };
const siNo = { type: 'string', enum: Object.keys(SI_NO) };

const SCHEMA_C = obj({
  resumen: str,
  revisiones: arr(obj({
    articulacion: { type: 'string', enum: Object.keys(PUNTOS) },
    inicio: num,
    fin: num,
    veredicto: { type: 'string', enum: Object.keys(VEREDICTOS) },
    motivo: str,
    evidencia: str,
    lado_cercano: { type: 'string', enum: ['izq', 'dch', 'no_se_sabe'] },
  })),
  munecas: arr(obj({
    inicio: num,
    fin: num,
    lado: { type: 'string', enum: ['izq', 'dch'] },
    flexion: { type: 'string', enum: Object.keys(MUNECA_FLEXION) },
    desviada: siNo,
    girada: siNo,
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
    motivo: str,
  })),
  contexto: CONTEXTO,
});

const DEFINICIONES = ANGLE_DEFS.map((d) => `- ${d.id}: ${d.label}. ${d.help}`).join('\n');

/** Escenario B: Argon estima los ángulos a partir del vídeo. */
export async function runB({ file, duration, fps, thinking, signal, onStatus }) {
  const video = await videoPart(file, { fps, signal, onStatus });
  onStatus?.('Gemini 4 Argon está analizando el vídeo…');
  const prompt = await loadPrompt('argon-solo', {
    INTERVALO: (1 / fps).toFixed(2), DURACION: duration.toFixed(1), DEFINICIONES,
  });
  const t0 = performance.now();
  const { json, usage } = await interact({
    model: GEMINI.modelo, input: [{ type: 'text', text: prompt }, video],
    schema: SCHEMA_B, thinking, maxTokens: GEMINI.maxTokensSalida, signal,
  });
  return { json, usage, segundos: (performance.now() - t0) / 1000, fps, thinking };
}

/**
 * Escenario C: Argon revisa el vídeo con el esqueleto de MediaPipe lado a lado (`file`, generado
 * por overlay-video.js) y devuelve los tramos en que alguna articulación está mal colocada o no se ve.
 */
export async function runC({ file, duration, fps, thinking, signal, onStatus }) {
  const video = await videoPart(file, { fps, signal, onStatus });
  onStatus?.('Gemini 4 Argon está revisando el esqueleto de MediaPipe…');
  const prompt = await loadPrompt('argon-revisor', {
    DURACION: duration.toFixed(1), ARTICULACIONES: Object.keys(PUNTOS).join(', '),
  });
  const t0 = performance.now();
  const { json, usage } = await interact({
    model: GEMINI.modelo, input: [{ type: 'text', text: prompt }, video],
    schema: SCHEMA_C, thinking, maxTokens: GEMINI.maxTokensSalida, signal,
  });
  return { json, usage, segundos: (performance.now() - t0) / 1000, fps, thinking };
}

/** Interpola puntos {t, v} (dispersos) sobre `times`; null si el hueco supera `maxGap`. */
function resample(points, times, maxGap) {
  const p = points.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  if (!p.length) return times.map(() => null);
  let j = 0;
  return times.map((t) => {
    while (j + 1 < p.length && p[j + 1].t <= t) j++;
    const a = p[j], b = p[j + 1];
    if (a.t <= t && b && a.v != null && b.v != null && b.t - a.t <= maxGap) {
      return Math.round((a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)) * 10) / 10;
    }
    // Sin pareja para interpolar: vale la muestra más cercana si está cerca y no es null.
    const near = [a, b].filter(Boolean).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0];
    return near.v != null && Math.abs(near.t - t) <= maxGap / 2 ? near.v : null;
  });
}

/** Fotogramas de Argon con el formato de MediaPipe: { t, lm: 33 × [x, y, 0, visibilidad] }. */
export function argonFrames(result) {
  return (result.json.muestras || [])
    .filter((m) => Number.isFinite(m.t))
    .sort((a, b) => a.t - b.t)
    .map((m) => {
      const lm = Array.from({ length: 33 }, () => [0, 0, 0, 0]);
      for (const [k, i] of Object.entries(PUNTOS)) {
        const p = m.puntos?.[k];
        if (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) lm[i] = [p[1] / 1000, p[0] / 1000, 0, 1];
      }
      return { t: m.t, lm };
    });
}

/** Pose de Argon más cercana a `t` (solo si está a menos de medio intervalo de muestreo). */
export function argonPoseAt(frames, fps, t) {
  let best = null;
  for (const f of frames) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best && Math.abs(best.t - t) <= 0.5 / fps + 1e-6 ? best : null;
}

/**
 * Vista del escenario B sobre los instantes de A.
 * En 2D, los ángulos se calculan con nuestro código a partir de los puntos de Argon;
 * en 3D, son los ángulos anatómicos que estima Argon.
 */
export function viewB(result, times, { mode, width, height }) {
  const maxGap = 2.5 / result.fps;
  const series = {};
  if (mode === '2d') {
    const frames = argonFrames(result);
    const s = computeSeries(frames, { mode: '2d', width, height }).series;
    for (const id of IDS) series[id] = resample(frames.map((f, i) => ({ t: f.t, v: s[id][i] })), times, maxGap);
  } else {
    for (const id of IDS) series[id] = resample(result.json.muestras.map((m) => ({ t: m.t, v: m[id] })), times, maxGap);
  }
  return { times, series };
}

/** Rellena por interpolación lineal los huecos de hasta `maxGap` segundos. Devuelve cuántos ha rellenado. */
function fillGaps(v, times, maxGap) {
  let filled = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i] != null || v[i - 1] == null) continue;
    let e = i;
    while (e < v.length && v[e] == null) e++;
    const a = i - 1;
    if (e < v.length && times[e] - times[a] <= maxGap + 1e-6) {
      for (let k = i; k < e; k++) {
        v[k] = Math.round((v[a] + ((v[e] - v[a]) * (times[k] - times[a])) / (times[e] - times[a])) * 10) / 10;
        filled++;
      }
    }
    i = e;
  }
  return filled;
}

const GROUP_POINTS = ANGLE_DEFS.reduce((acc, d) => {
  (acc[d.group] ||= new Set());
  for (const k of allNeeds(d)) acc[d.group].add(k);
  return acc;
}, {});
const BAND_KIND = { borrar: 'rechazo', intercambiar: 'cambio', aproximada: 'aprox', disputa: 'aprox' };
const BAND_RANK = { aprox: 0, cambio: 1, rechazo: 2 };

/** Tramos [inicio, fin, tipo] de cada grupo de gráfica en que la política ha actuado sobre algún punto. */
function bandsFrom(actions, times) {
  const out = {};
  for (const [g, pts] of Object.entries(GROUP_POINTS)) {
    const kinds = actions.map((m) => {
      let k = null;
      for (const [p, a] of m) if (pts.has(p) && (!k || BAND_RANK[BAND_KIND[a]] > BAND_RANK[k])) k = BAND_KIND[a];
      return k;
    });
    const list = [];
    for (let i = 0; i < kinds.length;) {
      if (!kinds[i]) { i++; continue; }
      let e = i;
      while (e + 1 < kinds.length && kinds[e + 1] === kinds[i]) e++;
      list.push([times[i], times[e], kinds[i]]);
      i = e + 1;
    }
    if (list.length) out[g] = list;
  }
  return out;
}

/**
 * Escenarios C y D. `review`: { runs: [respuestas de Argon], fps }. Por cada ejecución se aplica la
 * política (review-policy.js), se combinan por consenso y se limpia la serie de MediaPipe en bruto:
 * se quitan los puntos borrados, se intercambian los lados confirmados, se marcan los aproximados y
 * se rellenan los huecos de hasta 1 s. Con `reglas` (D), además se aplican los filtros mecánicos.
 *  - cambios: por ángulo, valores en bruto descartados, rellenados, aproximados e intercambiados.
 *  - interp / aprox: por ángulo, qué valores son interpolados o vienen de un punto aproximado.
 *  - rejected: por fotograma, Map punto → acción (para dibujarlo sobre el vídeo).
 *  - bandas: por grupo de gráfica, tramos [inicio, fin, 'rechazo' | 'cambio' | 'aprox'].
 *  - revision: decisiones de la primera ejecución, número de ejecuciones y acuerdo entre ellas.
 */
function cleanWithArgon(review, frames, { mode, width, height, smoothWindow = 1, reglas = false }) {
  const runs = review.runs || [review];
  const permitirIntercambio = runs.length >= POLITICA.ejecucionesParaIntercambiar;
  const per = runs.map((r) => decideRun({ ...r, fps: r.fps ?? review.fps }, frames, { width, height, permitirIntercambio }));
  const { actions, acuerdo } = consensus(per.map((p) => p.actions), frames.length);
  const { frames: fixedFrames, exclude } = applyActions(frames, actions);
  const opts = { mode, width, height, smoothWindow: 1 };
  const raw = computeSeries(frames, opts).series;
  const used = [];
  const fixed = computeSeries(fixedFrames, { ...opts, filtros: reglas, exclude, used });
  const { times } = fixed;
  const series = {}, cambios = {}, interp = {}, aprox = {};
  for (const def of ANGLE_DEFS) {
    const v = fixed.series[def.id];
    const descartados = v.filter((x, i) => x == null && raw[def.id][i] != null).length;
    const empty = v.map((x) => x == null);
    const rellenados = fillGaps(v, times, GEMINI.huecoMaximoC_s);
    interp[def.id] = v.map((x, i) => x != null && (empty[i] || fixed.interp[def.id][i]));
    const acts = (i) => (used[i]?.[def.id] || []).map((k) => actions[i].get(k));
    aprox[def.id] = v.map((x, i) => x != null && !interp[def.id][i] && acts(i).some((a) => a === 'aproximada' || a === 'disputa'));
    const intercambiados = v.filter((x, i) => x != null && acts(i).includes('intercambiar')).length;
    series[def.id] = smooth(v, smoothWindow);
    cambios[def.id] = { descartados, rellenados, aproximados: aprox[def.id].filter(Boolean).length, intercambiados };
  }
  return {
    times, series, rejected: actions, cambios, interp, aprox, bandas: bandsFrom(actions, times),
    revision: { decisiones: per[0].decisiones, ejecuciones: runs.length, acuerdo, porEjecucion: per.map((p) => p.decisiones) },
  };
}

/** Escenario C: solo la revisión de Argon. */
export const viewC = (result, frames, opts) => cleanWithArgon(result, frames, { ...opts, reglas: false });

/** Escenario D: revisión de Argon y, después, los filtros mecánicos. */
export const viewD = (result, frames, opts) => cleanWithArgon(result, frames, { ...opts, reglas: true });

/**
 * Muñecas de Argon como serie sobre `times`: por lado, categoría 0 (neutra), 1 (hasta 15°),
 * 2 (más de 15°) o null (no visible o sin dato). Si se solapan tramos, se queda la más exigente.
 */
export function wristSeries(result, times) {
  const CAT = { neutra: 0, hasta_15: 1, mas_15: 2 };
  const out = { L: times.map(() => null), R: times.map(() => null) };
  const end = times.length ? times[times.length - 1] + 1 : 0;
  for (const lado of ['izq', 'dch']) {
    // Argon da tramos por fase con huecos de media muestra entre ellos: cada tramo se extiende hasta
    // el siguiente (y el primero desde 0) para que la categoría cubra todo el vídeo.
    const list = (result?.json.munecas || [])
      .filter((m) => m.lado === lado && Number.isFinite(m.inicio) && Number.isFinite(m.fin))
      .sort((a, b) => a.inicio - b.inicio);
    const s = out[lado === 'izq' ? 'L' : 'R'];
    list.forEach((m, k) => {
      const c = CAT[m.flexion];
      if (c == null) return;
      const a = k === 0 ? 0 : m.inicio;
      const b = k + 1 < list.length ? Math.max(m.fin, list[k + 1].inicio) : end;
      times.forEach((t, i) => { if (t >= a && t < b && (s[i] == null || c > s[i])) s[i] = c; });
    });
  }
  return out;
}
