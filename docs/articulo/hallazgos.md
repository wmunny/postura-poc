# Hallazgos para el artículo: medir posturas de trabajo desde un vídeo de móvil

*Borrador de trabajo, 29 de octubre de 2026. Base para un artículo de LinkedIn. Las cifras salen de la PoC [`postura-poc`](https://wmunny.github.io/postura-poc/) y de un único vídeo real, así que son indicios, no conclusiones validadas.*

## Idea central

> Un modelo de visión con lenguaje **entiende** la escena, pero **no mide** el cuerpo. La visión artificial clásica mide, pero se equivoca cuando no ve. La combinación útil no es pedirle ángulos a la IA generativa, sino ponerla a **revisar** lo que mide la visión clásica.

## 1. El problema

- Las evaluaciones ergonómicas (REBA, RULA, OWAS) necesitan ángulos articulares: tronco, cuello, hombros, codos, caderas y rodillas.
- Medirlos a mano sobre un vídeo es lento. Estimarlos con visión artificial desde **una sola cámara** (un móvil) es rápido y barato, pero tiene un punto débil: las **oclusiones**. Cuando el trabajador está de espaldas o una máquina le tapa un brazo, el modelo no se detiene: **se inventa** la articulación.
- Una postura inventada puede cambiar el nivel de riesgo de una tarea.

## 2. El experimento

- **Vídeo**: 27 s, cámara fija, 640×480, en un taller real. El trabajador lleva una cubeta con piezas a una centrífuga, la vacía inclinado, cierra la tapa, pulsa un cuadro eléctrico situado alto y se va a una pila del fondo. Está de espaldas a la cámara gran parte del tiempo.
- **Tres enfoques**:
  - **A · MediaPipe Pose** (Google, código abierto): 33 puntos del cuerpo en 2D y 3D, fotograma a fotograma, en el propio navegador. Se analizaron 405 fotogramas (15 por segundo).
  - **B · Gemini 4 Argon solo**: el modelo multimodal ve el vídeo (2 fotogramas por segundo) y da los ángulos, la posición de cada articulación y el contexto de la tarea.
  - **C · Combinado**: MediaPipe mide y Gemini 4 Argon revisa (ver apartado 5).

## 3. Hallazgos con MediaPipe (A)

- Detecta a la persona en el **95 %** de los fotogramas, con una visibilidad media del **88 %** en tronco y piernas.
- Pero en las articulaciones que quedan tapadas la cobertura útil cae mucho: **codo izquierdo 30 %**, codo derecho 50 %, rodilla izquierda 56 %.
- Probamos **filtros mecánicos** (reglas fijas): longitud de los huesos constante, coherencia entre la imagen y el 3D, rango fisiológico, valores atípicos y saltos imposibles.
- **Sorpresa útil**: al principio atribuimos a una oclusión un hombro izquierdo a ~155° entre los segundos 12 y 17. Al mirar los fotogramas, era **real**: el trabajador pulsa un cuadro eléctrico por encima de su cabeza. Los filtros mecánicos descartaban buena parte de ese tramo, que es justo uno de los más relevantes para el riesgo.
  - Lección: **una regla fija no sabe qué está haciendo el trabajador**. Puede borrar la postura de riesgo que se quería medir.

## 4. Hallazgos con Gemini 4 Argon solo (B)

### Lo que hace muy bien: el contexto

Sin que se lo explicáramos, describió la tarea y sus fases con tiempos, estimó la carga (~8–10 kg), el agarre, los tramos con torsión e inclinación lateral del tronco y las oclusiones. Y señaló el problema ergonómico principal:

> «El cuadro está situado demasiado alto, obligando a mantener una postura estática con el hombro izquierdo en flexión/abducción superior a 110° durante 6 segundos; el trabajador compensa la fatiga apoyando el peso del torso sobre su brazo derecho.»

Eso no lo da ningún modelo de pose.

### Lo que no hace: medir

Le pedimos que marcara dónde está cada articulación en cada fotograma y lo dibujamos sobre el vídeo junto al esqueleto de MediaPipe (**ver capturas**). Comparando 579 pares de puntos:

| Medida | Resultado |
|---|---|
| ¿Sabe dónde está la persona? | Sí: el centro del cuerpo cae a ~20 px del de MediaPipe y sigue sus desplazamientos (correlación 0,94) |
| ¿Distingue las fases? | Sí: entre 12 y 17 s pone el brazo izquierdo por encima del hombro |
| Error por articulación | Mediana **35 px**, el 10 % peor > 67 px (en una persona de ~200 px de alto: más del 15 % de su estatura) |
| Tamaño del esqueleto | **37 % más grande** que el cuerpo real |
| ¿Observa o rellena? | En los segundos 12, 14 y 16 da **exactamente** la misma postura; en un tercio de los pares izquierda–derecha pone ambas articulaciones a la misma altura exacta: un **muñeco simétrico** colocado encima |
| ¿Admite lo que no ve? | Solo deja vacíos el 9 % de los puntos, aunque el trabajador está de espaldas buena parte del vídeo |
| Reproducibilidad | Dos ejecuciones sobre el mismo vídeo: carga 8 kg frente a 10 kg; agarre «regular» frente a «bueno»; hombro «> 110°» frente a «> 150°» |

Además, sus ángulos **aplastan los extremos**: el percentil 95 de B es menor que el de MediaPipe en casi todas las articulaciones (tronco 38° frente a 48°; rodilla 16° frente a 33°). En REBA y RULA son precisamente los extremos los que puntúan.

**Conclusión de B**: Gemini 4 Argon razona como un técnico que mira el vídeo y dice «unos 45°». Útil para entender la tarea; no válido como goniómetro.

## 5. El enfoque combinado (C): la IA como revisora

*Pendiente de resultados.*

- **Cómo funciona**: se genera un vídeo con el original y el esqueleto de MediaPipe lado a lado. Gemini 4 Argon lo ve y señala, por articulación y tramo, dónde el esqueleto está **mal colocado** o la articulación **no se ve**. El código (no la IA) quita esos puntos y rellena solo los huecos cortos; los largos se dejan vacíos para no inventar datos.
- **Qué comparamos**:
  1. MediaPipe **en bruto**.
  2. MediaPipe con **filtros mecánicos** (reglas fijas, gratis, instantáneas, deterministas).
  3. MediaPipe con **filtro inteligente** de Gemini 4 Argon.
- **Métricas**: estabilidad (cambio medio entre fotogramas), saltos imposibles, posturas fuera de rango, cobertura, fotogramas corregidos y coincidencia entre lo que quitan las reglas y lo que quita Argon.
- **Pregunta que responde**: ¿hace falta una IA o bastan unas reglas?

*(Rellenar con los resultados.)*

## 6. Lecciones

1. **Medir y entender son tareas distintas.** Los modelos de pose miden; los modelos multimodales entienden. Pedirle a uno el trabajo del otro sale mal.
2. **Comprobar es más fácil que localizar.** A un modelo de lenguaje le cuesta decir dónde está un codo, pero le resulta más fácil decir si un esqueleto dibujado está bien colocado.
3. **Hacer visible lo que ve la IA.** Dibujar su esqueleto sobre el vídeo desmontó en segundos una impresión que sus textos, muy convincentes, transmitían.
4. **Las reglas fijas también se equivocan.** Borraron una postura de riesgo real.
5. **Las puntuaciones, siempre en código.** La IA aporta contexto y revisión; REBA, RULA y OWAS se calculan con tablas y pruebas, de forma reproducible.

## 7. Límites (para decirlos en el artículo)

- Un solo vídeo, de baja resolución y con el trabajador de espaldas casi todo el tiempo.
- Sin referencia medida a mano: las métricas de C miden **estabilidad y coherencia**, no exactitud. El siguiente paso es anotar 15–20 fotogramas con un ergónomo.
- No es una herramienta validada de evaluación de riesgos.

## 8. Material gráfico

- [ ] Captura: esqueleto de MediaPipe frente al de Argon (B) en la pila del fondo (20 s), con el muñeco de Argon más grande y simétrico.
- [ ] Captura: fotograma del cuadro eléctrico (14 s) con el brazo realmente levantado.
- [ ] Gráfica: hombro izquierdo en bruto, con filtros mecánicos y con la revisión de Argon.
- [ ] Vídeo corto: esqueleto superpuesto y tramos corregidos por Argon.
- [ ] Tabla resumen de la comparativa A en bruto, filtros mecánicos y C.

## 9. Privacidad y ética

- **Difuminar la cara** del trabajador en capturas y vídeos, y contar con su **consentimiento** para publicarlos.
- En B y C el vídeo se envía a la API de Google: con vídeos reales, revisarlo antes con protección de datos.
- No mencionar a la empresa ni el puesto concreto si no hay autorización.
