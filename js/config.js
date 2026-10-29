// Configuración central de la PoC.
// Para no depender de CDNs externos (redes corporativas, uso offline), ejecuta
// `scripts/descargar-dependencias.sh` y pon USE_LOCAL_ASSETS = true.

export const APP_VERSION = '0.6.0';

const USE_LOCAL_ASSETS = false;
const TASKS_VISION_VERSION = '1.1.1';
const MP4_MUXER_VERSION = '5.2.1';

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
      mp4MuxerUrl: new URL('../vendor/mp4-muxer/mp4-muxer.mjs', import.meta.url).href,
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
      mp4MuxerUrl: `https://cdn.jsdelivr.net/npm/mp4-muxer@${MP4_MUXER_VERSION}/build/mp4-muxer.mjs`,
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
  huecoMaximoC_s: 1.0,       // escenario C: huecos más cortos que esto se rellenan por interpolación
};

// Vídeo con el esqueleto de MediaPipe que revisa Argon en el escenario C (js/overlay-video.js).
export const VIDEO_ESQUELETO = {
  anchoMaximo: 640,          // ancho máximo de cada mitad del vídeo lado a lado
  altoMaximo: 720,
  anchoMaximoSuperpuesto: 1280,
  bitsPorPixel: 0.12,        // calidad: bits por píxel y fotograma
};

// Validación estadística del vídeo (js/validation.js). Convenciones iniciales: hay que calibrarlas
// con un ergónomo. Los pares [verde, ámbar] son el mínimo (o el máximo) para cada color.
export const VALIDACION = {
  regiones: [
    { id: 'tronco', label: 'Tronco y cuello', angulos: ['tronco', 'cuello'],
      consejo: 'Coloca la cámara de lado, perpendicular al plano en que se inclina el tronco, con el trabajador entero en el encuadre.' },
    { id: 'piernas', label: 'Piernas', angulos: ['cadera_L', 'cadera_R', 'rodilla_L', 'rodilla_R'],
      consejo: 'Encuadra el cuerpo entero, pies incluidos, y evita mesas u objetos entre la cámara y las piernas.' },
    { id: 'brazo_L', label: 'Brazo izquierdo', angulos: ['hombro_L', 'codo_L'],
      consejo: 'Pon la cámara en el lado izquierdo del trabajador o añade una segunda cámara: de espaldas o de perfil derecho, el torso tapa este brazo.' },
    { id: 'brazo_R', label: 'Brazo derecho', angulos: ['hombro_R', 'codo_R'],
      consejo: 'Pon la cámara en el lado derecho del trabajador o añade una segunda cámara: de espaldas o de perfil izquierdo, el torso tapa este brazo.' },
  ],
  // Métodos: ángulos que necesitan y perspectiva («pico»: peor postura; «tiempo»: proporción de tiempo).
  metodos: [
    // muneca: 'ambas' (cuentan los dos lados), 'una' (basta con un lado) o null (el método no la usa).
    { id: 'REBA', perspectiva: 'pico', muneca: 'ambas', angulos: ['tronco', 'cuello', 'rodilla_L', 'rodilla_R', 'hombro_L', 'hombro_R', 'codo_L', 'codo_R'],
      nota: 'La carga y el agarre los aporta el contexto de Argon o el usuario. La muñeca, por categorías estimadas por Argon (escenario C).' },
    { id: 'RULA', perspectiva: 'pico', muneca: 'una', angulos: ['tronco', 'cuello', 'hombro_L', 'hombro_R', 'codo_L', 'codo_R'],
      nota: 'Se puede evaluar solo el lado que se vea bien. La muñeca, por categorías estimadas por Argon (escenario C).' },
    { id: 'OWAS', perspectiva: 'tiempo', muneca: null, angulos: ['tronco', 'hombro_L', 'hombro_R', 'rodilla_L', 'rodilla_R'],
      nota: 'Necesita estimar el % del tiempo en cada postura: pide vídeos largos o varios ciclos.' },
  ],
  // Umbrales de categoría (grados) según REBA; el codo es neutro entre 60° y 100°.
  categorias: { tronco: [5, 20, 60], cuello: [20], hombro: [20, 45, 90], codo: [60, 100], rodilla: [30, 60] },
  riesgoDesde: { tronco: 2, cuello: 1, hombro: 2, codo: 1, rodilla: 1 }, // categoría a partir de la cual es «postura de riesgo»
  cobertura: [70, 40],          // % de fotogramas con valor
  coberturaFase: [50, 20],      // % mínimo en cada fase de la tarea
  margen: [10, 20],             // margen de error (± puntos %, 95 %) del % de tiempo en postura de riesgo
  margenObjetivo: 10,
  z: 1.96,
  bandasExposicion: [10, 30],   // % de tiempo en postura de riesgo: < 10, 10–30, > 30
  huecoPico_s: 1,               // huecos más largos que esto pueden ocultar la peor postura
  decorrelacionMaxima_s: 10,
};
