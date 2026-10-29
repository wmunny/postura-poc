# Postura desde vídeo · PoC

Prueba de concepto de la **Fase 1 (percepción)** de un modelo biomecánico. A partir de un vídeo grabado con el móvil, la web:

1. Estima la **postura fotograma a fotograma**: 33 puntos clave en 2D y 3D (MediaPipe Pose Landmarker).
2. Dibuja el **esqueleto sobre el vídeo** y en un **visor 3D** que se puede girar.
3. Calcula los **ángulos articulares** de tronco, cuello, hombros, codos, caderas y rodillas, en dos modos: plano de imagen (2D) o estimación 3D.
4. Aplica **filtros anti-oclusión** que descartan reconstrucciones erróneas (por ejemplo, un brazo tapado que MediaPipe «levanta»).
5. Muestra la **evolución temporal** de cada ángulo y un **resumen estadístico** (media, mediana, P95, mínimo, máximo y cobertura).
6. Compara **MediaPipe en bruto**, con **filtros mecánicos**, con el **filtro inteligente** de Gemini 4 Argon (C) y con **ambos combinados** (D), y muestra lo que ve Argon por sí solo (B).
7. **Valida el vídeo** con un semáforo estadístico por método (REBA, RULA, OWAS) y por región del cuerpo, y dice cómo mejorar la grabación.
8. Genera un **vídeo con el esqueleto** de MediaPipe (lado a lado con el original, o superpuesto) para revisarlo y descargarlo.
9. **Exporta** los ángulos (CSV), los puntos clave (CSV) y los datos completos (JSON, formato `postura/v1`) para las fases siguientes (REBA, RULA, OWAS, NIOSH, OpenSim…).

**El escenario A se procesa entero en el navegador.** En B y C, el vídeo se envía a la API de Google Gemini.

> Es una prueba de concepto, no una herramienta de evaluación validada. Consulta las limitaciones en [`docs/LIBRERIAS.md`](docs/LIBRERIAS.md) y los próximos pasos en [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Escenarios

| Escenario | Qué hace | Dónde se ejecuta |
|---|---|---|
| **A · Bruto** | Serie densa de ángulos (10–30 por segundo) tal como sale de MediaPipe | Navegador |
| **A · Filtros mecánicos** | La misma serie limpiada con reglas fijas de consistencia mecánica | Navegador |
| **B · Argon solo** | Gemini 4 Argon marca las articulaciones en cada fotograma que muestrea, estima los ángulos 3D y describe el contexto de la tarea | API de Gemini |
| **C · Argon revisor** | Argon revisa el vídeo con el esqueleto de MediaPipe en bruto y señala, con pruebas, dónde está mal colocado, no se ve, es aproximado o tiene los lados invertidos; una política fija decide qué se quita, qué se conserva y qué se intercambia | Navegador + API de Gemini |
| **D · Reglas + Argon** | La revisión de Argon y, después, los filtros mecánicos. Sale de la misma llamada que C | Navegador + API de Gemini |

Si un punto está rechazado o no se ve, los ángulos que lo usan se calculan con el **lado visible** (tronco y elevación del brazo con el hombro y la cadera del mismo lado, cuello con una sola oreja, cadera con el hombro del otro lado).

### Esqueleto de Argon

En el escenario B, Argon devuelve la posición 2D de 14 articulaciones (orejas, hombros, codos, muñecas, caderas, rodillas y tobillos) en cada fotograma que ve. Esos puntos se dibujan sobre el vídeo con líneas discontinuas y articulaciones cuadradas amarillas, junto al esqueleto de MediaPipe, y cada uno se puede ocultar. Así se ve qué percibe Argon de verdad: si sitúa un codo en la pared, no lo ha localizado.

- En **2D**, los ángulos de B se calculan con nuestro código a partir de esos puntos, con las mismas definiciones que en A.
- En **3D**, son los ángulos anatómicos que estima Argon directamente.
- Argon solo ve unos pocos fotogramas por segundo (el muestreo elegido). Cada esqueleto se mantiene hasta la muestra siguiente, y en la esquina se indica el instante que vio.

En las gráficas, la línea tenue es siempre MediaPipe en bruto. La tabla *Ganancia de la limpieza* compara bruto, filtros mecánicos y Argon.

### Orientación de la cámara: 2D o 3D

Al terminar el análisis, la app mide en cada fotograma la anchura de los hombros frente a la altura del tronco y clasifica la cámara como **de perfil**, **en diagonal** o **de frente o de espaldas**. Si el trabajador sale de perfil la mayor parte del tiempo, recomienda **2D** (el ángulo en el plano de la imagen es fiable); si no, **3D** (la flexión va hacia la cámara y el 2D la acorta). Elige el modo recomendado automáticamente y lo explica junto a los botones de modo. Umbrales en `js/config.js` (`CAMARA`).

### C · Argon revisor

1. **Durante el propio análisis**, la app graba **dos vídeos MP4** con el esqueleto de MediaPipe en bruto (WebCodecs y [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), sin salir del navegador), aprovechando cada salto del vídeo. Cada fotograma es un instante analizado por MediaPipe, así que los tiempos cuadran:
   - **Lado a lado**: original a la izquierda; esqueleto y tiempo a la derecha. Es el que revisa Argon.
   - **Superpuesto**: una sola vista con el esqueleto, para grabar o publicar.
   Los dos se pueden descargar debajo del vídeo.
2. Al pulsar *Ejecutar C*, el vídeo lado a lado se envía a Gemini 4 Argon (por defecto **tres ejecuciones en paralelo**). Argon devuelve, por articulación y tramo, si el esqueleto está **mal colocado**, la articulación **no se ve**, la posición es **aproximada** o tiene el **lado invertido**, con el motivo y la **prueba** que ve en la imagen original; además, las fases de la tarea con su riesgo, las muñecas y el contexto. No da coordenadas ni ángulos.
3. **Argon no decide: una política fija lo hace** (`js/review-policy.js`, umbrales en `POLITICA` de `js/config.js`):

   | Lo que dice Argon | Qué se hace |
   |---|---|
   | Mal colocada | Se quita |
   | No visible más de 1,5 s | Se quita (ocultación larga: MediaPipe se inventa el punto) |
   | No visible hasta 1,5 s | Se conserva como aproximada, salvo en los fotogramas en que las reglas mecánicas detectan un fallo (ocultación corta: el lado lejano durante un giro) |
   | Aproximada | Se conserva marcada |
   | Lado invertido | Se intercambian izquierda y derecha **solo** si la profundidad 3D de MediaPipe lo confirma **y** hay al menos 2 ejecuciones; si no, queda **en disputa** y no se toca |
   | Varias ejecuciones | **Consenso**: solo se aplica lo que apoya la mayoría (1 de 1, 2 de 2, 2 de 3). Se muestra el acuerdo entre ejecuciones |

4. Con lo que queda se recalculan los ángulos (con el lado visible si falta uno), se rellenan los huecos de menos de 1 s y se dejan vacíos los más largos. D aplica después los filtros mecánicos.
5. En el vídeo: **cruz roja** (se quita), **anillo ámbar** (aproximada), **anillo ámbar discontinuo** (en disputa) y **anillo morado** (lados intercambiados). En las gráficas, los tramos van sombreados en rojo, ámbar o morado. La tarjeta de C lista cada tramo con la decisión, el motivo y la prueba.

### Instrucciones de Argon

Están en `prompts/argon-revisor.md` (escenario C) y `prompts/argon-solo.md` (escenario B), en texto legible, para revisarlas y ajustarlas **sin tocar el código**: definiciones de cada veredicto, cómo razonar la lateralidad, fases sin huecos, muñecas y criterios de los métodos (postura estática = más de 1 minuto, repetición = más de 4 por minuto, niveles de agarre). Los comentarios `<!-- -->` no se envían y `{{CLAVE}}` se sustituye automáticamente.

### Muñecas (estimación de Argon)

MediaPipe Pose no mide la muñeca con fiabilidad: los puntos de la mano son toscos y, con una sola cámara, suelen quedar tapados. En el escenario C, Argon la **clasifica por fases y lados**, como la usan REBA y RULA:

| Campo | Valores |
|---|---|
| Flexión / extensión | neutra · hasta 15° · más de 15° · no visible |
| Desviada (radial o cubital) | sí · no · no se sabe |
| Girada (cerca del final del recorrido) | sí · no · no se sabe |
| Confianza | alta · media · baja |

Se muestra en la tabla *Muñecas*, en la gráfica *Muñeca · flexión (categoría)* y en el *Fotograma actual*. Es una **estimación visual, no una medida**, y puede variar entre ejecuciones. Para medir la muñeca en grados haría falta MediaPipe Hand Landmarker y manos grandes y visibles en el vídeo.

### Ganancia de la limpieza

Sobre las series sin suavizar, en el modo de ángulos activo:

| Métrica | Qué mide |
|---|---|
| Fluctuación (°/s) | Cambio medio entre fotogramas consecutivos medidos (sin interpolados), ponderado por el número de medidas: estabilidad |
| Saltos imposibles | Cambios más rápidos que la velocidad máxima de la articulación |
| Fuera de rango | Valores fuera del rango fisiológico |
| Cobertura | Fotogramas con valor |
| Tramos / tramo mediano | Fragmentación: en cuántos trozos queda la serie |
| Aproximados | Valores que Argon da por aproximados |
| Qué detecta cada uno | Valores en bruto que quitan o cambian solo las reglas, solo Argon o ambos |

Miden estabilidad y coherencia, **no exactitud**: para eso hace falta una referencia medida a mano.

### Validez del vídeo

Un semáforo dice si lo que se ve es **representativo** de la tarea, sobre la mejor limpieza disponible (D si se ha ejecutado C; si no, las reglas). Cinco comprobaciones por articulación:

| # | Comprobación | Pregunta |
|---|---|---|
| 1 | Cobertura | ¿Cuánto se ve de verdad? |
| 2 | Cobertura por fase (las de Argon, sin huecos y uniendo las de menos de 1 s; o 5 tramos iguales) | ¿Falta alguna fase? Ponderada por su riesgo: perder una fase de riesgo alto es rojo; medio, ámbar; bajo, solo aviso |
| 3 | Muestra efectiva (tiempo de decorrelación) y margen de error | **Duración**: ¿hay observaciones independientes suficientes para el % de tiempo en postura de riesgo? Solo cuenta para OWAS y se muestra aparte (el documento de OWAS: 100 observaciones, error del 10 %; 20–40 min) |
| 4 | Peor y mejor caso | ¿Cambia la conclusión si lo que no se ve estuviera todo, o nada, en postura de riesgo? |
| 5 | Pico | ¿Puede estar oculta la peor postura en un hueco largo? |

El veredicto se da por **método**: REBA y RULA (peor postura: 1, 2 y 5) y OWAS (% del tiempo: 1, 2 y 4, más la **duración** como indicador aparte), y por **región**. En REBA y RULA la **extremidad superior** (hombro, codo y muñeca de Argon) se evalúa en el **lado que mejor se ve**, como en el ejemplo de la NTP 601; la muñeca da rojo si falta en una fase de riesgo alto y ámbar si falta en otra o solo hay confianza baja (tronco y cuello, piernas, brazo izquierdo, brazo derecho), con consejos de grabación. Las categorías de postura siguen los umbrales de REBA. Todos los umbrales están en `js/config.js` (`VALIDACION`) y son convenciones iniciales a calibrar con un ergónomo.

### Clave de la API de Gemini

Al abrir la app se pide la clave. **Solo se guarda en la memoria de la pestaña**: no va a `localStorage`, cookies ni a la URL, y se envía únicamente en la cabecera `x-goog-api-key`. Al recargar, se vuelve a pedir. Sin clave funciona el escenario A.

Gemini 4 Argon (`gemini-4-argon`) no está disponible en el nivel gratuito. Los vídeos de menos de 14 MB se envían en la propia petición; los mayores, con la Files API.

## Filtros anti-oclusión

Son el escenario *A · Filtros mecánicos* y se configuran en `js/config.js` (`FILTROS`):

| Filtro | Qué descarta |
|---|---|
| Visibilidad | Puntos con visibilidad < 0,5 (siempre activo) |
| Longitud de hueso | Segmentos cuya longitud 3D se aleja más de un 30 % de su mediana en el vídeo |
| Coherencia 2D–3D | Segmentos que en 3D apuntan hacia arriba y en la imagen hacia abajo (o al revés), con más de 30° de margen |
| Rango fisiológico | Ángulos fuera del rango posible de cada articulación |
| Hampel | Valores atípicos frente a la mediana local (±0,5 s) |
| Saltos | Tramos de menos de 0,4 s separados por un cambio más rápido que la velocidad máxima plausible |
| Interpolación | Rellena huecos de menos de 0,3 s; los más largos se dejan vacíos |

El desplegable *Qué han descartado los filtros mecánicos* cuenta los fotogramas afectados por cada uno.

## Publicar en GitHub Pages

1. Crea un repositorio, por ejemplo `postura-poc`, y sube el contenido de esta carpeta a la rama `main`:
   ```bash
   git init && git add . && git commit -m "PoC postura desde vídeo"
   git branch -M main
   git remote add origin https://github.com/<organizacion>/postura-poc.git
   git push -u origin main
   ```
2. En GitHub, ve a **Settings › Pages › Build and deployment** y elige *Source: Deploy from a branch*, rama `main` y carpeta `/ (root)`.
3. En uno o dos minutos estará en `https://<organizacion>.github.io/postura-poc/`.

GitHub Pages sirve por HTTPS, que es lo que necesita el móvil para abrir la cámara desde el botón *Grabar con el móvil*.

> Si el repositorio es privado, Pages requiere un plan de pago de GitHub (Pro, Team o Enterprise). Con Enterprise puedes además restringir el acceso a los miembros de la organización.

## Probar en local

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```
No basta con abrir `index.html` con doble clic: los módulos ES y el WASM necesitan un servidor.

## Modo sin CDN (redes corporativas u offline)

Por defecto, el motor y mp4-muxer se descargan de `cdn.jsdelivr.net` y los modelos de `storage.googleapis.com`. Si la red los bloquea o prefieres no depender de terceros:

```bash
./scripts/descargar-dependencias.sh   # copia el motor WASM, los 3 modelos y mp4-muxer a ./vendor (~50 MB)
```
Después pon `USE_LOCAL_ASSETS = true` en `js/config.js` y sube también la carpeta `vendor/`.

## Cómo grabar

- Móvil **recto y estable**, en trípode o apoyado. La vertical de la cámara es la referencia del ángulo del tronco.
- Cámara **perpendicular al plano del movimiento**: de lado para la flexión de tronco, cadera y rodilla.
- El trabajador **entero en el encuadre**, a 3–5 m, con buena luz y una sola persona en plano.
- Los iPhone graban en HEVC por defecto, y Chrome en Windows puede no leerlo. En ese caso, usa Safari o activa *Ajustes › Cámara › Formatos › Más compatible*. Los AVI de cámara (Motion JPEG) tampoco se reproducen: conviértelos a MP4 H.264.

## Estructura

```
index.html            Interfaz
css/styles.css        Estilos (claro y oscuro, adaptados a móvil)
js/config.js          Versiones, URLs de modelos y umbrales
js/pose.js            Motor de pose: carga de MediaPipe y recorrido del vídeo
js/angles.js          Definición y cálculo de ángulos, suavizado y estadísticas
js/filters.js         Filtros anti-oclusión
js/gemini.js          Cliente de la API de Gemini (clave solo en memoria)
js/argon.js           Escenarios B y C: instrucciones, esquemas de salida y combinación con A
js/overlay-video.js   Vídeos MP4 con el esqueleto de MediaPipe (lado a lado y superpuesto)
js/review-policy.js  Política de decisión sobre la revisión de Argon (ocultaciones, lados, consenso)
js/camera.js          Orientación de la cámara y modo de ángulos recomendado (2D o 3D)
js/metrics.js         Métricas de estabilidad y coherencia para comparar bruto, reglas, Argon y combinado
js/validation.js      Validación estadística del vídeo (semáforo por método y por región)
js/charts.js          Gráficas temporales (canvas, sin dependencias)
js/render.js          Esqueleto sobre el vídeo y visor 3D
js/export.js          Exportación CSV y JSON
docs/LIBRERIAS.md     Análisis de librerías y recomendación por fases
prompts/              Instrucciones de Gemini 4 Argon (editables sin tocar el código)
docs/ROADMAP.md       Hoja de ruta hacia la skill de REBA, RULA y OWAS
docs/articulo/        Hallazgos para un artículo de divulgación
scripts/              Descarga de dependencias para el modo sin CDN
```

## Definición de los ángulos

Todos los ángulos están en grados y sin signo; 0° corresponde a la postura neutra.

| Ángulo | Cálculo |
|---|---|
| Tronco | Vector cadera→hombros (puntos medios) respecto a la vertical de la cámara |
| Cuello (aprox.) | Vector hombros→orejas respecto al eje del tronco. En postura neutra tiene un desfase de unos 15–20° que habrá que calibrar |
| Hombro | Brazo (hombro→codo) respecto al tronco hacia abajo, es decir, la elevación del brazo |
| Codo | 180° menos el ángulo hombro‑codo‑muñeca |
| Cadera | 180° menos el ángulo hombro‑cadera‑rodilla |
| Rodilla | 180° menos el ángulo cadera‑rodilla‑tobillo |

Un ángulo se descarta (aparece como vacío) si alguno de sus puntos tiene una visibilidad inferior a 0,5.

## Formato de los datos (`postura/v1`)

```json
{
  "meta": { "fileName": "...", "duracion_s": 12.3, "width": 1080, "height": 1920,
            "fpsAnalizados": 15, "modelo": "pose_landmarker_full", "delegate": "GPU", ... },
  "landmarks": ["nariz", "...", "pie_dch"],
  "frames": [ { "t": 0.0667,
                "lm":  [[x, y, z, visibilidad], ...],
                "wlm": [[x_m, y_m, z_m, visibilidad], ...] } ]
}
```

- `lm` son coordenadas normalizadas a la imagen (de 0 a 1).
- `wlm` son metros con el origen en el centro de la cadera, con Y hacia abajo.

## Licencias de terceros

- MediaPipe Tasks Vision y los modelos Pose Landmarker: Apache 2.0 (Google).
