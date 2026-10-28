# Análisis de librerías para la estimación de postura

*Modelo biomecánico Vítaly · Fase 1 (percepción) · octubre de 2026*

## Qué necesitamos en esta fase

1. Funcionar con **un vídeo de móvil**, sin marcadores ni sensores.
2. Ejecutarse **en el navegador** y publicarse como web estática (GitHub Pages): el vídeo del trabajador no sale del dispositivo, lo que simplifica mucho el RGPD.
3. Dar **puntos clave suficientes para ergonomía**: tronco, cuello, hombros, codos, muñecas, caderas, rodillas y tobillos (y, más adelante, manos para RULA).
4. Tener una **licencia que permita uso comercial**.
5. Que la salida se pueda **reutilizar en fases posteriores** (métodos REBA/RULA/OWAS/NIOSH y modelos biomecánicos tipo OpenSim).

## Comparativa

| Librería / modelo | Puntos clave | 3D | ¿En el navegador? | Licencia | Valoración para Vítaly |
|---|---|---|---|---|---|
| **MediaPipe Pose Landmarker** (BlazePose, Google) | 33 (cuerpo, pies, esbozo de manos) | Sí, "world landmarks" en metros (estimación monocular) | **Sí**, WASM + GPU (WebGL), móvil y PC | Apache 2.0 | **Elegida para la PoC.** Madura, ligera, con mantenimiento activo y tres tamaños (lite, full, heavy). |
| **RTMPose / RTMW / RTMW3D** (MMPose, vía `rtmlib`) | 17 / 26 / **133** (cuerpo completo con manos y cara) | RTMW3D sí | Posible exportando a ONNX + `onnxruntime-web` (WebGPU), con trabajo de integración | Apache 2.0 | **Candidata para la siguiente iteración**: más precisa y con manos (muñeca para RULA). Opción natural en servidor (Python). |
| **MoveNet** (TensorFlow.js) | 17 (sin pies ni manos) | No | Sí | Apache 2.0 | Rápida pero insuficiente: solo 2D y sin cambios desde 2023. |
| **Pose2Sim + OpenSim** | Usa RTMPose como detector | **Sí, triangulado** con 2 o más cámaras, y cinemática escalada en OpenSim | No (Python) | BSD-3 / Apache 2.0 | **Referencia para la fase 2** (biomecánica): ángulos articulares de calidad de laboratorio y dinámica inversa. |
| **OpenCap** (Stanford) / **OpenCap Monocular** (Utah, 2026) | Modelo musculoesquelético completo | Sí, con cinemática y cinética | App y web propias en la nube | Código abierto ([opencap-core](https://github.com/stanfordnmbl/opencap-core), [opencap-processing](https://github.com/stanfordnmbl/opencap-processing)); **revisar las licencias de las dependencias**: OpenPose (no comercial) y, en la versión monocular, WHAM/SMPL (no comercial). El CC BY-NC-SA 4.0 que figura en arXiv es la licencia del artículo, no del software | Muy relevante científicamente (unos 4,8° de error medio con un solo móvil, en marcha, sentadilla y levantarse de la silla) y la arquitectura que más se parece a lo que buscamos. El uso comercial pasa por sustituir las dependencias restrictivas (p. ej. RTMPose en lugar de OpenPose) o por un acuerdo con los autores. |
| **WHAM / TRAM / 4DHumans / VIBE** (malla SMPL) | Malla corporal | Sí | No (GPU en servidor) | Dependen del modelo **SMPL, de licencia no comercial** | Evitar en producto salvo que se licencie SMPL. Útiles en investigación. |
| **YOLO-pose** (Ultralytics) | 17 | No | Posible | **AGPL-3.0** o licencia comercial de pago | Descartada por la licencia. |
| **OpenPose** (CMU) | 25 a 135 | No | No | No comercial | Obsoleta y con licencia restrictiva. |
| **Sapiens** (Meta) | 308 | Parcial | No (modelos muy pesados) | CC BY-NC 4.0 | Solo investigación. |

> Las licencias deben revisarse con el equipo jurídico antes de cualquier uso comercial. Hay que mirar tanto el código como los **pesos del modelo** y los **datos con los que se entrenó**.

## Por qué MediaPipe para esta primera fase

- Es la única opción que cumple a la vez todos estos requisitos: **funciona en el navegador del móvil, da puntos 3D, cubre pies y tobillos, tiene licencia comercial y está mantenida**.
- La PoC se publica tal cual en GitHub Pages, sin servidor ni coste de infraestructura.
- La salida (formato `vitaly-postura/v1`, en JSON o CSV) es **independiente del motor**. Si mañana cambiamos a RTMW o a un backend en Python, las fases siguientes (métodos de evaluación, OpenSim) no cambian.

## Limitaciones que hay que tener presentes

- **El 3D es una estimación monocular.** La profundidad se infiere y no se mide. En los movimientos fuera del plano de la cámara, los ángulos 2D y 3D pueden diferir mucho. En el vídeo de prueba (un lateral cruzado), el codo derecho llega a 173° en 2D frente a 97° en 3D.
- **Los ángulos 2D solo son válidos si el movimiento ocurre en el plano de la imagen.** Por eso el protocolo de grabación importa: cámara perpendicular al plano del movimiento, estable y vertical.
- **No hay muñeca ni dedos fiables.** Para la muñeca de RULA habría que añadir MediaPipe Hand Landmarker o pasar a RTMW (133 puntos).
- **No hay rotación de tronco ni de cuello fiable** con una sola cámara.
- **El cuello tiene un desfase anatómico.** El eje hombros→orejas no está alineado con el tronco en postura neutra (unos 15–20° en la prueba), así que hará falta calibrarlo, por ejemplo restando la postura de referencia del propio trabajador.
- **Fuerzas y cargas no se obtienen del vídeo.** Requieren datos adicionales (peso de la carga, puntos de contacto) y un modelo biomecánico, como indica el documento de estrategia.

## Evidencia publicada (resumen)

- Las comparaciones de MediaPipe frente a captura óptica e IMU en sentadilla y sentarse-levantarse muestran un **rango de movimiento sin diferencias significativas**, aunque con **errores fotograma a fotograma mayores** que el patrón de referencia y sensibilidad a oclusión, ropa e iluminación ([arXiv 2503.14760](https://arxiv.org/pdf/2503.14760)).
- **OpenCap Monocular** (2026) obtiene 4,8° de error absoluto medio en grados de libertad rotacionales con un solo móvil, combinando un estimador 3D, optimización con modelo esquelético y simulación física ([arXiv 2603.24733](https://arxiv.org/abs/2603.24733)). Marca hacia dónde puede evolucionar la fase 2.

## Recomendación por fases

| Fase | Motor de postura | Dónde se ejecuta | Objetivo |
|---|---|---|---|
| **1a (esta PoC)** | MediaPipe Pose Landmarker | Navegador | Demostrar la captura con el móvil, los ángulos básicos y la exportación de datos |
| **1b** | MediaPipe + Hand Landmarker, o RTMW (ONNX Runtime Web / WebGPU) | Navegador | Añadir la muñeca y las manos; comparar la precisión |
| **1c (validación)** | Las mismas, frente a una referencia | — | Grabar 20–30 tareas con goniómetro, IMU o mocap; calcular el error por articulación (MAE, Bland-Altman) y la concordancia de la puntuación REBA/RULA |
| **2** | RTMPose + Pose2Sim + OpenSim (una o dos cámaras) | Servidor Python | Cinemática escalada, dinámica inversa y momentos lumbares |
| **3** | Modelos del mundo y simulación | Servidor | Simular cambios del puesto (ergonomía predictiva) |

## Fuentes

- MediaPipe Pose Landmarker (Google AI Edge): https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
- rtmlib (RTMPose, RTMW, RTMW3D; Apache 2.0): https://github.com/Tau-J/rtmlib
- RTMW3D (Harvard MMLA): https://mmla.gse.harvard.edu/tools/rtmw3d
- OpenCap: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10586693/
- OpenCap Monocular: https://arxiv.org/abs/2603.24733
- Validación de MediaPipe y VIBE frente a IMU y mocap: https://arxiv.org/pdf/2503.14760
