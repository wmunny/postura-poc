// Escenarios B y C con Gemini 4 Argon.
//
//  B · Argon solo: el modelo ve el vídeo, marca las articulaciones en cada fotograma que muestrea
//      (puntos 2D) y estima los ángulos 3D, más el contexto. Los ángulos 2D de B los calcula
//      nuestro código a partir de esos puntos, igual que en A; los puntos se dibujan sobre el vídeo.
//  C · Mixto: el modelo ve el vídeo y la serie densa de MediaPipe (escenario A). No la recalcula:
//      marca los tramos implausibles o dudosos, propone valores corregidos y aporta contexto.
//
// En ambos casos el resultado se remuestrea sobre los mismos instantes que la serie de A.

import { ANGLE_DEFS, computeSeries } from './angles.js';
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

const SCHEMA_C = obj({
  resumen: str,
  revisiones: arr(obj({
    articulacion: { type: 'string', enum: IDS },
    inicio: num,
    fin: num,
    veredicto: { type: 'string', enum: ['implausible', 'dudoso'] },
    motivo: str,
    valores: arr(obj({ t: num, v: numOrNull })),
  })),
  oclusiones: OCLUSIONES,
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

/** Escenario C: Argon revisa la serie de MediaPipe con el vídeo delante. */
export async function runC({ file, duration, fps, thinking, base, mode, signal, onStatus }) {
  const video = await videoPart(file, { fps, signal, onStatus });
  onStatus?.('Gemini 4 Argon está revisando la serie de MediaPipe…');
  // Serie de A reducida a ~5 muestras por segundo para que quepa holgada en el contexto.
  const { times, series } = base;
  const dt = times.length > 1 ? times[1] - times[0] : 1 / 15;
  const step = Math.max(1, Math.round(0.2 / dt));
  const rows = [];
  for (let i = 0; i < times.length; i += step) {
    rows.push([times[i].toFixed(2), ...IDS.map((id) => (series[id][i] == null ? '' : Math.round(series[id][i])))].join(','));
  }
  const modo = mode === '3d'
    ? 'ángulos 3D estimados por MediaPipe (coordenadas world)'
    : 'ángulos 2D en el plano de la imagen (proyección, como mediría un técnico sobre el vídeo)';
  const prompt = `Eres especialista en biomecánica y ergonomía laboral. Te paso un vídeo de ${duration.toFixed(1)} s y la serie
de ángulos que ha calculado MediaPipe Pose (visión artificial con una sola cámara), ya filtrada contra valores atípicos.
Son ${modo}. Una celda vacía significa que MediaPipe no dio un valor fiable.

Tu tarea es REVISAR la serie, no recalcularla entera:
1. Compara la serie con lo que ves en el vídeo y detecta los tramos en que algún ángulo es implausible
   (extremidad tapada que MediaPipe se inventa, confusión entre izquierda y derecha, postura imposible, salto
   sin movimiento real) o dudoso.
2. Para cada tramo implausible, da valores corregidos cada 0,5 s en la misma convención (${mode.toUpperCase()}),
   o null si tú tampoco puedes estimarlos. En los dudosos, da valores solo si estás razonablemente seguro.
3. Incluye solo los tramos con problemas. Si la serie es correcta, devuelve "revisiones" vacía.
4. Señala también los tramos en que hay oclusiones.

Ángulos:
${DEFINICIONES}

${REGLAS}

Serie de MediaPipe (CSV):
t,${IDS.join(',')}
${rows.join('\n')}`;
  const t0 = performance.now();
  const { json, usage } = await interact({
    model: GEMINI.modelo, input: [{ type: 'text', text: prompt }, video],
    schema: SCHEMA_C, thinking, maxTokens: GEMINI.maxTokensSalida, signal,
  });
  return { json, usage, segundos: (performance.now() - t0) / 1000, fps, thinking, mode };
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

/** Vista del escenario C: la serie de A con las correcciones de Argon aplicadas. */
export function viewC(result, base) {
  const { times } = base;
  const series = Object.fromEntries(IDS.map((id) => [id, base.series[id].slice()]));
  const cambios = Object.fromEntries(IDS.map((id) => [id, { corregidos: 0, descartados: 0, dudosos: 0 }]));
  for (const r of result.json.revisiones) {
    if (!series[r.articulacion]) continue;
    const s = series[r.articulacion], c = cambios[r.articulacion];
    const fixed = r.valores?.length ? resample(r.valores, times, 1.5) : null;
    times.forEach((t, i) => {
      if (t < r.inicio || t > r.fin) return;
      if (r.veredicto === 'dudoso' && !fixed) { if (s[i] != null) c.dudosos++; return; }
      const v = fixed ? fixed[i] : null;
      if (v == null) { if (s[i] != null) c.descartados++; } else c.corregidos++;
      s[i] = v;
    });
  }
  return { times, series, cambios };
}
