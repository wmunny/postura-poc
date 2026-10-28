# Postura desde vídeo · PoC Vítaly

Prueba de concepto de la **Fase 1 (percepción)** del modelo biomecánico de Vítaly. A partir de un vídeo grabado con el móvil, la web:

1. Estima la **postura fotograma a fotograma**: 33 puntos clave en 2D y 3D (MediaPipe Pose Landmarker).
2. Dibuja el **esqueleto sobre el vídeo** y en un **visor 3D** que se puede girar.
3. Calcula los **ángulos articulares** de tronco, cuello, hombros, codos, caderas y rodillas, en dos modos: plano de imagen (2D) o estimación 3D.
4. Muestra la **evolución temporal** de cada ángulo y un **resumen estadístico** (media, mediana, P95, mínimo, máximo y cobertura).
5. **Exporta** los ángulos (CSV), los puntos clave (CSV) y los datos completos (JSON, formato `postura/v1`) para las fases siguientes (REBA, RULA, OWAS, NIOSH, OpenSim…).

**Todo se procesa en el navegador.** El vídeo no se sube a ningún servidor.

> Es una prueba de concepto, no una herramienta de evaluación validada. Consulta las limitaciones en [`docs/LIBRERIAS.md`](docs/LIBRERIAS.md).

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

Por defecto, el motor se descarga de `cdn.jsdelivr.net` y los modelos de `storage.googleapis.com`. Si la red los bloquea o prefieres no depender de terceros:

```bash
./scripts/descargar-dependencias.sh   # copia el motor WASM y los 3 modelos a ./vendor (~50 MB)
```
Después pon `USE_LOCAL_ASSETS = true` en `js/config.js` y sube también la carpeta `vendor/`.

## Cómo grabar

- Móvil **recto y estable**, en trípode o apoyado. La vertical de la cámara es la referencia del ángulo del tronco.
- Cámara **perpendicular al plano del movimiento**: de lado para la flexión de tronco, cadera y rodilla.
- El trabajador **entero en el encuadre**, a 3–5 m, con buena luz y una sola persona en plano.
- Los iPhone graban en HEVC por defecto, y Chrome en Windows puede no leerlo. En ese caso, usa Safari o activa *Ajustes › Cámara › Formatos › Más compatible*.

## Estructura

```
index.html            Interfaz
css/styles.css        Estilos (claro y oscuro, adaptados a móvil)
js/config.js          Versiones, URLs de modelos y umbrales
js/pose.js            Motor de pose: carga de MediaPipe y recorrido del vídeo
js/angles.js          Definición y cálculo de ángulos, suavizado y estadísticas
js/charts.js          Gráficas temporales (canvas, sin dependencias)
js/render.js          Esqueleto sobre el vídeo y visor 3D
js/export.js          Exportación CSV y JSON
docs/LIBRERIAS.md     Análisis de librerías y recomendación por fases
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
