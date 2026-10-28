// Filtros contra oclusiones y reconstrucciones erróneas de MediaPipe.
//
// Actúan en dos niveles:
//  1. Puntos clave (por fotograma), antes de calcular ángulos:
//     - Longitud de los huesos: en las coordenadas 3D (metros) cada segmento debe medir
//       siempre lo mismo. Si se aleja de su mediana en el vídeo, el punto distal es dudoso.
//     - Coherencia 2D–3D: si en 3D el codo está claramente por encima del hombro y en la
//       imagen claramente por debajo (o al revés), la reconstrucción 3D se ha inventado la pose.
//  2. Series de ángulos (en el tiempo):
//     - Rango fisiológico por articulación.
//     - Filtro de Hampel: valores atípicos respecto a la mediana local.
//     - Tramos cortos separados por saltos imposibles (velocidad angular máxima).
//     - Relleno de huecos cortos por interpolación lineal; los largos se dejan vacíos.
//
// Los fotogramas descartados quedan como null; las razones se cuentan para mostrarlas.

import { VISIBILITY_THRESHOLD, FILTROS } from './config.js';

// Segmentos [proximal, distal]. Si un segmento falla, se culpa al punto distal.
const SEGMENTOS = [
  [11, 13], [13, 15], [12, 14], [14, 16], // brazos y antebrazos
  [23, 25], [25, 27], [24, 26], [26, 28], // muslos y piernas
];

export const RAZONES = {
  visibilidad: 'Visibilidad baja',
  huesos: 'Longitud de hueso anómala',
  coherencia: 'Incoherencia 2D–3D',
  rango: 'Fuera de rango fisiológico',
  atipicos: 'Valor atípico (Hampel)',
  saltos: 'Tramo corto tras un salto',
  interpolados: 'Hueco corto interpolado',
};

const median = (arr) => {
  const v = arr.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const visible = (f, i) => f.lm[i][3] >= VISIBILITY_THRESHOLD;

/**
 * Puntos no fiables por fotograma.
 * @returns {Array<Map<number,string>|null>} por fotograma, índice del punto → razón
 */
export function invalidPoints(frames, width, height) {
  // Longitud de referencia de cada segmento: mediana en los fotogramas en que se ve bien.
  const ref = SEGMENTOS.map(([a, b]) => median(frames
    .filter((f) => f.wlm && visible(f, a) && visible(f, b))
    .map((f) => dist3(f.wlm[a], f.wlm[b]))));

  const s = FILTROS.coherenciaVertical;
  return frames.map((f) => {
    if (!f.lm || !f.wlm) return null;
    const bad = new Map();
    SEGMENTOS.forEach(([a, b], k) => {
      if (!visible(f, a) || !visible(f, b)) return;
      if (ref[k] && Math.abs(dist3(f.wlm[a], f.wlm[b]) / ref[k] - 1) > FILTROS.toleranciaHueso) {
        bad.set(b, 'huesos');
        return;
      }
      // Seno del ángulo con la horizontal; positivo = el punto distal está por debajo.
      const d3 = [f.wlm[b][0] - f.wlm[a][0], f.wlm[b][1] - f.wlm[a][1], f.wlm[b][2] - f.wlm[a][2]];
      const s3 = d3[1] / (Math.hypot(...d3) || 1);
      const dx = (f.lm[b][0] - f.lm[a][0]) * width, dy = (f.lm[b][1] - f.lm[a][1]) * height;
      const s2 = dy / (Math.hypot(dx, dy) || 1);
      if (s3 * s2 < 0 && Math.abs(s3) > s && Math.abs(s2) > s && !bad.has(b)) bad.set(b, 'coherencia');
    });
    return bad;
  });
}

/** Filtros temporales sobre la serie de un ángulo. Modifica `q` con los recuentos. */
export function filterSeries(values, times, group, q) {
  const n = values.length;
  if (n < 3) return values.slice();
  const dt = median(times.slice(1).map((t, i) => t - times[i])) || 1 / 15;
  const vmax = FILTROS.velocidadMaxima[group] ?? 400;
  const [lo, hi] = FILTROS.rango[group] ?? [0, 180];

  // 1. Rango fisiológico
  let v = values.map((x) => {
    if (x == null) return null;
    if (x < lo || x > hi) { q.rango++; return null; }
    return x;
  });

  // 2. Hampel (sobre la serie ya acotada; la ventana usa los valores originales)
  const h = Math.max(2, Math.round(FILTROS.hampelVentana_s / dt));
  const src = v.slice();
  v = src.map((x, i) => {
    if (x == null) return null;
    const win = [];
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) if (src[j] != null) win.push(src[j]);
    if (win.length < 5) return x;
    const med = median(win);
    const mad = 1.4826 * median(win.map((w) => Math.abs(w - med)));
    if (Math.abs(x - med) > Math.max(FILTROS.hampelSigmas * mad, FILTROS.hampelMinimo)) { q.atipicos++; return null; }
    return x;
  });

  // 3. Tramos cortos delimitados por saltos imposibles
  const jump = (i) => i > 0 && i < n && v[i] != null && v[i - 1] != null
    && Math.abs(v[i] - v[i - 1]) / Math.max(times[i] - times[i - 1], 1e-6) > vmax;
  for (let i = 0; i < n;) {
    if (v[i] == null) { i++; continue; }
    let e = i;
    while (e + 1 < n && v[e + 1] != null && !jump(e + 1)) e++;
    const dur = times[e] - times[i] + dt;
    const len = e - i + 1;
    if (len <= 2 || (dur < FILTROS.tramoMinimo_s && (jump(i) || jump(e + 1)))) {
      for (let k = i; k <= e; k++) v[k] = null;
      q.saltos += len;
    }
    i = e + 1;
  }

  // 4. Relleno de huecos cortos
  for (let i = 1; i < n; i++) {
    if (v[i] != null || v[i - 1] == null) continue;
    let e = i;
    while (e < n && v[e] == null) e++;
    if (e < n) {
      const a = i - 1, span = times[e] - times[a];
      if (span - dt <= FILTROS.huecoMaximo_s + 1e-6 && Math.abs(v[e] - v[a]) / span <= vmax) {
        for (let k = i; k < e; k++) {
          v[k] = Math.round((v[a] + ((v[e] - v[a]) * (times[k] - times[a])) / span) * 10) / 10;
          q.interpolados++;
        }
      }
    }
    i = e;
  }
  return v;
}
