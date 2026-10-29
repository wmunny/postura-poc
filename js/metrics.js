// Métricas para comparar la serie en bruto con sus versiones limpiadas (filtros mecánicos, Argon y
// ambos). Miden estabilidad y coherencia, no exactitud: para eso hace falta una referencia medida a mano.

import { FILTROS } from './config.js';

const median = (arr) => {
  const v = arr.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Métricas de una serie de ángulos (sin suavizar). `interp` marca los valores rellenados.
 *  - fluctuacion: cambio medio entre fotogramas consecutivos medidos (sin interpolados ni saltos
 *    sobre huecos), en grados por segundo.
 *  - saltos: cambios entre fotogramas medidos más rápidos que la velocidad máxima plausible.
 *  - fueraRango: valores fuera del rango fisiológico.
 *  - cobertura: porcentaje de fotogramas con valor (incluidos los interpolados).
 *  - tramos / tramoMediano: fragmentación, número de tramos continuos y duración mediana (s).
 *  - suma / pares: para promediar la fluctuación de varias series ponderando por medidas (pooledFluctuation).
 */
export function seriesMetrics(values, times, group, interp = null) {
  const vmax = FILTROS.velocidadMaxima[group] ?? 400;
  const [lo, hi] = FILTROS.rango[group] ?? [0, 180];
  const dt = median(times.slice(1).map((t, i) => t - times[i])) || 1 / 15;
  const measured = (i) => values[i] != null && !interp?.[i];
  let sum = 0, pairs = 0, saltos = 0, fueraRango = 0, n = 0;
  const runs = [];
  let start = null;
  values.forEach((v, i) => {
    if (v == null) {
      if (start != null) { runs.push(times[i - 1] - times[start] + dt); start = null; }
      return;
    }
    if (start == null) start = i;
    n++;
    if (v < lo || v > hi) fueraRango++;
    if (i > 0 && measured(i) && measured(i - 1) && times[i] - times[i - 1] <= 1.5 * dt) {
      const speed = Math.abs(v - values[i - 1]) / Math.max(times[i] - times[i - 1], 1e-6);
      sum += speed; pairs++;
      if (speed > vmax) saltos++;
    }
  });
  if (start != null) runs.push(times[times.length - 1] - times[start] + dt);
  return {
    fluctuacion: pairs ? sum / pairs : null,
    saltos,
    fueraRango,
    cobertura: values.length ? (100 * n) / values.length : 0,
    tramos: runs.length,
    tramoMediano: median(runs),
    suma: sum,
    pares: pairs,
  };
}

/** Fluctuación conjunta de varias series: total de cambios entre total de pares medidos. */
export function pooledFluctuation(metrics) {
  const pares = metrics.reduce((a, m) => a + m.pares, 0);
  return pares ? metrics.reduce((a, m) => a + m.suma, 0) / pares : null;
}

/**
 * Fotogramas con valor en bruto que cada método quita o cambia (más de 0,5°):
 * solo las reglas, solo Argon o ambos.
 */
export function overlap(raw, rules, argon) {
  const touched = (out, i) => out[i] == null || Math.abs(out[i] - raw[i]) > 0.5;
  let soloReglas = 0, soloArgon = 0, ambos = 0;
  raw.forEach((v, i) => {
    if (v == null) return;
    const r = touched(rules, i), a = touched(argon, i);
    if (r && a) ambos++; else if (r) soloReglas++; else if (a) soloArgon++;
  });
  return { soloReglas, soloArgon, ambos };
}
