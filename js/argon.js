// Escenarios B y C con Gemini 4 Argon.
//
//  B · Argon solo: el modelo ve el vídeo, marca las articulaciones en cada fotograma que muestrea
//      (puntos 2D) y estima los ángulos 3D, más el contexto. Los ángulos 2D de B los calcula
//      nuestro código a partir de esos puntos, igual que en A; los puntos se dibujan sobre el vídeo.
//      Sirve para ver qué percibe Argon: no es fiable para medir.
//  C · Argon revisor: el modelo ve un vídeo con el original y el esqueleto de MediaPipe en bruto
//      lado a lado, y señala por articulación y tramo dónde está mal colocado o no se ve. No da
//      coordenadas ni ángulos: la corrección la hace nuestro código (quita esos puntos y rellena
//      solo los huecos cortos de la serie de MediaPipe).

import { ANGLE_DEFS, computeSeries, smooth } from './angles.js';
import { GEMINI } from './config.js';
import { videoPart, interact } from './gemini.js';

const IDS = ANGLE_DEFS.map((d) => d.id);
const num = { type: 'number' };
const numOrNull = { type: ['number', 'null'] };
const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const arr = (items) => ({ type: 'array', items });
const tramo = (extra = {}) => obj({ inicio: num, fin: num, ...extra });

const CONTEXTO = obj({
  tarea: { type: 'string', description: 'Qué hace el trabajador, en una frase.' },
  fases: arr(tramo({ descripcion: str })),
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

// Puntos que se piden a Argon y su índice en MediaPipe Pose (izquierda = del trabajador).
export const PUNTOS = {
  oreja_izq: 7, oreja_dch: 8, hombro_izq: 11, hombro_dch: 12, codo_izq: 13, codo_dch: 14,
  muneca_izq: 15, muneca_dch: 16, cadera_izq: 23, cadera_dch: 24,
  rodilla_izq: 25, rodilla_dch: 26, tobillo_izq: 27, tobillo_dch: 28,
};
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

export const VEREDICTOS = {
  mal_colocada: 'Mal colocada',
  no_visible: 'No visible',
};

const SCHEMA_C = obj({
  resumen: str,
  revisiones: arr(obj({
    articulacion: { type: 'string', enum: Object.keys(PUNTOS) },
    inicio: num,
    fin: num,
    veredicto: { type: 'string', enum: Object.keys(VEREDICTOS) },
    motivo: str,
  })),
  contexto: CONTEXTO,
});

const DEFINICIONES = ANGLE_DEFS.map((d) => `- ${d.id}: ${d.label}. ${d.help}`).join('\n');

const REGLAS = `Convenciones:
- Grados, sin signo; 0 = postura neutra (de pie, brazos colgando, tronco vertical).
- Izquierda y derecha son las del trabajador, no las de la cámara.
- Los tiempos (t, inicio, fin) van en segundos desde el inicio del vídeo, con decimales.
- Si hay varias personas, analiza solo al trabajador principal.
- No inventes: si una articulación no se ve y no puedes deducirla con seguridad, usa null.

Contexto que debes aportar: la tarea, sus fases, si manipula una carga (y su peso aproximado si se puede estimar),
el agarre, los tramos con torsión o inclinación lateral del tronco, el apoyo de las piernas y cualquier
observación útil para una evaluación ergonómica (REBA, RULA, OWAS).`;

/** Escenario B: Argon estima los ángulos a partir del vídeo. */
export async function runB({ file, duration, fps, thinking, signal, onStatus }) {
  const video = await videoPart(file, { fps, signal, onStatus });
  onStatus?.('Gemini 4 Argon está analizando el vídeo…');
  const prompt = `Eres especialista en biomecánica y ergonomía laboral. Analiza el vídeo del trabajador.
Da una muestra por cada fotograma que recibes (uno cada ${(1 / fps).toFixed(2)} s, desde 0 hasta ${duration.toFixed(1)} s),
con su tiempo exacto en t. En cada muestra:

1. puntos: dónde está cada articulación EN ESE FOTOGRAMA, como [y, x] normalizados a 0-1000
   (y = 0 arriba, x = 0 a la izquierda de la imagen). Señala el centro de la articulación.
   Si la articulación está tapada o fuera de la imagen y no puedes situarla con seguridad, usa null.
   No la deduzcas de la postura típica: los puntos sirven para comprobar qué ves realmente.
2. Ángulos articulares anatómicos reales en 3D (no su proyección en la imagen):
${DEFINICIONES}

${REGLAS}
- confianza: alta si las articulaciones se ven bien; baja si hay oclusiones, mala luz o encuadre parcial.
- oclusiones: tramos en que alguna articulación no se ve, con el motivo.`;
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
  const prompt = `Eres especialista en biomecánica y ergonomía laboral, y revisas la calidad de un sistema de visión artificial.

El vídeo (${duration.toFixed(1)} s) muestra cada instante dos veces, lado a lado:
- IZQUIERDA: el fotograma original, sin nada encima.
- DERECHA: el mismo fotograma con el esqueleto que ha estimado MediaPipe Pose, y el tiempo en segundos
  impreso arriba a la izquierda. Usa ese tiempo para inicio y fin.
- Colores del esqueleto: AZUL = lado izquierdo del trabajador; NARANJA = lado derecho del trabajador;
  blanco = tronco (línea entre hombros y entre caderas). Los círculos blancos son las articulaciones.
  Solo se dibujan las articulaciones que MediaPipe considera visibles.
- Izquierda y derecha son las del trabajador, no las de la cámara (si está de espaldas, su izquierda está
  a la izquierda de la imagen).

Tu tarea: comparar las dos mitades y decir dónde el esqueleto NO corresponde al cuerpo real. Revisa estas
articulaciones: ${Object.keys(PUNTOS).join(', ')}.

Para cada problema, da un tramo (inicio, fin) por articulación con uno de estos veredictos:
- mal_colocada: el esqueleto pone la articulación claramente fuera de su sitio real (más de media longitud
  del segmento contiguo), la confunde con la del otro lado, la coloca sobre un objeto o dibuja una postura
  que no es la que se ve (por ejemplo, rodillas dobladas cuando está de pie con las piernas rectas).
- no_visible: el esqueleto dibuja una articulación que en la imagen original está tapada (por el propio
  cuerpo, una máquina o un objeto) o fuera del encuadre, de modo que su posición es una suposición.

Reglas:
- Informa solo de los problemas. Lo que no menciones se da por correcto.
- Sé exigente pero no exagerado: desviaciones de unos pocos píxeles no son un problema.
- Agrupa los fotogramas consecutivos con el mismo problema en un solo tramo.
- No calcules ángulos ni des coordenadas: solo juzga la colocación.
- Si hay varias personas, revisa solo el esqueleto del trabajador principal.
- En resumen, describe en dos o tres frases la calidad general del esqueleto y sus fallos típicos.

Contexto que debes aportar además: la tarea, sus fases, si manipula una carga (y su peso aproximado si se
puede estimar), el agarre, los tramos con torsión o inclinación lateral del tronco, el apoyo de las piernas
y cualquier observación útil para una evaluación ergonómica (REBA, RULA, OWAS).`;
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

/**
 * Puntos rechazados por Argon en cada fotograma: Map índice MediaPipe → veredicto.
 * Cada tramo se amplía medio intervalo de muestreo por cada lado (Argon solo ve `fps` fotogramas por segundo).
 */
export function rejectedPoints(result, frames) {
  const h = 0.5 / result.fps;
  const out = frames.map(() => new Map());
  for (const r of result.json.revisiones || []) {
    const idx = PUNTOS[r.articulacion];
    if (idx == null || !Number.isFinite(r.inicio) || !Number.isFinite(r.fin)) continue;
    frames.forEach((f, i) => { if (f.t >= r.inicio - h && f.t <= r.fin + h) out[i].set(idx, r.veredicto); });
  }
  return out;
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

/**
 * Vista del escenario C: la serie de MediaPipe en bruto sin los puntos que rechaza Argon y con los
 * huecos cortos rellenados. `cambios` cuenta por ángulo los fotogramas descartados y rellenados;
 * `bandas` da, por grupo de gráfica, los tramos en que Argon ha rechazado algún punto.
 */
export function viewC(result, frames, { mode, width, height, smoothWindow = 1 }) {
  const rejected = rejectedPoints(result, frames);
  const hide = (pts, bad) => pts && pts.map((p, k) => (bad.has(k) ? [p[0], p[1], p[2], 0] : p));
  const corrected = frames.map((f, i) => (rejected[i].size
    ? { ...f, lm: hide(f.lm, rejected[i]), wlm: hide(f.wlm, rejected[i]) } : f));
  const opts = { mode, width, height, smoothWindow: 1, filtros: false };
  const raw = computeSeries(frames, opts).series;
  const fixed = computeSeries(corrected, opts);
  const { times } = fixed;
  const series = {}, cambios = {};
  for (const def of ANGLE_DEFS) {
    const v = fixed.series[def.id];
    const descartados = v.filter((x, i) => x == null && raw[def.id][i] != null).length;
    const rellenados = fillGaps(v, times, GEMINI.huecoMaximoC_s);
    series[def.id] = smooth(v, smoothWindow);
    cambios[def.id] = { descartados, rellenados };
  }
  const bandas = {};
  for (const r of result.json.revisiones || []) {
    const idx = PUNTOS[r.articulacion];
    for (const def of ANGLE_DEFS) {
      if (!def.needs.includes(idx)) continue;
      (bandas[def.group] ||= []).push([r.inicio, r.fin]);
    }
  }
  return { times, series, rejected, cambios, bandas };
}
