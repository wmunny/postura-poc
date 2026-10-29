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

## 5. La IA como revisora (C)

- **Cómo funciona**: se genera un vídeo con el original y el esqueleto de MediaPipe lado a lado. Gemini 4 Argon lo ve y señala, por articulación y tramo, dónde el esqueleto está **mal colocado** o la articulación **no se ve**. El código (no la IA) quita esos puntos y rellena solo los huecos cortos; los largos se dejan vacíos para no inventar datos.
- **Qué comparamos**:
  1. MediaPipe **en bruto**.
  2. MediaPipe con **filtros mecánicos** (reglas fijas, gratis, instantáneas, deterministas).
  3. MediaPipe con **filtro inteligente** de Gemini 4 Argon.

### Primer resultado (270 fotogramas, 10 por segundo; Argon: 36 s y 8.915 tokens)

**a) La cobertura aparente era falsa.** MediaPipe daba valores en el **74 %** de los fotogramas (media de las 10 articulaciones). Tras la revisión de Argon quedan en el **50 %**: una cuarta parte de los datos eran articulaciones **inventadas** (codos y muñecas tapados por el torso, tobillos detrás de las mesas, la oreja oculta de perfil). Con las reglas mecánicas la cobertura apenas bajaba (71 %): las reglas no los detectan.

**b) Reglas e IA detectan errores distintos.** Valores en bruto que quita o cambia cada método:

| | Fotogramas |
|---|---|
| Solo las reglas mecánicas | 53 |
| Solo Argon | 686 |
| Los dos | 49 |

- Las **reglas** cazan lo **físicamente imposible**: saltos más rápidos de lo que el cuerpo puede hacer, huesos que cambian de longitud y ángulos fuera de rango.
- La **IA** caza lo **plausible pero inventado**: un codo bien dibujado, con una longitud y un ángulo razonables, que en la imagen no se ve. Ninguna regla puede detectarlo, porque es coherente.
- Conclusión: **no compiten, se complementan**. La propuesta es combinarlas.

**c) Argon describe bien el vídeo.** Resumen literal: *«La estimación del esqueleto es deficiente durante la mayor parte del vídeo debido a las constantes autooclusiones (el trabajador actúa de espaldas o de perfil a la cámara)… El fallo más recurrente es la invención de articulaciones del miembro superior que están ocultas tras el torso.»*

**d) Tres lecciones de diseño** (errores nuestros, corregidos en la versión 0.5):
- **Efecto cascada**: rechazar un solo punto tumbaba todos los ángulos que lo usan. El tronco bajó del 96 % al 71 % solo porque se rechazó el hombro izquierdo, aunque el tronco se veía perfectamente con el lado derecho. Hay que calcular con el **lado visible**.
- **Borrar no siempre es corregir**: Argon marcó como «mal colocado» el hombro izquierdo mientras el trabajador pulsa el cuadro eléctrico, y la postura de más riesgo del vídeo desapareció de la serie, aunque el propio Argon dice que el brazo está por encima de 90°. Hace falta un punto intermedio: **posición aproximada, pero postura correcta**, útil para las categorías de REBA aunque no para los grados exactos.
- **Una métrica mal definida engaña**: la «fluctuación» empeoraba al limpiar porque, al quitar puntos, la serie se trocea y los bordes de las interpolaciones generan cambios bruscos. Hay que medirla solo dentro de tramos continuos y sin valores interpolados.

**e) La grabación pesa más que el algoritmo.** Con el trabajador de espaldas, una sola cámara, baja resolución y obstáculos en primer plano, ningún método puede medir lo que no se ve. El valor de la IA aquí es **decir con honestidad qué parte del vídeo sirve**.

## 5 bis. Reglas + IA combinadas (D) y semáforo de validez del vídeo

**Cómo funciona la combinación**: primero Argon quita lo inventado (y marca como *aproximado* lo que está desplazado pero con la postura correcta); después las reglas mecánicas quitan lo imposible; al final se rellenan solo los huecos de menos de 1 s. Además, si un lado del cuerpo está rechazado, el ángulo se calcula con el lado visible.

**Resultado** (mismo vídeo, 405 fotogramas a 15 por segundo, ángulos 2D, con los veredictos que dio Argon en la primera ejecución de C):

| Método | Fluctuación (°/s) | Saltos imposibles | Cobertura |
|---|---|---|---|
| MediaPipe en bruto | 40 | 25 | 73 % (aparente) |
| Solo reglas mecánicas | 32 | 4 | 71 % |
| Solo Argon | 39 | 23 | 57 % |
| **Reglas + Argon** | **31** | **4** | **56 %** (respaldada por la imagen) |

- La combinación consigue **la estabilidad de las reglas** (−23 % de fluctuación, −84 % de saltos) **y la honestidad de la IA** (quita la cuarta parte de datos inventados que las reglas no ven). Ninguno de los dos lo logra solo.
- Calcular con el **lado visible** recupera el tronco del 71 % al 98 %, y el cuello del 67 % al 89 %.
- Si el hombro izquierdo del cuadro eléctrico se marca como *aproximado* en lugar de *mal colocado* (simulación: reclasificamos ese tramo a mano; la nueva versión se lo pide a Argon), su cobertura pasa del 5 % al 27 %, y la postura de riesgo deja de desaparecer.
- Efecto secundario instructivo: cambiar de cálculo (de dos lados a uno) introduce pequeños saltos que las reglas limpian. Otro motivo para combinar.

**Semáforo de validez** (sobre Reglas + Argon):

| Método | Veredicto | Por qué |
|---|---|---|
| REBA (peor postura) | 🔴 | Los brazos casi no se ven: hombro izquierdo en el 5 % del vídeo, ausente en las fases de riesgo alto. La muñeca no se medía (ver 5 ter) |
| RULA (peor postura) | 🔴 | Lo mismo; se podría evaluar solo el lado que se vea bien, pero aquí tampoco el derecho llega |
| OWAS (% del tiempo) | 🔴 | El vídeo es corto: el % de tiempo con el tronco en riesgo tiene un margen de ±33 puntos; para ±10 harían falta unos 5 minutos de grabación |

- Por regiones: **tronco y cuello en verde** para la peor postura (se ven en todas las fases); **piernas y brazos en rojo**.
- El sistema **dice no**, explica por qué y propone cómo grabar: «Pon la cámara en el lado izquierdo del trabajador o añade una segunda cámara: de espaldas o de perfil derecho, el torso tapa este brazo.»

## 5 ter. La muñeca: lo que una cámara no mide, la IA lo clasifica

- MediaPipe Pose apenas ve las manos: en el vídeo de prueba, la muñeca izquierda es visible en el 35 % de los fotogramas y la derecha en el 51 %, y sus puntos son demasiado toscos para medir grados.
- REBA y RULA no necesitan grados exactos de muñeca, sino **categorías**: neutra, hasta 15°, más de 15°, desviada y girada.
- Por eso se lo pedimos a Gemini 4 Argon **por fases y lados, con su nivel de confianza**, y con la instrucción de decir «no visible» en lugar de adivinar.
- Entra en el semáforo: en REBA cuentan las dos muñecas; en RULA basta con el lado que se vea bien.
- Es otra forma de combinar: la visión clásica mide lo que ve bien; la IA clasifica lo que solo se puede juzgar mirando, y dice cuándo no puede.

*(Pendiente: resultados con la API real y variación entre ejecuciones.)*

## 6 bis. Validación estadística del vídeo

La pregunta no es «¿qué porcentaje de fotogramas se ve?», sino **«¿cambiaría la conclusión ergonómica por lo que no se ve?»**:

- Lo que no se ve **no es aleatorio**: un brazo se oculta precisamente en ciertas posturas (de espaldas, vaciando, manipulando). Un 80 % de cobertura puede dejar fuera justo la fase de más riesgo.
- Los fotogramas consecutivos no son observaciones independientes: 405 fotogramas de 27 s equivalen a unas pocas decenas de observaciones reales.
- Referencia clásica: el **muestreo del trabajo** (*work sampling*) de la ingeniería industrial, que fija cuántas observaciones independientes hacen falta para estimar un porcentaje de tiempo con un margen dado.

Cinco comprobaciones por articulación, agrupadas por región del cuerpo (las de REBA):

1. **Cobertura** tras la limpieza.
2. **Cobertura por fase** de la tarea (las fases y su riesgo las da Argon): perder entera una fase de riesgo alto es rojo aunque la cobertura global sea alta.
3. **Muestra efectiva**: observaciones independientes según el tiempo de decorrelación de la serie, y margen de error del % de tiempo en postura de riesgo.
4. **Peor y mejor caso**: % de tiempo en postura de riesgo si todo lo que no se ve estuviera, o no, en esa postura. Si la conclusión no cambia, el vídeo vale aunque falten datos.
5. **Pico**: ¿puede estar oculta la peor postura en un hueco largo?

Dos perspectivas, según el método: **peor postura** (REBA, RULA: 1, 2 y 5) y **% del tiempo** (OWAS: 1 a 4). El veredicto es por método: un mismo vídeo puede valer para uno y no para otro. Los umbrales son convenciones iniciales, a calibrar con un ergónomo.

## 6. Lecciones

1. **Medir y entender son tareas distintas.** Los modelos de pose miden; los modelos multimodales entienden. Pedirle a uno el trabajo del otro sale mal.
2. **Comprobar es más fácil que localizar.** A un modelo de lenguaje le cuesta decir dónde está un codo, pero le resulta más fácil decir si un esqueleto dibujado está bien colocado.
3. **Hacer visible lo que ve la IA.** Dibujar su esqueleto sobre el vídeo desmontó en segundos una impresión que sus textos, muy convincentes, transmitían.
4. **Las reglas fijas también se equivocan.** Borraron una postura de riesgo real.
5. **Las puntuaciones, siempre en código.** La IA aporta contexto y revisión; REBA, RULA y OWAS se calculan con tablas y pruebas, de forma reproducible.
6. **Reglas e IA se complementan.** Las reglas detectan lo imposible; la IA, lo plausible pero inventado. Casi no coinciden.
7. **Una cobertura alta puede ser falsa.** El 74 % de MediaPipe era, en realidad, un 50 % respaldado por la imagen.
8. **Antes de evaluar, validar el vídeo.** Un semáforo estadístico evita puntuar un riesgo con datos que no representan la tarea.

## 7. Límites (para decirlos en el artículo)

- Un solo vídeo, de baja resolución y con el trabajador de espaldas casi todo el tiempo.
- Sin referencia medida a mano: las métricas de C miden **estabilidad y coherencia**, no exactitud. El siguiente paso es anotar 15–20 fotogramas con un ergónomo.
- No es una herramienta validada de evaluación de riesgos.

## 8. Material gráfico

- [ ] Captura: esqueleto de MediaPipe frente al de Argon (B) en la pila del fondo (20 s), con el muñeco de Argon más grande y simétrico.
- [ ] Captura: fotograma del cuadro eléctrico (14 s) con el brazo realmente levantado.
- [ ] Gráfica: hombro izquierdo en bruto, con filtros mecánicos y con la revisión de Argon.
- [ ] Vídeo corto: esqueleto superpuesto y tramos corregidos por Argon.
- [ ] Tabla resumen de la ganancia: bruto, reglas, Argon y Reglas + Argon.
- [ ] Captura del semáforo de validez (métodos y regiones) y de los consejos de grabación.
- [ ] Captura del anillo ámbar (punto aproximado) y la cruz roja (punto rechazado) sobre el vídeo.

## 9. Privacidad y ética

- **Difuminar la cara** del trabajador en capturas y vídeos, y contar con su **consentimiento** para publicarlos.
- En B y C el vídeo se envía a la API de Google: con vídeos reales, revisarlo antes con protección de datos.
- No mencionar a la empresa ni el puesto concreto si no hay autorización.
