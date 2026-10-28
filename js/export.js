// Exportación de resultados. CSV con separador ',' y punto decimal (compatible con Python/R;
// en Excel con configuración española, usar "Datos > Desde texto/CSV").

import { ANGLE_DEFS } from './angles.js';
import { LANDMARK_NAMES } from './pose.js';

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const baseName = (meta) => (meta.fileName || 'video').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');

export function exportAnglesCSV(meta, times, series, mode) {
  const head = ['frame', 'tiempo_s', ...ANGLE_DEFS.map((d) => `${d.id}_deg`)];
  const rows = times.map((t, i) => [i, t, ...ANGLE_DEFS.map((d) => series[d.id][i] ?? '')]);
  const csv = [head, ...rows].map((r) => r.join(',')).join('\n');
  download(`${baseName(meta)}_angulos_${mode}.csv`, csv, 'text/csv');
}

export function exportLandmarksCSV(meta, frames) {
  const head = ['frame', 'tiempo_s', 'detectado'];
  for (const n of LANDMARK_NAMES) head.push(`${n}_x`, `${n}_y`, `${n}_z`, `${n}_vis`);
  for (const n of LANDMARK_NAMES) head.push(`${n}_wx_m`, `${n}_wy_m`, `${n}_wz_m`);
  const rows = frames.map((f, i) => {
    const r = [i, f.t, f.lm ? 1 : 0];
    for (let k = 0; k < 33; k++) r.push(...(f.lm ? f.lm[k] : ['', '', '', '']));
    for (let k = 0; k < 33; k++) r.push(...(f.wlm ? f.wlm[k].slice(0, 3) : ['', '', '']));
    return r;
  });
  const csv = [head, ...rows].map((r) => r.join(',')).join('\n');
  download(`${baseName(meta)}_landmarks.csv`, csv, 'text/csv');
}

export function exportJSON(meta, frames) {
  const payload = {
    formato: 'postura/v1',
    descripcion: 'lm: [x,y,z,visibilidad] normalizados a la imagen (0-1). wlm: [x,y,z,visibilidad] en metros, origen en el centro de la cadera (MediaPipe world landmarks).',
    landmarks: LANDMARK_NAMES,
    meta,
    frames,
  };
  download(`${baseName(meta)}_pose.json`, JSON.stringify(payload), 'application/json');
}
