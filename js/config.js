// Configuración central de la PoC.
// Para no depender de CDNs externos (redes corporativas, uso offline), ejecuta
// `scripts/descargar-dependencias.sh` y pon USE_LOCAL_ASSETS = true.

export const APP_VERSION = '0.3.0';

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

// Filtros contra oclusiones y reconstrucciones erróneas (js/filters.js).
export const FILTROS = {
  toleranciaHueso: 0.3,      // variación máxima de la longitud 3D de un segmento respecto a su mediana en el vídeo
  coherenciaVertical: 0.5,   // seno del ángulo con la horizontal (0,5 = 30°) para comparar 2D y 3D
  hampelVentana_s: 0.5,      // semiventana del filtro de Hampel
  hampelSigmas: 3,
  hampelMinimo: 12,          // grados: por debajo de esta desviación nunca se considera atípico
  tramoMinimo_s: 0.4,        // tramos más cortos que esto, separados por un salto, se descartan
  huecoMaximo_s: 0.3,        // huecos más cortos que esto se rellenan por interpolación lineal
  // Velocidad angular máxima plausible (grados/s) por grupo articular.
  velocidadMaxima: { tronco: 300, cuello: 300, hombro: 500, codo: 500, cadera: 300, rodilla: 400 },
  // Rango fisiológico (grados) por grupo articular.
  rango: { tronco: [0, 120], cuello: [0, 90], hombro: [0, 180], codo: [0, 160], cadera: [0, 150], rodilla: [0, 165] },
};

// Escenarios B y C: Gemini 4 Argon a través de la Interactions API.
export const GEMINI = {
  modelo: 'gemini-4-argon',
  maxTokensSalida: 32768,
};
