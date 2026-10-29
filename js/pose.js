// Estimación de pose fotograma a fotograma con MediaPipe Pose Landmarker.
// Todo se ejecuta en el navegador (WebAssembly + WebGL/GPU): el vídeo no sale del dispositivo.

import { CONFIG } from './config.js';

let visionModule = null;
let fileset = null;
let landmarker = null;
let loadedModel = null;
let delegateUsed = null;
let lastTimestamp = 0; // el modo VIDEO exige marcas de tiempo estrictamente crecientes

async function loadModule() {
  if (!visionModule) visionModule = await import(CONFIG.visionBundleUrl);
  if (!fileset) fileset = await visionModule.FilesetResolver.forVisionTasks(CONFIG.wasmBase);
  return visionModule;
}

export async function getLandmarker(model = 'full') {
  const { PoseLandmarker } = await loadModule();
  if (landmarker && loadedModel === model) return { landmarker, delegate: delegateUsed };
  if (landmarker) { landmarker.close(); landmarker = null; }

  const options = (delegate) => ({
    baseOptions: { modelAssetPath: CONFIG.models[model], delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });

  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, options('GPU'));
    delegateUsed = 'GPU';
  } catch (err) {
    console.warn('GPU no disponible, se usa CPU:', err);
    landmarker = await PoseLandmarker.createFromOptions(fileset, options('CPU'));
    delegateUsed = 'CPU';
  }
  loadedModel = model;
  return { landmarker, delegate: delegateUsed };
}

export function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      // Esperamos a que el fotograma esté realmente disponible (Chrome/Edge/Safari recientes).
      if ('requestVideoFrameCallback' in video) {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        video.requestVideoFrameCallback(finish);
        setTimeout(finish, 120);
      } else {
        resolve();
      }
    };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

const r5 = (n) => Math.round(n * 1e5) / 1e5;

/**
 * Recorre el vídeo a `fps` fotogramas por segundo y devuelve los puntos clave.
 * `onFrame(frame)` se llama con cada fotograma mientras el vídeo sigue en ese instante (para grabar el
 * vídeo con el esqueleto sin una segunda pasada).
 * @returns {Promise<{frames: Array, delegate: string}>}
 */
export async function analyzeVideo(video, { model = 'full', fps = 15, onProgress, onFrame, signal } = {}) {
  const { landmarker: lmk, delegate } = await getLandmarker(model);
  const duration = video.duration;
  const step = 1 / fps;
  const total = Math.max(1, Math.floor(duration / step));
  const frames = [];
  video.pause();

  const base = lastTimestamp + 1000;
  const t0 = performance.now();

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Análisis cancelado', 'AbortError');
    const t = Math.min(i * step, Math.max(0, duration - 0.001));
    await seek(video, t);
    const ts = Math.round(base + t * 1000);
    lastTimestamp = ts;
    const res = lmk.detectForVideo(video, ts);

    const lm = res.landmarks?.[0];
    const wlm = res.worldLandmarks?.[0];
    frames.push({
      t: r5(t),
      lm: lm ? lm.map((p) => [r5(p.x), r5(p.y), r5(p.z), r5(p.visibility ?? 0)]) : null,
      wlm: wlm ? wlm.map((p) => [r5(p.x), r5(p.y), r5(p.z), r5(p.visibility ?? 0)]) : null,
    });
    if (onFrame) await onFrame(frames[frames.length - 1]);

    if (onProgress && (i % 3 === 0 || i === total - 1)) {
      const elapsed = (performance.now() - t0) / 1000;
      const eta = (elapsed / (i + 1)) * (total - i - 1);
      onProgress({ done: i + 1, total, eta, frame: frames[frames.length - 1] });
    }
  }
  return { frames, delegate };
}

// Nombres de los 33 puntos de BlazePose (orden de MediaPipe).
export const LANDMARK_NAMES = [
  'nariz', 'ojo_izq_int', 'ojo_izq', 'ojo_izq_ext', 'ojo_dch_int', 'ojo_dch', 'ojo_dch_ext',
  'oreja_izq', 'oreja_dch', 'boca_izq', 'boca_dch',
  'hombro_izq', 'hombro_dch', 'codo_izq', 'codo_dch', 'muneca_izq', 'muneca_dch',
  'menique_izq', 'menique_dch', 'indice_izq', 'indice_dch', 'pulgar_izq', 'pulgar_dch',
  'cadera_izq', 'cadera_dch', 'rodilla_izq', 'rodilla_dch', 'tobillo_izq', 'tobillo_dch',
  'talon_izq', 'talon_dch', 'pie_izq', 'pie_dch',
];

// Conexiones del esqueleto con lado (L = izquierdo del trabajador, R = derecho, C = centro).
export const CONNECTIONS = [
  [11, 12, 'C'], [11, 23, 'L'], [12, 24, 'R'], [23, 24, 'C'],
  [11, 13, 'L'], [13, 15, 'L'], [15, 17, 'L'], [15, 19, 'L'], [15, 21, 'L'], [17, 19, 'L'],
  [12, 14, 'R'], [14, 16, 'R'], [16, 18, 'R'], [16, 20, 'R'], [16, 22, 'R'], [18, 20, 'R'],
  [23, 25, 'L'], [25, 27, 'L'], [27, 29, 'L'], [29, 31, 'L'], [27, 31, 'L'],
  [24, 26, 'R'], [26, 28, 'R'], [28, 30, 'R'], [30, 32, 'R'], [28, 32, 'R'],
  [0, 7, 'C'], [0, 8, 'C'], [9, 10, 'C'],
];
