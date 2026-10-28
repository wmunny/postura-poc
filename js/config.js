// Configuración central de la PoC.
// Para no depender de CDNs externos (redes corporativas, uso offline), ejecuta
// `scripts/descargar-dependencias.sh` y pon USE_LOCAL_ASSETS = true.

export const APP_VERSION = '0.1.0';

const USE_LOCAL_ASSETS = false;
const TASKS_VISION_VERSION = '1.1.1';

const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
const GCS = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

export const CONFIG = USE_LOCAL_ASSETS
  ? {
      visionBundleUrl: new URL('../vendor/tasks-vision/vision_bundle.mjs', import.meta.url).href,
      wasmBase: new URL('../vendor/tasks-vision/wasm', import.meta.url).href,
      models: {
        lite: new URL('../vendor/models/pose_landmarker_lite.task', import.meta.url).href,
        full: new URL('../vendor/models/pose_landmarker_full.task', import.meta.url).href,
        heavy: new URL('../vendor/models/pose_landmarker_heavy.task', import.meta.url).href,
      },
      tasksVisionVersion: TASKS_VISION_VERSION,
    }
  : {
      visionBundleUrl: `${CDN}/vision_bundle.mjs`,
      wasmBase: `${CDN}/wasm`,
      models: {
        lite: `${GCS}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
        full: `${GCS}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
        heavy: `${GCS}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
      },
      tasksVisionVersion: TASKS_VISION_VERSION,
    };

// Umbral de visibilidad por debajo del cual un punto no se usa para calcular ángulos.
export const VISIBILITY_THRESHOLD = 0.5;
