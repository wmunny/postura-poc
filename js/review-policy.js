// Política de decisión sobre la revisión de Gemini 4 Argon (escenarios C y D).
//
// Argon informa de hechos (qué articulación, en qué tramo, qué le pasa y por qué); este módulo decide
// qué se hace con cada punto. Lo aprendido en las pruebas:
//   - Ocultaciones LARGAS (un brazo tapado varios segundos): MediaPipe se inventa el punto → se borra.
//   - Ocultaciones CORTAS (el lado lejano durante un giro): MediaPipe lo estima bien → se conserva como
//     aproximado, salvo que las reglas mecánicas detecten un fallo en ese fotograma.
//   - «Mal colocada» → se borra siempre.
//   - «Lado invertido» → solo se intercambian izquierda y derecha si la profundidad 3D de MediaPipe lo
//     confirma; si no, el tramo queda «en disputa» y no se toca (Argon también se equivoca de lado).
//   - Varias ejecuciones → solo se aplica lo que coincide en la mayoría (consenso).
//
// Acciones por fotograma y punto: 'borrar' | 'aproximada' | 'intercambiar' | 'disputa'.

import { POLITICA } from './config.js';
import { invalidPoints } from './filters.js';

// Articulaciones que revisa Argon y su índice en MediaPipe Pose (izquierda = del trabajador).
export const PUNTOS = {
  oreja_izq: 7, oreja_dch: 8, hombro_izq: 11, hombro_dch: 12, codo_izq: 13, codo_dch: 14,
  muneca_izq: 15, muneca_dch: 16, cadera_izq: 23, cadera_dch: 24,
  rodilla_izq: 25, rodilla_dch: 26, tobillo_izq: 27, tobillo_dch: 28,
};

export const ACCIONES = {
  borrar: 'Se quita',
  aproximada: 'Se conserva como aproximada',
  intercambiar: 'Se intercambian izquierda y derecha',
  disputa: 'En disputa: se conserva sin cambios',
};

// En MediaPipe, los pares izquierda/derecha de estas articulaciones son índices consecutivos (impar = izq.).
const partner = (i) => (i % 2 ? i + 1 : i - 1);
const isUpper = (i) => i <= 16;

/** Une los tramos consecutivos de la misma articulación y veredicto (separados como mucho por una muestra). */
function mergeTramos(revisiones, fps) {
  const gap = 1 / fps + 1e-6;
  const groups = new Map();
  for (const r of revisiones || []) {
    if (PUNTOS[r.articulacion] == null || !Number.isFinite(r.inicio) || !Number.isFinite(r.fin)) continue;
    const k = `${r.articulacion}|${r.veredicto}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...r, fin: Math.max(r.inicio, r.fin) });
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.inicio - b.inicio);
    let cur = null;
    for (const r of list) {
      if (cur && r.inicio - cur.fin <= gap) {
        cur.fin = Math.max(cur.fin, r.fin);
        cur.partes.push(r);
      } else {
        if (cur) out.push(cur);
        cur = { ...r, partes: [r] };
      }
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => a.inicio - b.inicio);
}

/**
 * ¿Confirma la profundidad 3D de MediaPipe una inversión de lados?
 * Argon dice qué lado real del trabajador está más cerca de la cámara (`lado_cercano`). Si MediaPipe
 * pone más cerca el punto que etiqueta con ese mismo lado, sus etiquetas son coherentes y no hay inversión.
 */
function depthCheck(frames, ids, idx, ladoCercano) {
  if (ladoCercano !== 'izq' && ladoCercano !== 'dch') return { ok: false, porque: 'Argon no indica qué lado está más cerca de la cámara' };
  const [L, R] = isUpper(idx) ? [11, 12] : [23, 24];
  let zl = 0, zr = 0, n = 0;
  for (const i of ids) {
    const w = frames[i].wlm;
    if (!w) continue;
    zl += w[L][2]; zr += w[R][2]; n++;
  }
  if (!n) return { ok: false, porque: 'sin datos 3D en el tramo' };
  const dz = (zl - zr) / n;
  if (Math.abs(dz) < POLITICA.profundidadMinima_m) {
    return { ok: false, porque: `la profundidad 3D no distingue qué lado está más cerca (${Math.abs(dz * 100).toFixed(0)} cm)` };
  }
  const cercaMP = dz < 0 ? 'izq' : 'dch'; // en MediaPipe, z menor = más cerca de la cámara
  return cercaMP === ladoCercano
    ? { ok: false, porque: 'la profundidad 3D de MediaPipe contradice la inversión' }
    : { ok: true, porque: 'confirmada por la profundidad 3D de MediaPipe' };
}

/**
 * Aplica la política a una ejecución de Argon. Sin `permitirIntercambio` (una sola ejecución), una
 * inversión confirmada por la profundidad queda en disputa: Argon también se equivoca de lado.
 * @returns {{actions: Array<Map<number,string>>, decisiones: Array}} acciones por fotograma y, por tramo,
 *          la decisión tomada y por qué.
 */
export function decideRun(result, frames, { width, height, permitirIntercambio = true }) {
  const fps = result.fps;
  const h = 0.5 / fps;
  const invalid = invalidPoints(frames, width, height);
  const actions = frames.map(() => new Map());
  const decisiones = [];
  for (const r of mergeTramos(result.json.revisiones, fps)) {
    const idx = PUNTOS[r.articulacion];
    const ids = frames.map((f, i) => (f.t >= r.inicio - h && f.t <= r.fin + h ? i : null)).filter((i) => i != null);
    const dur = r.fin - r.inicio; // duración según Argon (un tramo de una sola muestra dura 0 s)
    let accion, porque;
    if (r.veredicto === 'mal_colocada') {
      accion = 'borrar'; porque = 'mal colocada';
    } else if (r.veredicto === 'aproximada') {
      accion = 'aproximada'; porque = 'Argon la da por aproximada';
    } else if (r.veredicto === 'no_visible') {
      if (dur <= POLITICA.ocultacionCorta_s) {
        accion = 'aproximada';
        porque = `ocultación corta (${dur.toFixed(1)} s): se conserva salvo donde las reglas detectan un fallo`;
      } else {
        accion = 'borrar'; porque = `ocultación larga (${dur.toFixed(1)} s)`;
      }
    } else if (r.veredicto === 'lado_invertido') {
      const chk = depthCheck(frames, ids, idx, r.lado_cercano);
      if (chk.ok && !permitirIntercambio) {
        accion = 'disputa'; porque = `${chk.porque}, pero con una sola ejecución no se intercambia: usa el consenso`;
      } else {
        accion = chk.ok ? 'intercambiar' : 'disputa'; porque = chk.porque;
      }
    } else {
      continue;
    }
    for (const i of ids) {
      // En las ocultaciones cortas, un fallo de las reglas en ese fotograma hace que se quite.
      const a = accion === 'aproximada' && r.veredicto === 'no_visible' && invalid[i]?.has(idx) ? 'borrar' : accion;
      // Si dos tramos se solapan, gana la acción más conservadora.
      const prev = actions[i].get(idx);
      if (!prev || RANK[a] > RANK[prev]) actions[i].set(idx, a);
    }
    decisiones.push({ ...r, accion, porque, duracion: dur });
  }
  return { actions, decisiones };
}
const RANK = { disputa: 0, aproximada: 1, intercambiar: 2, borrar: 3 };

/**
 * Consenso entre ejecuciones: en cada fotograma y punto se aplica la acción más votada si la apoya
 * la mayoría de las ejecuciones (1 de 1, 2 de 2, 2 de 3).
 * `acuerdo`: de los puntos señalados por alguna ejecución, % en que todas coinciden.
 */
export function consensus(runs, nFrames) {
  const n = runs.length;
  if (n === 1) return { actions: runs[0], acuerdo: null };
  const need = Math.floor(n / 2) + 1;
  const actions = [];
  let flagged = 0, unanimous = 0;
  for (let i = 0; i < nFrames; i++) {
    const out = new Map();
    const keys = new Set(runs.flatMap((r) => [...r[i].keys()]));
    for (const k of keys) {
      const votes = runs.map((r) => r[i].get(k)).filter(Boolean);
      const count = {};
      for (const v of votes) count[v] = (count[v] || 0) + 1;
      const [best, c] = Object.entries(count).sort((a, b) => b[1] - a[1] || RANK[b[0]] - RANK[a[0]])[0];
      if (c >= need) out.set(k, best);
      flagged++;
      if (c === n) unanimous++;
    }
    actions.push(out);
  }
  return { actions, acuerdo: flagged ? (100 * unanimous) / flagged : 100 };
}

/**
 * Aplica las acciones a los fotogramas: intercambia los pares señalados y devuelve, por fotograma,
 * el conjunto de puntos que hay que excluir.
 */
export function applyActions(frames, actions) {
  const swap = (pts, pairs) => {
    if (!pts) return pts;
    const p = pts.slice();
    for (const [a, b] of pairs) [p[a], p[b]] = [p[b], p[a]];
    return p;
  };
  const out = frames.map((f, i) => {
    const pairs = [...new Set([...actions[i]].filter(([, a]) => a === 'intercambiar')
      .map(([k]) => Math.min(k, partner(k))))].map((k) => [k, k + 1]);
    return pairs.length ? { ...f, lm: swap(f.lm, pairs), wlm: swap(f.wlm, pairs) } : f;
  });
  const exclude = actions.map((m) => new Set([...m].filter(([, a]) => a === 'borrar').map(([k]) => k)));
  return { frames: out, exclude };
}
