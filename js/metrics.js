// Métricas para comparar la serie en bruto con sus versiones limpiadas (filtros mecánicos y Argon).
// Miden estabilidad y coherencia, no exactitud: para eso hace falta una referencia medida a mano.

import { FILTROS } from './config.js';

/**
 * Métricas de una serie de ángulos (sin suavizar).
 *  - fluctuacion: cambio medio entre fotogramas consecutivos, en grados por segundo.
 *  - saltos: cambios más rápidos que la velocidad máxima plausible de la articulación.
 *  - fueraRango: valores fuera del rango fisiológico.
 *  - cobertura: porcentaje de fotogramas con valor.
 */
export function seriesMetrics(values, times, group) {
  const vmax = FILTROS.velocidadMaxima[group] ?? 400;
  const [lo, hi] = FILTROS.rango[group] ?? [0, 180];
  let sum = 0, pairs = 0, saltos = 0, fueraRango = 0, n = 0;
  values.forEach((v, i) => {
    if (v == null) return;
    n++;
    if (v < lo || v > hi) fueraRango++;
    const p = values[i - 1];
    if (i > 0 && p != null) {
      const speed = Math.abs(v - p) / Math.max(times[i] - times[i - 1], 1e-6);
      sum += speed; pairs++;
      if (speed > vmax) saltos++;
    }
  });
  return {
    fluctuacion: pairs ? sum / pairs : null,
    saltos,
    fueraRango,
    cobertura: values.length ? (100 * n) / values.length : 0,
  };
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
