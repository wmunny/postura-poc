// Escenarios B y C con Gemini 4 Argon.
//
//  B · Argon solo: el modelo ve el vídeo, marca las articulaciones en cada fotograma que muestrea
//      (puntos 2D) y estima los ángulos 3D, más el contexto. Los ángulos 2D de B los calcula
//      nuestro código a partir de esos puntos, igual que en A; los puntos se dibujan sobre el vídeo.
//      Sirve para ver qué percibe Argon: no es fiable para medir.
//  C · Argon revisor: el modelo ve un vídeo con el original y el esqueleto de MediaPipe en bruto
//      lado a lado, y señala por articulación y tramo dónde está mal colocado, no se ve o está
//      solo aproximado. No da coordenadas ni ángulos: la corrección la hace nuestro código (quita
//      los puntos rechazados, conserva marcados los aproximados y rellena solo los huecos cortos).
//      También estima la muñeca por categorías (fase y lado): MediaPipe no la mide con fiabilidad.
//  D · Reglas + Argon: la misma revisión de Argon y, después, los filtros mecánicos (js/filters.js).

import { ANGLE_DEFS, computeSeries, smooth, allNeeds } from './angles.js';
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

// mal_colocada y no_visible quitan el punto; aproximada lo conserva marcado como de menor precisión.
export const VEREDICTOS = {
  mal_colocada: 'Mal colocada',
  no_visible: 'No visible',
  aproximada: 'Aproximada',
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
- aproximada: la articulación no está exactamente en su sitio (o se ve solo en parte), pero la postura que
  dibuja el esqueleto es la que se ve: por ejemplo, el brazo está por encima del hombro y el esqueleto también
  lo pone por encima, aunque el hombro esté algo desplazado. Úsalo cuando el dato sirva para saber la
  categoría de la postura (REBA, RULA, OWAS) aunque no para medir los grados con precisión.
  Prefiere aproximada a mal_colocada cuando la postura general sea correcta.

Reglas:
- Informa solo de los problemas. Lo que no menciones se da por correcto.
- Sé exigente pero no exagerado: desviaciones de unos pocos píxeles no son un problema.
- Agrupa los fotogramas consecutivos con el mismo problema en un solo tramo.
- No calcules ángulos ni des coordenadas: solo juzga la colocación.
- Si hay varias personas, revisa solo el esqueleto del trabajador principal.
- En resumen, describe en dos o tres frases la calidad general del esqueleto y sus fallos típicos.
- En las fases de la tarea, indica el riesgo ergonómico de cada una (alto, medio o bajo).

Muñecas (en «munecas»): MediaPipe no mide bien la muñeca, así que la estimas tú mirando la imagen ORIGINAL
(mitad izquierda). Da una entrada por cada fase de la tarea (mismos inicio y fin que en «fases») y por cada lado
(izq y dch, del trabajador), con la postura más exigente de la muñeca en esa fase:
- flexion: neutra (mano alineada con el antebrazo), hasta_15 (flexión o extensión de hasta unos 15°),
  mas_15 (más de 15°) o no_visible (la mano está tapada, fuera del encuadre o demasiado pequeña para juzgarla).
- desviada: si la mano se desvía hacia el pulgar o hacia el meñique (desviación radial o cubital).
- girada: si la muñeca está girada cerca del final de su recorrido (pronación o supinación extrema).
- confianza: alta si la mano se ve bien; media si se ve en parte; baja si apenas se distingue.
- motivo: qué ves, en una frase (por ejemplo, «sujeta la gaveta con la muñeca extendida»).
No deduzcas: si no ves la mano, usa no_visible y «no_se_sabe». Es una estimación por categorías, no una medida.

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
 * Escenarios C y D: la serie de MediaPipe sin los puntos que rechaza Argon (los «aproximados» se
 * conservan marcados) y con los huecos de hasta 1 s rellenados. Con `reglas` (D), además se aplican
 * los filtros mecánicos después de la revisión de Argon.
 *  - cambios: por ángulo, valores en bruto descartados y fotogramas rellenados.
 *  - interp / aprox: por ángulo, qué valores son interpolados o vienen de un punto aproximado.
 *  - bandas: por grupo de gráfica, tramos [inicio, fin, 'rechazo' | 'aprox'].
 */
function cleanWithArgon(result, frames, { mode, width, height, smoothWindow = 1, reglas = false }) {
  const marks = rejectedPoints(result, frames);
  const exclude = marks.map((m) => new Set([...m].filter(([, v]) => v !== 'aproximada').map(([k]) => k)));
  const opts = { mode, width, height, smoothWindow: 1 };
  const raw = computeSeries(frames, opts).series;
  const used = [];
  const fixed = computeSeries(frames, { ...opts, filtros: reglas, exclude, used });
  const { times } = fixed;
  const series = {}, cambios = {}, interp = {}, aprox = {};
  for (const def of ANGLE_DEFS) {
    const v = fixed.series[def.id];
    const descartados = v.filter((x, i) => x == null && raw[def.id][i] != null).length;
    const empty = v.map((x) => x == null);
    const rellenados = fillGaps(v, times, GEMINI.huecoMaximoC_s);
    interp[def.id] = v.map((x, i) => x != null && (empty[i] || fixed.interp[def.id][i]));
    aprox[def.id] = v.map((x, i) => x != null && !interp[def.id][i]
      && (used[i]?.[def.id] || []).some((k) => marks[i].get(k) === 'aproximada'));
    series[def.id] = smooth(v, smoothWindow);
    cambios[def.id] = { descartados, rellenados, aproximados: aprox[def.id].filter(Boolean).length };
  }
  const bandas = {};
  for (const r of result.json.revisiones || []) {
    const idx = PUNTOS[r.articulacion];
    const groups = new Set(ANGLE_DEFS.filter((d) => allNeeds(d).includes(idx)).map((d) => d.group));
    for (const g of groups) (bandas[g] ||= []).push([r.inicio, r.fin, r.veredicto === 'aproximada' ? 'aprox' : 'rechazo']);
  }
  return { times, series, rejected: marks, cambios, interp, aprox, bandas };
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
  for (const m of result?.json.munecas || []) {
    const c = CAT[m.flexion];
    if (c == null || !Number.isFinite(m.inicio) || !Number.isFinite(m.fin)) continue;
    const s = out[m.lado === 'izq' ? 'L' : 'R'];
    times.forEach((t, i) => { if (t >= m.inicio && t < m.fin && (s[i] == null || c > s[i])) s[i] = c; });
  }
  return out;
}
