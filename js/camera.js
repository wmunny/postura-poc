// Orientación de la cámara respecto al trabajador y modo de ángulos recomendado.
//
// Con la cámara de perfil, la flexión del tronco, la cadera o la rodilla ocurre en un plano paralelo a la
// imagen y el ángulo 2D (como lo mediría un técnico sobre el vídeo) es fiable. De frente, de espaldas o en
// diagonal, esa flexión va hacia la cámara y la imagen la acorta: el 2D la subestima y es mejor el 3D.
// Se mide en cada fotograma la anchura de los hombros dividida por la altura del tronco en la imagen.

import { CAMARA, VISIBILITY_THRESHOLD } from './config.js';

const median = (arr) => {
  const v = arr.slice().sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
};

/**
 * @returns {{lateral:number, oblicua:number, frontal:number, ratio:number|null, recomendado:'2d'|'3d', n:number}}
 *          porcentaje de fotogramas en cada orientación, relación mediana y modo recomendado.
 */
export function cameraOrientation(frames, width, height) {
  const ratios = [];
  for (const f of frames) {
    if (!f.lm) continue;
    const p = f.lm;
    if (![11, 12, 23, 24].every((i) => p[i][3] >= VISIBILITY_THRESHOLD)) continue;
    const sw = Math.hypot((p[11][0] - p[12][0]) * width, (p[11][1] - p[12][1]) * height);
    const mx = ((p[11][0] + p[12][0]) - (p[23][0] + p[24][0])) / 2 * width;
    const my = ((p[11][1] + p[12][1]) - (p[23][1] + p[24][1])) / 2 * height;
    const th = Math.hypot(mx, my);
    if (th > 1) ratios.push(sw / th);
  }
  const n = ratios.length;
  if (!n) return { lateral: 0, oblicua: 0, frontal: 0, ratio: null, recomendado: '3d', n };
  const pct = (fn) => (100 * ratios.filter(fn).length) / n;
  const lateral = pct((r) => r < CAMARA.lateral);
  const frontal = pct((r) => r > CAMARA.frontal);
  return {
    lateral, frontal, oblicua: 100 - lateral - frontal, ratio: median(ratios), n,
    recomendado: lateral / 100 >= CAMARA.minimoLateral ? '2d' : '3d',
  };
}
