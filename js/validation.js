// Validación estadística del vídeo: ¿lo que se ve es representativo del total?
//
// No basta con el porcentaje de fotogramas visibles: lo que falta no falta al azar (un brazo se oculta
// precisamente en ciertas posturas) y los fotogramas seguidos no son observaciones independientes.
// Por ángulo se hacen cinco comprobaciones:
//   1. cobertura  — fotogramas con valor tras la limpieza.
//   2. fases      — cobertura en cada fase de la tarea (las de Argon, o 5 tramos iguales si no hay),
//                   ponderada por el riesgo de la fase: perder una fase de riesgo alto es rojo; medio, ámbar.
//   3. muestra    — observaciones independientes efectivas (tiempo de decorrelación) y margen de error
//                   del % de tiempo en postura de riesgo, como en el muestreo del trabajo (work sampling).
//                   Mide la DURACIÓN del vídeo, no si se ve: se informa aparte y solo cuenta para OWAS.
//   4. extremos   — peor y mejor caso: % de tiempo en postura de riesgo si todo lo que no se ve
//                   estuviera, o no, en esa postura. ¿Cambia la conclusión?
//   5. pico       — ¿puede estar oculta la postura más exigente en un hueco largo?
// La muñeca no se mide: la estima Argon por categorías y fases (escenario C). Su comprobación es si
// hay categoría, con confianza suficiente, en cada fase (y sobre todo en las de riesgo alto).
// Dos perspectivas: «tiempo» (1, 2 y 4, métodos por proporción de tiempo como OWAS, más la duración)
// y «pico» (1, 2 y 5, métodos que puntúan la peor postura como REBA y RULA). Los umbrales están en config.js (VALIDACION)
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

const RIESGO = { bajo: 0, medio: 1, alto: 2 };

/**
 * Fases sobre las que se comprueba la cobertura: las de Argon o, si no hay, 5 tramos iguales.
 * Las de Argon se ordenan, se extienden para cubrir todo el vídeo sin huecos (Argon deja medio intervalo
 * de muestreo entre fases) y las de menos de `faseMinima_s` se unen a la vecina con el riesgo mayor.
 */
export function phasesFor(argonPhases, duration) {
  const ok = (argonPhases || [])
    .filter((f) => Number.isFinite(f.inicio) && Number.isFinite(f.fin) && f.fin > f.inicio)
    .map((f) => ({ inicio: f.inicio, fin: f.fin, descripcion: f.descripcion, riesgo: f.riesgo, deArgon: true }))
    .sort((a, b) => a.inicio - b.inicio);
  if (ok.length) {
    ok[0].inicio = 0;
    ok.forEach((f, k) => { f.fin = k + 1 < ok.length ? ok[k + 1].inicio : Math.max(f.fin, duration); });
    const merged = [];
    for (const f of ok) {
      const prev = merged[merged.length - 1];
      if (prev && (f.fin - f.inicio < V.faseMinima_s || prev.fin - prev.inicio < V.faseMinima_s)) {
        prev.fin = f.fin;
        prev.descripcion = `${prev.descripcion} + ${f.descripcion}`;
        if ((RIESGO[f.riesgo] ?? -1) > (RIESGO[prev.riesgo] ?? -1)) prev.riesgo = f.riesgo;
      } else {
        merged.push({ ...f });
      }
    }
    return merged.filter((f) => f.fin > f.inicio);
  }
  const n = 5;
  return Array.from({ length: n }, (_, k) => ({
    inicio: (duration * k) / n, fin: (duration * (k + 1)) / n, descripcion: `Tramo ${k + 1} de ${n}`, deArgon: false,
  }));
}

/** Nivel de una fase según su cobertura y su riesgo (sin riesgo, el criterio general de cobertura). */
function phaseLevel(riesgo, cov) {
  if (cov >= V.coberturaFase[0]) return 'verde';
  if (riesgo === 'alto') return 'rojo';
  if (riesgo === 'medio') return 'ambar';
  if (riesgo === 'bajo') return cov >= V.coberturaFase[1] ? 'verde' : 'ambar';
  return level(cov, V.coberturaFase);
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

  // 2. Cobertura por fase, ponderada por el riesgo de la fase
  r.fases = phases.map((f) => {
    const idx = times.map((t, i) => (t >= f.inicio && t < f.fin ? i : null)).filter((i) => i != null);
    const cov = idx.length ? (100 * idx.filter((i) => values[i] != null).length) / idx.length : 100;
    return { ...f, cobertura: cov, nivel: phaseLevel(f.riesgo, cov) };
  });
  r.minFase = Math.min(...r.fases.map((f) => f.cobertura));
  r.c2 = worst(...r.fases.map((f) => f.nivel));

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
      const t0 = times[i], t1 = times[Math.min(e, N - 1)];
      const fase = r.fases.find((f) => f.riesgo === 'alto' && Math.min(t1, f.fin) - Math.max(t0, f.inicio) >= V.solapeCritico_s);
      if (dur > V.huecoPico_s && (edge.some((c) => c >= maxCat) || fase)) {
        r.huecosPico.push({ inicio: times[i], fin: times[Math.min(e, N - 1)], critica: !!fase });
      }
      i = e;
    }
  }
  r.c5 = maxCat < 0 ? 'rojo' : r.huecosPico.some((h) => h.critica) ? 'rojo' : r.huecosPico.length ? 'ambar' : 'verde';

  r.tiempo = worst(r.c1, r.c2, r.c4);
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
  // Duración: observaciones independientes en los ángulos de OWAS (el peor margen manda).
  const owas = V.metodos.find((m) => m.perspectiva === 'tiempo');
  const conMuestra = (owas?.angulos || []).map((id) => angulos[id]).filter((a) => a.c3);
  const duracion = conMuestra.length ? {
    nivel: worst(...conMuestra.map((a) => a.c3)),
    margen: Math.max(...conMuestra.map((a) => a.margen)),
    observaciones: Math.min(...conMuestra.map((a) => a.nEfectiva)),
    duracionNecesaria: Math.max(...conMuestra.map((a) => a.duracionNecesaria)),
  } : null;
  // Extremidad superior por lados: hombro, codo y muñeca del mismo lado; se evalúa el que mejor se ve.
  const lados = ['L', 'R'].map((s) => {
    const ang = worst(angulos[`hombro_${s}`].pico, angulos[`codo_${s}`].pico);
    const mun = wrists ? wrists[s].nivel : null;
    return { lado: s, ang, mun, nivel: worst(ang, mun) };
  });
  const rank = (x) => NIVELES.indexOf(x.nivel) * 3 + NIVELES.indexOf(x.ang);
  const mejorLado = lados.slice().sort((a, b) => rank(a) - rank(b))[0];
  const metodos = V.metodos.map((m) => {
    let nivelAngulos = worst(...m.angulos.map((id) => angulos[id][m.perspectiva]));
    let nivelMuneca = null, ladoEvaluado = null;
    if (m.extremidadSuperior === 'mejor') {
      nivelAngulos = worst(nivelAngulos, mejorLado.ang);
      nivelMuneca = mejorLado.mun;
      ladoEvaluado = mejorLado.lado;
    }
    const nivelDuracion = m.perspectiva === 'tiempo' ? duracion?.nivel ?? null : null;
    return { ...m, nivelAngulos, nivelMuneca, nivelDuracion, ladoEvaluado, nivel: worst(nivelAngulos, nivelMuneca, nivelDuracion) };
  });

  // Qué falta y cómo arreglarlo
  const consejos = [];
  for (const reg of regiones) {
    if (reg.pico === 'verde' && reg.tiempo === 'verde') continue;
    const msgs = [];
    for (const a of reg.detalle) {
      if (a.c1 !== 'verde') msgs.push(`${a.label}: solo se ve en el ${a.cobertura.toFixed(0)} % del vídeo.`);
      const perdidas = a.fases.filter((f) => f.nivel !== 'verde');
      if (perdidas.length) {
        msgs.push(`${a.label}: casi no se ve en ${perdidas.map((f) => `«${f.descripcion}» (${fmtS(f.inicio)}–${fmtS(f.fin)}, ${f.cobertura.toFixed(0)} %${f.riesgo ? `, riesgo ${f.riesgo}` : ''})`).join('; ')}.`);
      }
      if (a.c4 && a.c4 !== 'verde') {
        msgs.push(`${a.label}: según lo que no se ve, el tiempo en postura de riesgo estaría entre el ${a.extremos[0].toFixed(0)} % y el ${a.extremos[1].toFixed(0)} %.`);
      }
      for (const h of a.huecosPico || []) {
        msgs.push(`${a.label}: el hueco de ${fmtS(h.inicio)}–${fmtS(h.fin)} ${h.critica ? 'cae en una fase de riesgo alto' : 'empieza o acaba en la postura más exigente observada'}; el pico podría estar oculto.`);
      }
    }
    if (msgs.length) consejos.push({ region: reg.label, nivel: worst(reg.pico, reg.tiempo), mensajes: msgs, grabacion: reg.consejo });
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
  if (duracion && duracion.nivel !== 'verde') {
    consejos.push({
      region: 'Duración (solo OWAS)', nivel: duracion.nivel,
      mensajes: [`El vídeo equivale a unas ${Math.max(1, Math.round(duracion.observaciones))} observaciones independientes: el % de tiempo en postura de riesgo tiene un margen de ±${duracion.margen.toFixed(0)} puntos. OWAS pide al menos ${V.observacionesOWAS} observaciones (error del ${V.margenObjetivo} %) y suele requerir 20–40 min de observación.`],
      grabacion: `Graba varios ciclos completos de la tarea: unos ${Math.ceil(duracion.duracionNecesaria / 60)} min como mínimo para un margen de ±${V.margenObjetivo} puntos.`,
    });
  }
  return { fuente, angulos, regiones, metodos, munecas: wrists, duracion, consejos, fases: phases, fasesDeArgon: phases.some((f) => f.deArgon) };
}
