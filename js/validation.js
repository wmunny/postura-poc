// Validación estadística del vídeo: ¿lo que se ve es representativo del total?
//
// No basta con el porcentaje de fotogramas visibles: lo que falta no falta al azar (un brazo se oculta
// precisamente en ciertas posturas) y los fotogramas seguidos no son observaciones independientes.
// Por ángulo se hacen cinco comprobaciones:
//   1. cobertura  — fotogramas con valor tras la limpieza.
//   2. fases      — cobertura en cada fase de la tarea (las de Argon, o 5 tramos iguales si no hay).
//   3. muestra    — observaciones independientes efectivas (tiempo de decorrelación) y margen de error
//                   del % de tiempo en postura de riesgo, como en el muestreo del trabajo (work sampling).
//   4. extremos   — peor y mejor caso: % de tiempo en postura de riesgo si todo lo que no se ve
//                   estuviera, o no, en esa postura. ¿Cambia la conclusión?
//   5. pico       — ¿puede estar oculta la postura más exigente en un hueco largo?
// La muñeca no se mide: la estima Argon por categorías y fases (escenario C). Su comprobación es si
// hay categoría, con confianza suficiente, en cada fase (y sobre todo en las de riesgo alto).
// Dos perspectivas: «tiempo» (1-4, métodos por proporción de tiempo como OWAS) y «pico» (1, 2 y 5,
// métodos que puntúan la peor postura como REBA y RULA). Los umbrales están en config.js (VALIDACION)
// y son convenciones iniciales que hay que calibrar con un ergónomo.

import { VALIDACION as V } from './config.js';
import { ANGLE_DEFS } from './angles.js';

export const NIVELES = ['verde', 'ambar', 'rojo'];
const worst = (...vs) => NIVELES[Math.max(0, ...vs.filter(Boolean).map((v) => NIVELES.indexOf(v)))];
const level = (x, [g, a], higherIsBetter = true) => (higherIsBetter
  ? (x >= g ? 'verde' : x >= a ? 'ambar' : 'rojo')
  : (x <= g ? 'verde' : x <= a ? 'ambar' : 'rojo'));

const DEF = Object.fromEntries(ANGLE_DEFS.map((d) => [d.id, d]));

/** Categoría de postura (0 = neutra) según los umbrales de REBA. El codo es neutro entre 60° y 100°. */
export function category(group, v) {
  const c = V.categorias[group];
  if (!c || v == null) return null;
  if (group === 'codo') return v < c[0] || v > c[1] ? 1 : 0;
  return c.filter((u) => v > u).length;
}
const topCategory = (group) => (group === 'codo' ? 1 : V.categorias[group]?.length ?? null);

/** Tiempo de decorrelación (s): primer desfase en que la autocorrelación baja de 1/e. */
function decorrelationTime(values, dt) {
  const idx = values.map((v, i) => (v == null ? null : i)).filter((i) => i != null);
  if (idx.length < 10) return null;
  const mean = idx.reduce((a, i) => a + values[i], 0) / idx.length;
  const varc = idx.reduce((a, i) => a + (values[i] - mean) ** 2, 0) / idx.length;
  if (varc < 1e-6) return dt; // serie constante: cada fotograma aporta lo mismo
  const maxLag = Math.min(values.length - 1, Math.round(V.decorrelacionMaxima_s / dt));
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0, n = 0;
    for (let i = 0; i + lag < values.length; i++) {
      if (values[i] == null || values[i + lag] == null) continue;
      s += (values[i] - mean) * (values[i + lag] - mean); n++;
    }
    if (n < 5) break;
    if (s / n / varc < 1 / Math.E) return lag * dt;
  }
  return maxLag * dt;
}

/** Fases sobre las que se comprueba la cobertura: las de Argon o, si no hay, 5 tramos iguales. */
export function phasesFor(argonPhases, duration) {
  const ok = (argonPhases || []).filter((f) => Number.isFinite(f.inicio) && Number.isFinite(f.fin) && f.fin > f.inicio);
  if (ok.length) return ok.map((f) => ({ inicio: f.inicio, fin: f.fin, descripcion: f.descripcion, riesgo: f.riesgo, deArgon: true }));
  const n = 5;
  return Array.from({ length: n }, (_, k) => ({
    inicio: (duration * k) / n, fin: (duration * (k + 1)) / n, descripcion: `Tramo ${k + 1} de ${n}`, deArgon: false,
  }));
}

function checkAngle(id, values, times, phases, aprox) {
  const def = DEF[id];
  const N = values.length;
  const dt = N > 1 ? (times[N - 1] - times[0]) / (N - 1) : 1 / 15;
  const valid = values.filter((v) => v != null).length;
  const r = { id, label: def.label, group: def.group };

  // 1. Cobertura
  r.cobertura = N ? (100 * valid) / N : 0;
  r.aproximados = aprox ? (100 * aprox.filter(Boolean).length) / Math.max(1, valid) : 0;
  r.c1 = level(r.cobertura, V.cobertura);

  // 2. Cobertura por fase
  r.fases = phases.map((f) => {
    const idx = times.map((t, i) => (t >= f.inicio && t < f.fin ? i : null)).filter((i) => i != null);
    const cov = idx.length ? (100 * idx.filter((i) => values[i] != null).length) / idx.length : 100;
    return { ...f, cobertura: cov };
  });
  const minFase = Math.min(...r.fases.map((f) => f.cobertura));
  const criticaPerdida = r.fases.some((f) => f.riesgo === 'alto' && f.cobertura < V.coberturaFase[0]);
  r.c2 = criticaPerdida ? 'rojo' : level(minFase, V.coberturaFase);
  r.minFase = minFase;

  const top = topCategory(def.group);
  if (top == null) { // sin categorías (cadera): solo cobertura
    r.tiempo = worst(r.c1, r.c2);
    r.pico = r.tiempo;
    return r;
  }

  // 3. Muestra efectiva y margen de error del % de tiempo en postura de riesgo
  const desde = V.riesgoDesde[def.group];
  const cats = values.map((v) => category(def.group, v));
  const enRiesgo = cats.filter((c) => c != null && c >= desde).length;
  const p = valid ? enRiesgo / valid : 0;
  const tau = decorrelationTime(values, dt) ?? dt;
  r.tau = tau;
  r.nEfectiva = Math.max(1, (valid * dt) / (2 * tau));
  const pp = Math.min(0.9, Math.max(0.1, p));
  r.margen = 100 * V.z * Math.sqrt((pp * (1 - pp)) / r.nEfectiva);
  const nNecesaria = (V.z ** 2 * pp * (1 - pp)) / (V.margenObjetivo / 100) ** 2;
  r.duracionNecesaria = (nNecesaria * 2 * tau) / Math.max(0.05, r.cobertura / 100);
  r.c3 = level(r.margen, V.margen, false);

  // 4. Peor y mejor caso del % de tiempo en postura de riesgo
  r.pRiesgo = valid ? 100 * p : null;
  r.extremos = [(100 * enRiesgo) / N, (100 * (enRiesgo + (N - valid))) / N];
  const band = (x) => V.bandasExposicion.filter((u) => x >= u).length;
  const d = band(r.extremos[1]) - band(r.extremos[0]);
  r.c4 = d === 0 ? 'verde' : d === 1 ? 'ambar' : 'rojo';

  // 5. ¿Puede estar oculto el pico? Huecos largos que empiezan o acaban en la postura más exigente vista.
  const maxCat = Math.max(-1, ...cats.filter((c) => c != null));
  r.categoriaMax = maxCat;
  r.huecosPico = [];
  if (maxCat >= 0 && maxCat < top) {
    for (let i = 0; i < N;) {
      if (values[i] != null) { i++; continue; }
      let e = i;
      while (e < N && values[e] == null) e++;
      const dur = (e - i) * dt;
      const edge = [cats[i - 1], cats[e]].filter((c) => c != null);
      const fase = r.fases.find((f) => f.riesgo === 'alto' && times[i] < f.fin && times[Math.min(e, N - 1)] > f.inicio);
      if (dur > V.huecoPico_s && (edge.some((c) => c >= maxCat) || fase)) {
        r.huecosPico.push({ inicio: times[i], fin: times[Math.min(e, N - 1)], critica: !!fase });
      }
      i = e;
    }
  }
  r.c5 = maxCat < 0 ? 'rojo' : r.huecosPico.some((h) => h.critica) ? 'rojo' : r.huecosPico.length ? 'ambar' : 'verde';

  r.tiempo = worst(r.c1, r.c2, r.c3, r.c4);
  r.pico = worst(r.c1, r.c2, r.c5);
  return r;
}

const fmtS = (t) => `${t.toFixed(1)} s`;
const best = (...vs) => NIVELES[Math.min(...vs.map((v) => NIVELES.indexOf(v)))];
const MUNECA_CAT = { neutra: 0, hasta_15: 1, mas_15: 2 };

/**
 * Muñeca de un lado: en cada fase, la entrada de Argon que más se solapa con ella.
 * Rojo si falta en una fase de riesgo alto; ámbar si falta en otra fase o solo hay confianza baja.
 */
function checkWrist(entries, lado, phases) {
  const mine = entries.filter((m) => m.lado === lado && Number.isFinite(m.inicio) && Number.isFinite(m.fin));
  const fases = phases.map((f) => {
    const ov = (m) => Math.max(0, Math.min(f.fin, m.fin) - Math.max(f.inicio, m.inicio));
    const m = mine.reduce((b, x) => (ov(x) > (b ? ov(b) : 0) ? x : b), null);
    const visible = m && MUNECA_CAT[m.flexion] != null;
    const nivel = visible && m.confianza !== 'baja' ? 'verde' : f.riesgo === 'alto' ? 'rojo' : 'ambar';
    return { ...f, flexion: m?.flexion ?? null, confianza: m?.confianza ?? null, nivel };
  });
  const vistas = fases.filter((f) => MUNECA_CAT[f.flexion] != null);
  return {
    lado,
    nivel: worst(...fases.map((f) => f.nivel)),
    fases,
    categoriaMax: vistas.length ? Math.max(...vistas.map((f) => MUNECA_CAT[f.flexion])) : null,
  };
}

/**
 * Valida el vídeo con una serie ya limpiada.
 * `munecas`: entradas de Argon (escenario C) o null si no se ha ejecutado.
 * @param {{times:number[], series:Object, aprox?:Object, phases:Array, fuente:string, munecas?:Array}} input
 */
export function validateVideo({ times, series, aprox = {}, phases, fuente, munecas = null }) {
  const angulos = Object.fromEntries(ANGLE_DEFS.map((d) => [d.id, checkAngle(d.id, series[d.id], times, phases, aprox[d.id])]));
  const regiones = V.regiones.map((reg) => {
    const a = reg.angulos.map((id) => angulos[id]);
    return { ...reg, tiempo: worst(...a.map((x) => x.tiempo)), pico: worst(...a.map((x) => x.pico)), detalle: a };
  });
  const wrists = munecas ? { L: checkWrist(munecas, 'izq', phases), R: checkWrist(munecas, 'dch', phases) } : null;
  const metodos = V.metodos.map((m) => {
    const nivelAngulos = worst(...m.angulos.map((id) => angulos[id][m.perspectiva]));
    let nivelMuneca = null;
    if (m.muneca && wrists) {
      nivelMuneca = m.muneca === 'una' ? best(wrists.L.nivel, wrists.R.nivel) : worst(wrists.L.nivel, wrists.R.nivel);
    }
    return { ...m, nivelAngulos, nivelMuneca, nivel: worst(nivelAngulos, nivelMuneca) };
  });

  // Qué falta y cómo arreglarlo
  const consejos = [];
  for (const reg of regiones) {
    if (reg.pico === 'verde' && reg.tiempo === 'verde') continue;
    const msgs = [];
    for (const a of reg.detalle) {
      if (a.c1 !== 'verde') msgs.push(`${a.label}: solo se ve en el ${a.cobertura.toFixed(0)} % del vídeo.`);
      const perdidas = a.fases.filter((f) => f.cobertura < V.coberturaFase[0]);
      if (perdidas.length) {
        msgs.push(`${a.label}: casi no se ve en ${perdidas.map((f) => `«${f.descripcion}» (${fmtS(f.inicio)}–${fmtS(f.fin)}, ${f.cobertura.toFixed(0)} %${f.riesgo === 'alto' ? ', fase de riesgo alto' : ''})`).join('; ')}.`);
      }
      if (a.c4 && a.c4 !== 'verde') {
        msgs.push(`${a.label}: según lo que no se ve, el tiempo en postura de riesgo estaría entre el ${a.extremos[0].toFixed(0)} % y el ${a.extremos[1].toFixed(0)} %.`);
      }
      for (const h of a.huecosPico || []) {
        msgs.push(`${a.label}: el hueco de ${fmtS(h.inicio)}–${fmtS(h.fin)} ${h.critica ? 'cae en una fase de riesgo alto' : 'empieza o acaba en la postura más exigente observada'}; el pico podría estar oculto.`);
      }
    }
    const short = reg.detalle.filter((a) => a.c3 && a.c3 !== 'verde');
    if (short.length) {
      const need = Math.max(...short.map((a) => a.duracionNecesaria));
      msgs.push(`El % de tiempo en postura de riesgo tiene un margen de ±${Math.max(...short.map((a) => a.margen)).toFixed(0)} puntos. Para ±${V.margenObjetivo} haría falta grabar unos ${Math.ceil(need)} s (varios ciclos de la tarea).`);
    }
    consejos.push({ region: reg.label, nivel: worst(reg.pico, reg.tiempo), mensajes: msgs, grabacion: reg.consejo });
  }
  if (wrists) {
    const msgs = [];
    for (const w of [wrists.L, wrists.R]) {
      const lado = w.lado === 'izq' ? 'izquierda' : 'derecha';
      const faltan = w.fases.filter((f) => f.nivel !== 'verde');
      if (faltan.length) {
        msgs.push(`Muñeca ${lado}: sin categoría fiable en ${faltan.map((f) => `«${f.descripcion}» (${fmtS(f.inicio)}–${fmtS(f.fin)}${f.flexion === 'no_visible' || !f.flexion ? ', no visible' : ', confianza baja'}${f.riesgo === 'alto' ? ', fase de riesgo alto' : ''})`).join('; ')}.`);
      }
    }
    if (msgs.length) {
      consejos.push({
        region: 'Muñecas (estimación de Argon)', nivel: worst(wrists.L.nivel, wrists.R.nivel), mensajes: msgs,
        grabacion: 'Acerca la cámara o graba en mayor resolución para que las manos se vean grandes, sin la carga ni el cuerpo delante.',
      });
    }
  }
  return { fuente, angulos, regiones, metodos, munecas: wrists, consejos, fasesDeArgon: phases.some((f) => f.deArgon) };
}
