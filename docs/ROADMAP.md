# Hoja de ruta

*Actualizada el 28 de octubre de 2026*

El objetivo final es una **skill** que un asistente (Gemini, Claude u otro con MCP) pueda usar para analizar el vídeo de un puesto de trabajo y calcular métodos ergonómicos como **REBA, RULA y OWAS**. Las puntuaciones las calcula código determinista; el modelo de lenguaje orquesta, pregunta lo que el vídeo no da e interpreta.

## Estado

| # | Paso | Estado |
|---|---|---|
| 1 | Filtros anti-oclusión en la serie de MediaPipe | Hecho (v0.2) |
| 2 | Escenarios A · B · C (MediaPipe, Gemini 4 Argon, mixto) | Hecho (v0.2), pendiente de probar con la API real |
| 3 | Validación de los escenarios frente a una referencia | Pendiente |
| 4 | Módulo `ergo`: REBA, RULA y OWAS | Pendiente |
| 5 | Motor sin interfaz (Python) | Pendiente |
| 6 | Servidor MCP y skill | Pendiente |
| 7 | Cinemática inversa con modelo esquelético | Pendiente |

## 1. Filtros anti-oclusión (hecho)

En `js/filters.js`, configurables en `js/config.js` (`FILTROS`):

- **Longitud de los huesos** en 3D: un segmento que se aleja más de un 30 % de su mediana invalida su punto distal.
- **Coherencia 2D–3D**: si en 3D el codo está claramente por encima del hombro y en la imagen claramente por debajo (o al revés), la pose 3D es inventada. Es el caso típico del brazo tapado por el cuerpo.
- **Rango fisiológico** por articulación.
- **Filtro de Hampel** (mediana ± 3 MAD en ±0,5 s, mínimo 12°).
- **Tramos cortos tras saltos imposibles** (velocidad angular máxima por articulación).
- **Relleno de huecos** de menos de 0,3 s; los más largos se dejan vacíos.

La app muestra cuántos fotogramas descarta cada filtro y dibuja la serie sin filtrar como línea tenue.

## 2. Escenarios A · B · C (hecho)

- **A · MediaPipe**: serie densa en el navegador, con o sin filtros.
- **B · Argon solo**: Gemini 4 Argon ve el vídeo y estima los ángulos y el contexto.
- **C · Mixto**: Argon ve el vídeo y la serie de A, marca los tramos implausibles, propone correcciones y aporta contexto.

La clave de la API se pide al arrancar y solo vive en la memoria de la pestaña.

## 3. Validación (siguiente)

- 3–5 vídeos reales con oclusiones, tareas distintas y cámara lateral y frontal.
- Un ergónomo anota 15–20 fotogramas clave por vídeo: ángulos con goniómetro sobre la imagen y la categoría REBA/RULA de cada segmento.
- Métricas por escenario y articulación: error absoluto medio, Bland-Altman, cobertura y **concordancia de la categoría de riesgo** (lo que importa para REBA, RULA y OWAS).
- Comparar el coste (tokens, tiempo) y la estabilidad de B y C entre ejecuciones.
- Decidir con datos qué escenario alimenta la skill. La hipótesis es C.

## 4. Módulo `ergo`

- REBA, RULA y OWAS por fotograma y resumen: porcentaje del tiempo en cada nivel de riesgo y los peores instantes.
- Entradas que el vídeo no da: carga y fuerza, agarre, actividad, muñeca, brazo apoyado. Las puede aportar el contexto de Argon (escenarios B y C) o el usuario.
- Tablas oficiales implementadas como código con pruebas unitarias contra ejemplos publicados.
- Visualización en la app: banda de riesgo en el tiempo y tabla de peores posturas.

## 5. Motor sin interfaz

- Paquete Python con MediaPipe Tasks para generar el mismo JSON `postura/v1` desde un archivo, sin navegador.
- Mismos filtros y mismo módulo `ergo`, compartiendo pruebas con la versión web.
- CLI: `postura analizar video.mp4 --metodo reba`.

## 6. Servidor MCP y skill

- Herramientas: `analizar_video`, `revisar_con_argon`, `calcular_reba`, `calcular_rula`, `calcular_owas`, `peores_posturas`, `exportar_informe`.
- Funciona con Gemini (Gemini CLI, Antigravity, llamadas a funciones de la API) y con Claude.
- Instrucciones de la skill: cómo grabar, qué preguntar al usuario, cómo leer las puntuaciones y qué límites advertir.

## 7. Cinemática inversa

Ajustar un modelo esquelético (OpenSim / OpenCap Monocular) que imponga longitudes de hueso y límites articulares de forma nativa. Es la solución de fondo para las oclusiones con una sola cámara y abre la puerta a momentos articulares y cargas lumbares.

## Riesgos y condiciones

- **Privacidad**: en B y C el vídeo se envía a Google. Antes de usar vídeos reales de trabajadores hay que revisarlo con protección de datos (RGPD, datos de salud laboral) y, si hace falta, anonimizar (difuminar caras) o usar un acuerdo empresarial con Google.
- **Coste**: Gemini 4 Argon cuesta 2 $/10 $ por millón de tokens de entrada/salida hasta el 30/11/2026 y el doble después. Un vídeo de 30 s a 2 fotogramas/s son unos pocos miles de tokens.
- **Reproducibilidad**: un LLM no es determinista. Hay que medir la variación entre ejecuciones y no usarlo nunca para calcular las puntuaciones, solo para revisar y aportar contexto.
