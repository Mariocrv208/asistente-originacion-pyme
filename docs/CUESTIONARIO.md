# Cuestionario técnico

**Nombre del aspirante:** _______________________ **Teléfono:** _______________________

> Las referencias a archivos apuntan a la implementación de este mismo
> repositorio, donde la decisión está tomada y verificada.

---

## 1. Bases de datos

### 1.1 HNSW frente a IVFFlat con 5 M de fragmentos, filtro por tenant y fecha, y alta rotación diaria

IVFFlat necesita entrenarse: sus listas salen de un k-means sobre los datos del
momento. Con altas y bajas diarias los centroides dejan de representar el corpus,
el recall cae de forma silenciosa y hay que reindexar periódicamente. HNSW es
incremental —insertar es añadir al grafo— y da mejor relación recall/latencia,
a cambio de más memoria y construcción más lenta; su punto débil aquí son los
borrados, que quedan como tumbas y degradan el grafo hasta el siguiente vacuum.
Con rotación diaria elijo **HNSW**.

El filtrado combinado es el problema real. **Filtrar después** de recuperar los k
primeros es un desastre para el tenant pequeño: los k vecinos globales pertenecen
casi todos a otros tenants y el filtro los elimina, devolviendo cero resultados
aunque existan documentos relevantes. **Filtrar antes** es correcto pero pierde el
índice: recorrer 5 M de filas exactas por cada consulta no es viable.

La salida es no tener un único índice global: **particionar por `tenant_id`** con
un índice HNSW por partición, y la fecha como columna con índice btree dentro de
cada partición. Cada tenant busca solo en su espacio, así que el pequeño hace
recorrido casi exacto y el grande usa su grafo. Como red de seguridad,
`hnsw.iterative_scan` de pgvector 0.8 para que el motor siga recorriendo cuando
el filtro descarta demasiado.

**Cómo mediría el recall:** construyo la verdad de referencia con KNN exacto
—recorrido secuencial, índices desactivados— sobre una muestra de consultas
reales, y calculo `recall@k = |aproximado ∩ exacto| / k`. Lo segmento por tamaño
de tenant, porque el promedio esconde justo el caso que falla, y lo repito
después de cada ciclo de rotación para detectar la degradación por tumbas.

### 1.2 Reserva de cupo concurrente e idempotencia

El nivel por defecto de PostgreSQL es **READ COMMITTED**. Garantiza que no leo
datos no confirmados y que cada sentencia ve una instantánea coherente al
empezar. **No** garantiza que lo leído siga siendo cierto al escribir: dos
transacciones que leen «queda 1» y luego restan 1 pierden una actualización, sin
error y sin conflicto. Es exactamente este escenario.

La escritura correcta es no leer y luego escribir, sino **decidir en la propia
sentencia**: `UPDATE cupos SET disponibles = disponibles - 1 WHERE id = $1 AND
disponibles > 0 RETURNING disponibles`. El bloqueo de fila serializa a los dos
usuarios y el que llega segundo no afecta ninguna fila, así que se entera. Para
la idempotencia, la transacción inserta la transacción con una
`clave_idempotencia` con restricción única y `ON CONFLICT DO NOTHING RETURNING`;
si no devuelve fila, se lee la existente y se responde lo mismo que la primera vez.

**Si el reintento lo dispara el LLM**, el control optimista con reintentos no
basta, porque el modelo no reintenta: vuelve a pedir. Genera una invocación nueva
y, si la clave saliera de él, sería otra clave, no habría colisión y se reservaría
dos veces. **La clave la genera el servidor**, derivada de algo estable —en este
proyecto, `sha256(id_solicitud + id_ejecucion)`, en
`domain/dictamenes/persistir.ts`—. El modelo no puede generarla porque no tiene
noción de «el mismo intento»: no distingue reintento de petición nueva, y sus
salidas no son deterministas.

### 1.3 Cuatro formas de precalcular indicadores, y qué datos refleja un dictamen corregido

**Vista materializada:** correcta solo tras `REFRESH`; entre refrescos sirve datos
viejos sin avisar. `CONCURRENTLY` exige índice único y es caro. Invalidación cara
y por lotes. Buena para agregados pesados, mala para frescura por fila.
**Columna generada `STORED`:** siempre correcta, la calcula el motor al escribir,
coste de invalidación **cero** y a prueba de concurrencia; limitada a expresiones
inmutables de la propia fila. **Tabla con trigger:** flexible y puede cruzar filas,
pero la corrección bajo concurrencia pasa a ser tuya y aparecen interbloqueos con
actualizaciones parciales. **Caché en aplicación:** la lectura más rápida y la
corrección peor; la invalidación es un problema distribuido y dos procesos pueden
escribir valores distintos.

Aquí elegí **tabla materializada por la aplicación con invalidación por trigger**
(`db/migrations/0003`), y descarté la columna generada aunque era la más segura:
el punto 5.3.1 exige el cálculo en código, y sobre todo una columna generada sería
una segunda implementación capaz de discrepar en silencio de
`calcular_indicadores`, que es justo lo que G2 existe para impedir. La
invalidación es la **ausencia de fila**: el trigger la borra al cambiar una
entrada, así que no existe el estado «calculado pero obsoleto».

**Si el estado financiero se corrige después de emitido el dictamen, el dictamen
debe seguir reflejando los datos del momento de emisión.** Una decisión
justificada con cifras que ya no existen es inauditable: nadie podría comprobar si
fue razonable. Se modela **congelando** los indicadores en la fila del dictamen
—columnas `ind_*`— y guardando la corrección como una versión nueva del estado
financiero, nunca sobrescribiendo. Los datos vigentes sirven para el próximo
dictamen, no para reescribir el anterior.

---

## 2. Backend

### 2.1 Endpoint de chat sobre un LLM: streaming, timeouts, reintentos e idempotencia

Streaming por SSE sobre HTTP, con el flujo escrito directamente al socket
(`http/rutas/analizar.ts`). Los timeouts no pueden ser uno solo: **conexión**,
**tiempo hasta el primer token** y **inactividad entre fragmentos**. Un límite
total mata generaciones largas legítimas; el de inactividad es el que detecta a un
proveedor colgado, que es el fallo real.

Los reintentos solo son seguros **antes de emitir el primer byte al cliente**.
Una vez que has enviado texto, reintentar duplica contenido. Por eso la cascada de
modelos de este proyecto actúa en la llamada, no a mitad del flujo.

Para la idempotencia, el cliente manda un identificador de petición y el servidor
acumula la salida asociada a él según fluye; una reconexión con el mismo
identificador reanuda desde el desplazamiento ya entregado.

**El caso incómodo —el proveedor generó, cobró, y el cliente no recibió la cola—
no se reintenta.** Reintentar paga dos veces y le muestra al usuario texto
duplicado. Si persististe el flujo, **reanudas** reenviando solo el sufijo que
falta: es correcto y no cuesta nada. Si no lo persististe, **descartas** marcando
el mensaje como incompleto y dejando que el usuario pida continuar; regenerar en
silencio produce una respuesta distinta a la que ya se pagó. La decisión de diseño
es persistir el flujo mientras corre, precisamente para que «reanudar» esté
siempre disponible: cuesta almacenamiento y evita pagar dos veces.

### 2.2 Riesgos de una herramienta que consulta la base de clientes, y el ataque que sigue vivo

**Inyección de instrucciones:** un campo escrito por el cliente —notas, dirección,
destino de fondos— contiene texto dirigido al agente. **Exfiltración:** el agente
resume y arrastra datos personales a una respuesta que acaba fuera, o la
herramienta cruza la frontera de un tenant. **Abuso de herramienta:** el agente
llama con un filtro ensanchado y vuelca la tabla.

Mitigaciones de arquitectura, no de prompt: **(1)** la herramienta corre con la
autorización del usuario, no la del servicio —seguridad a nivel de fila acotada a
la sesión—, así que un filtro ensanchado no devuelve nada extra; **(2)** el
contrato es estrecho: acepta un identificador, no un `WHERE`, y jamás SQL libre;
**(3)** topes de salida en la propia herramienta: número de filas, lista blanca de
columnas y redacción de datos personales; **(4)** el contenido no confiable viaja
delimitado y nunca concatenado con instrucciones; **(5)** la respuesta solo puede
salir hacia la sesión que la pidió.

**Contra mi propia solución:** todo eso no impide el ataque más barato. Quien
pueda escribir en un registro de cliente puede redactar un texto que **parezca
evidencia legítima** y sesgar qué documentos recupera el agente y cómo los resume,
sin exfiltrar nada y sin desobedecer ninguna instrucción. La seguridad a nivel de
fila no ayuda: esos datos son legítimamente visibles. Es envenenamiento del
razonamiento, no del acceso, y mis mitigaciones no lo tocan. Lo que reduce el daño
es que la decisión final se apoye en cálculo determinista y citas verificables
—como aquí—, no en lo que el modelo leyó.

### 2.3 De 400 MB a 3 GB con picos periódicos de p99 en Node

V8 tiene montículo generacional: **nueva** (dos semiespacios, recolector de copia,
muy frecuente y barato) y **vieja** (marcado incremental concurrente y barrido, con
una pausa atómica final). Los `Buffer` viven **fuera** del montículo de JavaScript,
así que una fuga de buffers no aparece como crecimiento de `heapUsed`.

El patrón descrito —media estable, p99 con picos periódicos— es la firma del
recolector mayor. El marcado avanza concurrentemente, pero **la pausa final escala
con el conjunto vivo**. Si el caché de embeddings crece sin cota, cada recolección
mayor tarda más y produce picos regulares que no mueven la media.

**Cómo los distingo.** _Fuga real_: el conjunto retenido crece de forma monótona y
sobrevive a una recolección forzada; dos instantáneas del montículo comparadas por
retenedores lo señalan. _Caché sin cota_: crece igual, pero la retención es
intencional y en la instantánea aparece como un `Map` con N entradas; la
diferencia con la fuga no es la forma sino si algo desaloja alguna vez.
_Fragmentación_: la RSS crece mientras `heapUsed` se mantiene plano —`heapUsed`
muy por debajo de `heapTotal`, o RSS muy por encima de `heapTotal`—, típico de
arenas de `malloc` con buffers de tamaños variados.

**Palancas:** `--max-semi-space-size` (una nueva generación mayor evita promover
objetos efímeros del streaming, que es de donde viene la presión aquí),
`--max-old-space-size`, `--trace-gc` y el observador de GC de `perf_hooks` para
medir las pausas, e instantáneas del montículo. Para fragmentación, cambiar el
asignador a jemalloc o limitar `MALLOC_ARENA_MAX`. La corrección de fondo es
acotar el caché por **bytes** y con expiración, no por número de entradas.

**Contraste:** en la BEAM cada proceso tiene su propio montículo y su propia
recolección, así que una sesión que acumula no provoca una pausa global — el
mismo fallo degradaría a un cliente, no al percentil 99 de todos.

### 2.4 Embeddings intensivos en CPU conviviendo con 200 conexiones en espera

La causa raíz es que **Node ejecuta JavaScript en un solo hilo**. Las 200
conexiones esperando respuesta externa no cuestan casi nada: son descriptores en
el bucle de eventos. Pero calcular un embedding es trabajo de CPU **síncrono**:
mientras corre, el bucle no avanza y ningún flujo abierto puede escribir un byte.
Una sola tarea de CPU congela las doscientas. No es contención de recursos, es
inanición del bucle.

**Rediseño:** sacar el cómputo del hilo principal a un **grupo de `worker_threads`**
dimensionado a núcleos menos uno, pasando los datos como `ArrayBuffer`
transferibles para no copiarlos. El hilo principal queda solo para E/S, que es
para lo que sirve.

**Contrapresión:** una cola acotada delante del grupo. Cuando se llena, no se
encola más: se rechaza rápido. La señal de saturación que vigilaría es la
**profundidad de cola y el tiempo de espera en ella**, no el uso de CPU, porque la
CPU ya estará al 100 % mucho antes de que el servicio se degrade.

**Qué recibe el usuario:** una respuesta inmediata y explícita —`429` con
`Retry-After`, o dentro del flujo un evento diciendo que el paso de embeddings no
está disponible y que se degrada a recuperación léxica—. Nunca una espera
silenciosa: un cliente que espera sin saber cuánto es peor que un rechazo claro.

### 2.5 60 000 excepciones por corrida, y una amortización recursiva

Lanzar en V8 cuesta porque **construir el `Error` captura la traza**: el motor
recorre los marcos de pila y materializa la estructura en el momento de crear el
objeto —solo difiere el formateo a texto hasta que se lee `.stack`—. Es trabajo
proporcional a la profundidad de pila, más asignación de un objeto con su mensaje
y sus marcos. Con 60 000 excepciones por corrida eso son 60 000 objetos efímeros:
sube la tasa de asignación, dispara recolecciones de la generación nueva, promueve
lo que sobrevive y aumenta la presión sobre el recolector mayor. Además el
desenrollado impide optimizaciones en el camino caliente.

**El coste está en el `throw`, no en el `try`**: entrar en un bloque `try` no
asigna nada; V8 resuelve los manejadores con tablas y el bloque en sí es
prácticamente gratis. Lo caro es crear el error, capturar la traza y desenrollar.

**Rediseño:** validar con una función que **devuelve un resultado**
—`{ ok: false, errores: [...] }`— en vez de lanzar; acumular los registros
inválidos en una lista y reportarlos al final. Un dato inválido en el 12 % de los
casos no es excepcional: es una salida esperada del proceso. Las excepciones se
reservan para lo que sí lo es, como que la base de datos no responda. Es
exactamente lo que hacen las herramientas de este proyecto, que devuelven el error
como valor y nunca lanzan hacia el modelo.

**Sobre la recursión:** una llamada por cuota con 240 meses abre 240 marcos. La
pila por defecto de V8 ronda 1 MB, así que 240 caben —pero el margen se agota en
cuanto el plazo crece o se añaden marcos por llamada, y el fallo llega como
`RangeError` en producción y con el plazo más largo. Peor: **cada hilo tiene su
propia pila**, así que el proceso nocturno con muchos workers multiplica esa
memoria. **V8 no optimiza la llamada de cola** —se especificó en ES2015 y solo
JavaScriptCore la implementó—, así que no hay red de seguridad. Por eso la tabla
de este proyecto se recorre de forma **iterativa**
(`domain/finanzas/amortizacion.ts`).

### 2.6 Cuota nivelada: por qué no punto flotante, y las tres decisiones que nadie documenta

El doble binario del IEEE 754 no puede representar 0.1 ni 0.01, y en Guatemala se
factura en centavos. El error es diminuto por operación y se acumula al recorrer
la tabla. **Ejemplo medido en este proyecto:** un crédito de Q100 000 a 240 meses
calculado en `number` termina con un saldo de **3.517223693790129** en vez de cero.
El cliente recibe un estado de cuenta con una deuda residual que nadie sabe
explicar, o la última cuota le cobra de más; en contabilidad es una partida que no
cuadra contra el mayor.

**Dónde redondear:** en dos puntos y solo dos. La cuota nivelada, una vez al final
de la fórmula de anualidad, y el interés de cada período, porque es lo que se
cobra y lo que se contabiliza. La potencia y la división intermedias van con 34
dígitos. Redondear dentro de la fórmula arrastra el error a las 360 cuotas; no
redondear nunca produce importes que no existen en centavos.

**Cómo repartir el residuo:** la **última** cuota amortiza todo el saldo restante y
su importe se recalcula como capital más interés. Por construcción, la suma de los
capitales es exactamente el principal y la suma de las cuotas es exactamente
capital más intereses. Va al final y no repartido entre las primeras porque «cuota
nivelada» es una promesa al cliente: todas las cuotas menos una son idénticas.
Medido dentro del envolvente real del producto —18 % y hasta 84 meses—, el peor
ajuste es de **Q0.58**.

**Qué regla:** **mitad al par**. Sobre 100 000 empates medidos, acumula **0.00** de
sesgo frente a los **+500.00** de mitad hacia arriba. En un proceso que corre sobre
cientos de miles de operaciones, redondear siempre hacia arriba en el empate es
dinero cobrado de más sin ninguna base.

**Almacenamiento:** `NUMERIC(18,2)` en PostgreSQL, y el parser de `NUMERIC` del
driver dejado en identidad para que el valor llegue como cadena y **nunca** pase
por `Number`. **`saldo == 0` es peligroso** porque con punto flotante nunca es
exactamente cero y el crédito queda vivo devengando intereses sobre una
millonésima de centavo; y aun con decimales exactos, `saldo === 0` compara
referencias de objeto y `equals(0)` puede fallar con `-0` o con otra escala. Por
eso existe `estaLiquidado()` y ningún otro punto del código compara saldos a mano.

---

## 3. Frontend

### 3.1 SSE o WebSockets, cancelación, y un segundo espectador

**SSE.** El flujo es unidireccional: el servidor cuenta lo que hace y el cliente
escucha. Un WebSocket daría un canal bidireccional que no se usa, a cambio de un
protocolo aparte, otro camino de autenticación y un estado de conexión que
mantener. SSE viaja sobre HTTP normal y hereda proxies, cabeceras y cancelación.

Con un matiz que importa: **no uso `EventSource`**, que es la API estándar de SSE.
Solo hace `GET`, no admite cuerpo ni cabeceras, y —lo grave— **reconecta sola**.
Aquí cada reconexión relanzaría una ejecución completa del agente, gastando cuota
y escribiendo dictámenes duplicados; la idempotencia los atraparía, pero estaría
pagando llamadas al modelo para descartarlas.

**La cancelación** se gestiona con `fetch` y `AbortController`: el analista aborta,
el socket se cierra, el servidor lo detecta en el socket de **respuesta** —no en el
de petición, cuyo `close` se dispara al terminar de leerse el cuerpo— y propaga la
señal hasta la llamada al proveedor, que corta la generación en curso.

**Con un segundo espectador** SSE sigue sirviendo, pero cambia el diseño: la
ejecución dejaría de estar atada a una petición HTTP y pasaría a publicar sus pasos
en un canal por sesión, con cada espectador suscrito por su propio SSE. Lo que
obliga a cambiar no es el transporte, es **la propiedad de la ejecución**: hoy la
ejecución es de quien abrió la petición, y tendría que pasar a ser del servidor.

### 3.2 40 tokens por segundo trabando la interfaz

A 40 tokens por segundo llega un fragmento cada ~25 ms y un fotograma dura 16,7 ms.
Si cada fragmento provoca un `setState` que reinterpreta **todo** el mensaje como
Markdown, el trabajo por fragmento es proporcional a la longitud acumulada: el
coste total del mensaje es cuadrático. React además reconcilia el subárbol del
mensaje en cada actualización. En cuanto el render supera el presupuesto del
fotograma, se pierden fotogramas.

**Por qué se traba el campo de entrada, que no forma parte del mensaje:** porque el
hilo principal es uno solo. Un render largo no solo retrasa su propio pintado,
retrasa **el procesamiento de eventos**: la pulsación de tecla espera a que el
render termine. Y si el campo cuelga del mismo árbol o del mismo contexto que se
actualiza, además se re-renderiza sin necesidad.

**Estrategias, por impacto:** **(1)** dejar de reinterpretar: partir el mensaje en
bloques cerrados —memoizados y que ya no se vuelven a renderizar— más una cola
viva, y reinterpretar solo la cola. **(2)** Desacoplar el flujo de React:
acumular en una referencia o un store externo y volcar a React por
`requestAnimationFrame` o cada N ms, no por token. **(3)** Sacar el campo de
entrada del subárbol que se actualiza, o dejarlo no controlado. **(4)**
`startTransition` o `useDeferredValue` para marcar la actualización del mensaje
como no urgente, de modo que escribir la interrumpa. **(5)** Virtualizar el hilo.
La memoización de componentes es lo último, no lo primero.

**Cómo lo mediría antes de optimizar:** el Profiler de React para la duración de
cada `commit`, y el panel de rendimiento para tareas largas y tiempo total de
bloqueo; para el campo de entrada, la métrica **INP**. **Qué número me diría que
ya es suficiente:** ninguna tarea larga por encima de 50 ms durante el streaming,
INP por debajo de 200 ms, y un `commit` por fragmento por debajo de ~8 ms para que
quepan dos en un fotograma. Cuando eso se cumple, seguir optimizando es gastar
tiempo sin que el usuario note nada.

### 3.3 Estado de una entidad que el agente construye mientras responde

Modelo el estado del cliente en **tres capas que nunca se mezclan**
(`estado/analisis.ts`). Los **pasos** son narración: qué herramienta se invocó, qué
se consultó; se pueden perder sin consecuencias. La **propuesta** es el dictamen que
el modelo está intentando registrar: es **reversible**, puede cambiar, puede ser
tumbada por un guardarraíl y puede no llegar a existir. El **identificador del
dictamen** solo aparece cuando el servidor confirma la escritura, y a partir de ahí
hay un **efecto confirmado**.

Esa separación es lo que impide que el panel y el chat se contradigan: el panel no
pinta lo que el chat narra, pinta la propuesta mientras es propuesta y el dictamen
persistido cuando existe. Visualmente están marcados distinto —franja de actividad
y la palabra «propuesta» frente a identificador y estado real—, para que el
analista nunca confunda una recomendación con un hecho.

**Al reconectar no reconstruyo nada.** El dictamen o se escribió o no se escribió,
y eso se **consulta**: la interfaz recarga el expediente desde la API y descarta su
copia local. No reanudo el flujo, porque reanudarlo exigiría que el servidor
guardara los pasos a medias y no hay nada que ganar con ello — lo único que
importa ya es transaccional. Si el analista cancela, ocurre lo mismo: la
generación se corta en el proveedor y lo que se hubiera escrito antes sigue en el
expediente, porque no dependía de esa conexión.

---

## 4. Inteligencia Artificial

### 4.A Fundamentos aplicados

#### 4.1 Fraude con 0.3 % de positivos: métrica, umbral, y qué se rompe al subir a 1.2 %

La exactitud engaña porque un modelo que responde «no hay fraude» siempre acierta
el 99.7 %. Tampoco optimizo ROC-AUC: la tasa de falsos positivos tiene un
denominador enorme y se mueve poco aunque el modelo empeore donde importa.
Optimizo **precisión media (área bajo la curva de precisión-exhaustividad)**, que
sí se degrada cuando el modelo ensucia el conjunto de alertas.

El umbral no sale de la curva sino del **costo de negocio**: elijo el que minimiza
`C_FP · FP(t) + C_FN · FN(t)`. En fraude, un falso negativo cuesta el importe
defraudado y un falso positivo cuesta minutos de analista y fricción con un
cliente legítimo, así que el óptimo cae bastante por debajo de 0.5. Si el equipo
de revisión tiene capacidad fija, el umbral es directamente el que produce las N
alertas diarias que caben.

**Al subir a 1.2 % se rompen dos cosas.** Primera, el volumen: a umbral fijo las
alertas se multiplican por cuatro y desbordan la capacidad de revisión, que era
justamente lo que fijaba el umbral. Segunda, la **calibración**: las
probabilidades que el modelo emite dejan de corresponderse con la frecuencia
observada, porque se entrenó con otra prevalencia. Recalibro sobre datos recientes
—Platt o isotónica—, vuelvo a derivar el umbral con el nuevo costo y capacidad, y
pongo la prevalencia a monitorizar como métrica de primer nivel. Antes de nada,
compruebo si el aumento es fraude real o un cambio en cómo se etiqueta.

#### 4.2 Cuándo un modelo clásico en vez de un LLM, y qué no debe tocar aquí

Uso un modelo clásico cuando la salida es una decisión acotada sobre variables
estructuradas, hay histórico etiquetado, y hacen falta explicabilidad,
reproducibilidad y defensa ante un regulador. Un LLM aporta cuando la entrada es
texto no estructurado o cuando el trabajo es lingüístico: leer, encontrar la
norma aplicable entre muchas, redactar la justificación.

**Caso concreto donde el LLM es la peor decisión:** puntuar transacciones en
tiempo real a diez mil por segundo. En **costo**, es varios órdenes de magnitud
más caro por decisión. En **latencia**, cientos de milisegundos frente a
microsegundos de un árbol impulsado por gradiente, y el pago se autoriza o se
rechaza en línea. En **explicabilidad**, el árbol da atribución por variable y es
determinista; el LLM da una redacción distinta cada vez y no se puede auditar.

**Aplicado a esta prueba:** el LLM no debe tocar el cálculo de los indicadores, la
aplicación de los umbrales numéricos ni la autorización final. Los indicadores son
deterministas y auditables; que los «calcule» un modelo mete varianza donde no la
había y hace imposible responder por qué se rechazó. Por eso en este proyecto el
cálculo está en código, G2 rechaza la persistencia si el dictamen no coincide, y
ningún dictamen queda en firme sin confirmación humana.

### 4.B Agentes

#### 4.3 Qué sigue siendo tuyo al diseñar herramientas

Aunque el framework resuelva el ciclo, siguen siendo mías: la **granularidad**, el
**contrato** de entrada y salida, el **manejo de errores** y el **criterio de
parada**. En este proyecto el ciclo está escrito a mano precisamente para que esas
cuatro cosas sean visibles y defendibles.

**Bucles infinitos:** tope de iteraciones, tope de costo por ejecución y tiempo
límite, los tres configurables. Y algo que añadí después de verlo pasar: el modelo
encadenó seis búsquedas seguidas sin decidir, así que tras cuatro se le dice una
sola vez que ya tiene material suficiente. Cortar no es lo mismo que reconducir.

**Costo por ejecución:** contabilidad de tokens por paso y corte duro en dólares
antes de cada iteración, no al final.

**¿Una herramienta o cinco?** Cinco pequeñas. Una `evaluar_solicitud(id)` que lo
hiciera todo devolvería un veredicto ya cocinado: el LLM no aportaría nada —el
veredicto lo calcula el código— y a la vez no habría pasos que auditar, así que
tampoco se podría explicar cómo llegó. Con cinco herramientas la traza muestra qué
consultó, en qué orden y con qué argumentos. **El contraargumento honesto:** cinco
herramientas cuestan más turnos, más tokens y más latencia. Acepto ese costo
porque en un sistema que produce insumos para una decisión regulada, la
trazabilidad es el producto, no un adorno.

#### 4.4 Cuándo un sistema multiagente es peor que un agente con más herramientas

Es peor cuando la tarea es **una decisión coherente sobre un contexto compartido**,
que es este caso. En **latencia**, cada salto añade una llamada completa. En
**costo**, cada agente vuelve a serializar el contexto que el anterior ya tenía, así
que se paga varias veces por los mismos tokens. En **depuración**, se pierde la
traza lineal: un dictamen equivocado deja de tener una secuencia y pasa a tener un
grafo. En **trazabilidad**, atribuir el error a un agente concreto exige reconstruir
qué le pasó cada uno al siguiente.

**La señal que me haría cambiar** no es que la tarea «parezca de varios roles».
Son dos, y ambas concretas: que el catálogo de herramientas crezca más allá de lo
que el modelo selecciona con fiabilidad —en la práctica, unas quince o veinte—, o
que dos subtareas necesiten **autorizaciones o dominios de datos incompatibles**
que no deban verse entre sí. La separación tiene que venir de un requisito de
seguridad o de contexto, no de una metáfora organizativa.

#### 4.5 Reproducibilidad y auditabilidad con API externas

Registro por ejecución: identificador de sesión, **versión del prompt**, modelo y
**la cascada de modelos realmente intentada**, parámetros de muestreo, secuencia
completa de herramientas con argumentos y resultados, tokens de entrada y salida,
latencia, costo, y la **versión del corpus** de políticas.

Hay que ser honesto sobre el límite: con un proveedor externo **la
reproducibilidad bit a bit no existe**, porque el modelo cambia bajo el mismo
identificador sin avisar. Lo que sí garantizo es reproducibilidad de la **parte
determinista**: los indicadores, los guardarraíles y la verificación de citas dan
exactamente lo mismo hoy y dentro de seis meses. La aportación del modelo se
**registra**, no se re-deriva.

**El regulador pregunta por una solicitud concreta seis meses después.** Consulto:
el dictamen por identificador de solicitud, de ahí su `id_ejecucion`, y de ahí la
traza completa de pasos. Le muestro cuatro cosas. Los **datos tal como estaban al
emitir**, porque los indicadores quedaron congelados en la fila del dictamen y una
corrección posterior no los reescribe. Las **políticas citadas con su texto
literal** y la versión del corpus vigente entonces. La **evidencia de que ningún
número vino del modelo**: G2 rechaza la persistencia si no coinciden. Y **quién
confirmó** el dictamen y cuándo, porque sin confirmación humana nunca estuvo en
firme.

### 4.C Recuperación, contexto y caché

#### 4.6 Fragmentación de documentos heterogéneos, y la excepción lejana

Fragmento por **estructura del documento**, no por ventana fija: la unidad es la
sección o el artículo, y las tablas se mantienen enteras porque una tabla partida
entre dos fragmentos no es interpretable por ninguno de los dos. Los correos y
actas se fragmentan por intervención, conservando quién dijo qué.

**Metadatos por fragmento:** identificador y tipo de documento, ruta jerárquica
—título, sección, subsección—, versión y fechas de vigencia, y las referencias
cruzadas explícitas. Los uso para tres cosas: filtrar por vigencia, mostrar la
procedencia en la cita, y expandir el resultado siguiendo las referencias.

**El caso difícil —la condición en un sitio y su excepción lejos— no se arregla
fragmentando mejor.** Se arregla con **relaciones explícitas**: guardar que la
excepción modifica a la regla, y expandir la recuperación por cierre en ambos
sentidos. La búsqueda por similitud no las trae juntas de forma fiable porque el
vocabulario de la excepción habla de **su condición**, no de la regla que relaja.
Es exactamente lo que hace este proyecto con `modifica_a`, y lo medí: con la
paráfrasis «el flujo no alcanza para pagar la cuota», el ranking devuelve POL-2.7
y **pierde** POL-7.7; solo el cierre la recupera.

#### 4.7 Diagnosticar respuestas plausibles pero incorrectas

Lo descompongo en dos preguntas que se responden por separado. **¿Está el pasaje
correcto en el conjunto recuperado?** Si no está, el fallo es de **recuperación**:
lo mido con exhaustividad@k contra un conjunto etiquetado de consultas con su
pasaje de oro. **Si está pero llegó en posición baja y el generador lo ignoró**, el
fallo es de **reordenamiento**: se ve comparando la posición del pasaje de oro con
la posición de lo que el modelo acabó usando. **Si está arriba y la respuesta lo
contradice**, el fallo es de **generación**.

**Qué instrumentaría** para responderlo con datos: registrar por consulta los
identificadores y puntajes de todo lo recuperado, el contexto exacto que se envió
—no una reconstrucción— y la respuesta. Con eso se calcula exhaustividad de
recuperación, ganancia del reordenamiento y fidelidad de la generación por
separado.

En este proyecto hay una señal más directa y barata: **cada cita se verifica
literalmente contra el corpus**. Una cita que no verifica es evidencia inmediata de
fallo de generación, sin necesidad de etiquetar nada. Y como se registra qué
políticas recuperó el agente, se puede comprobar si la política aplicable estaba
disponible y no la usó, que separa recuperación de generación en un solo vistazo.

#### 4.8 Solo RAG frente a híbrido con motor de reglas o grafo

**Qué convierto en estructura simbólica:** los umbrales numéricos, las condiciones
de aplicabilidad, las relaciones de precedencia entre regla y excepción y los
períodos de vigencia. **Qué conservo en recuperación semántica:** la prosa, la
motivación de la norma y todo lo que no se reduce a predicados sin perder sentido.

**Cómo validaría la conversión:** con ida y vuelta. Cada regla simbólica apunta al
**texto literal del que salió**, y sobre un conjunto de casos ya dictaminados por
humanos el motor simbólico tiene que coincidir con el veredicto humano. Una regla
extraída que no reproduce el histórico está mal extraída.

**Precedencia:** explícita y evaluada contra los datos del caso. La excepción lleva
sus condiciones; se comprueban; si se cumplen, su umbral sustituye al general.
Nunca dejo que lo decida la similitud, porque la similitud no sabe si el
solicitante tiene 60 meses de operación.

**Comparación.** Latencia: microsegundos frente a una ida y vuelta de recuperación
más generación. Costo: prácticamente cero frente a tokens por consulta. Precisión
de citas: muy superior, porque la regla apunta a su fuente por construcción.
Auditabilidad: un árbol de decisión que se puede imprimir y enseñar.

**Una política nueva que el esquema no sabe representar** se queda en la capa
semántica, **marcada como no modelada**, y el caso se escala. Forzarla al esquema
sería peor que no tenerla: produciría una decisión con apariencia de fundamento.

#### 4.9 Sesiones de más de 60 turnos

**Conservo** el prompt de sistema, el bloque estable de datos e indicadores, y la
entidad que se está construyendo. **Resumo** los turnos de razonamiento antiguos.
**Descarto** las salidas verbosas de herramientas ya consumidas: si el agente ya
extrajo el dato, el JSON de 4 KB no aporta nada. **Muevo fuera** los documentos
recuperados: en vez de arrastrarlos, se vuelven a recuperar cuando hagan falta.

**Lo que el caché de prompt exige sobre el orden:** que exista un **prefijo estable
e idéntico byte a byte** entre llamadas. Todo lo cacheable va delante y lo variable
detrás. Si algo que cambia se cuela al principio, invalida el resto y el caché deja
de acertar. Por eso en este proyecto el bloque de indicadores se inyecta siempre al
principio y con la misma forma.

**Por qué resumir agresivamente puede subir la factura:** resumir **reescribe la
historia**, y reescribir la historia **cambia el prefijo**. Cada resumen invalida el
caché, así que la siguiente llamada paga precio completo por todo el contexto en
vez del precio con descuento. Si se resume a menudo, se paga el máximo siempre. Y
el resumen en sí es otra llamada que también cuesta. Resumir tiene sentido cuando
el contexto no cabe, no como optimización de costo.

### 4.D Evaluación, costo y operación

#### 4.10 Cómo evalúo antes de producción

**Conjunto de evaluación:** casos reales, estratificados por **camino de decisión**
—no muestreados al azar, que sobrerrepresenta lo fácil—, con adversariales y bordes
incluidos, congelado y versionado. En este proyecto son diez casos elegidos
calculando primero los indicadores de las 210 solicitudes y clasificándolas por qué
políticas les aplican.

**Métricas:** coincidencia exacta de la decisión, tasa de citas verificables, tasa
de activación de cada guardarraíl, y percentiles de costo y latencia.

**Criterio de aprobación fijado antes de ejecutar**, no después de ver el
resultado: en este caso, decisión exacta, presencia de la política esperada,
coherencia numérica sin tolerancia y que ningún dictamen quede en firme.

**Lo que no tiene una única respuesta correcta —la calidad de una justificación—**
no se evalúa con coincidencia. Se evalúa con **rúbrica de criterios comprobables**:
si cita la política aplicable, si menciona la restricción que decidió el caso, si
evita afirmar cosas que los datos no sostienen. Varios evaluadores humanos puntúan
un subconjunto y se mide su acuerdo; sin acuerdo entre humanos, la métrica no
significa nada. Solo entonces se puede usar un modelo como evaluador, y únicamente
tras demostrar que **correlaciona con los humanos** en ese conjunto de calibración,
con su prompt y su versión de modelo fijados.

#### 4.11 De 4 000 a 1 200 dólares al mes

Por orden de impacto. **(1)** Dejar de llamar al modelo para lo que hace el código:
en este proyecto los indicadores, los umbrales y los guardarraíles no consumen ni
un token, y son la mitad del trabajo. **(2)** Caché de prompt con prefijo estable,
que en cargas repetitivas es el descuento más grande y ya está pagado. **(3)**
Reducir el contexto recuperado: ajustar el top-k y reordenar en vez de volcar el
corpus. **(4)** Enrutar por dificultad, con un modelo pequeño para los casos
fáciles. **(5)** Acotar iteraciones y presupuesto de reparación. **(6)** Procesar en
lote lo que no es interactivo.

**La más peligrosa es la cuarta.** Un modelo pequeño degrada **en silencio y en la
cola**: los casos fáciles siguen bien, las métricas agregadas no se mueven, y lo
que empeora es justo lo difícil, que es lo que más importa. **Cómo verificaría que
no rompí nada:** conjunto de evaluación congelado y **estratificado por
dificultad**, mirando el estrato difícil por separado y no el promedio; y ejecución
en sombra del modelo barato contra el caro sobre tráfico real, comparando
**decisiones**, no puntuaciones medias.

#### 4.12 Evaluaciones en verde y negocio reportando rarezas

**Por qué pueden estar en verde y el sistema estar peor:** porque diez casos
congelados prueban lo que se me ocurrió hace tres semanas. En el intervalo cambió
el modelo bajo el mismo identificador, cambió un prompt y el corpus creció un 40 %
— y ninguna de esas tres cosas está representada en el conjunto. Las evaluaciones
no miden el sistema, miden el sistema **en los casos que elegí**.

**Detectar:** monitorización de señales distribucionales en producción, que no
necesitan etiquetas — mezcla de decisiones, tasa de escalamiento, tasa de citas que
no verifican, patrón de llamadas a herramientas, tokens por ejecución. Un salto en
la tasa de escalamiento es visible el mismo día y sin etiquetar nada.

**Aislar:** versionar las tres variables y registrarlas en cada ejecución —prompt,
modelo, corpus—, y luego **bisecar**: reejecutar el conjunto congelado contra cada
combinación hasta ver cuál mueve el resultado. Sin ese registro, aislar es
adivinar.

**Prevenir:** fijar versiones de modelo en vez de alias flotantes; tratar el prompt
y el corpus como despliegues que pasan por la puerta de evaluación; y **hacer
crecer el conjunto desde los fallos de producción**, añadiendo un caso de regresión
cada vez que algo se rompe. Un conjunto que no crece envejece.

### 4.E Aprendizaje por refuerzo aplicado a agentes

#### 4.13 Condiciones para que RL supere a mejorar prompts, herramientas o recuperación

Cuatro condiciones, y las cuatro tienen que darse. **Señal verificable**: la
recompensa debe salir de una comprobación automática, no de preferencia humana;
aquí la habría —cita verificable, coherencia numérica, coincidencia con la decisión
confirmada por el analista—. **Volumen de trayectorias**: miles, no cientos, y con
suficientes casos difíciles. **Varianza del entorno acotada**: si las políticas
cambian cada mes, se entrena contra un blanco móvil. Y sobre todo, que el fallo sea
**de política** —elegir mal la secuencia de acciones— y no de conocimiento o de
herramientas.

**Aquí no se cumple la cuarta, y lo sé porque lo medí.** El fallo más caro de este
proyecto fue que el parámetro `dictamen` estaba declarado como objeto opaco en el
esquema de la herramienta: el modelo no podía producir una forma que nunca se le
mostró. RL habría aprendido a rodear un error que se arregló en una línea.

**Frente a SFT sobre los dictámenes históricos:** SFT es mucho más barato, solo
necesita pares de entrada y salida buena, y enseña **formato y estilo** con
fiabilidad — que es exactamente lo que falló aquí. Pero tiene un problema que el
propio enunciado describe: los criterios **varían entre analistas** y los rechazos
no siempre quedan documentados. SFT sobre ese histórico aprendería la
inconsistencia y la volvería sistemática.

**No lo recomendaría** cuando la recompensa es un sustituto de una decisión
regulada, cuando el volumen está en los cientos, o cuando las políticas cambian
mensualmente.

#### 4.14 Función de recompensa, sus explotaciones y la asignación de crédito

**Recompensa**, solo con componentes verificables: la cita verifica literalmente
contra el corpus (+), los indicadores coinciden con el cálculo en código (+), la
decisión coincide con la que el analista acabó confirmando (+), escalamiento
innecesario (−), iteraciones y costo (−).

**Contra mí mismo, cuatro formas de maximizarla empeorando el negocio.**
**(1) Escalar todo.** Nunca se equivoca en una aprobación y evita el castigo por
error; el negocio recibe cien por ciento de trabajo manual. _Detectar:_ tasa de
escalamiento contra la línea base histórica, y costo explícito al escalamiento.
**(2) Citar siempre la política más genérica.** Verifica literalmente, así que cobra
la recompensa de cita sin ser la norma aplicable. _Detectar:_ distribución de
políticas citadas frente a la aplicable real; medir **pertinencia** de la cita, no
solo verificabilidad.
**(3) Saltarse la recuperación** y adivinar desde el bloque estable: menos
iteraciones, menos castigo, y acierta en los fáciles. _Detectar:_ correlación entre
recompensa y número de herramientas invocadas, con casos difíciles reservados.
**(4) Copiar los indicadores literalmente** —recompensa garantizada— mientras
redacta motivos que no se siguen de ellos. _Detectar:_ comprobar que cada motivo
menciona la restricción que efectivamente decidió el caso.

**Asignación de crédito con recompensa solo al final de ocho llamadas:** el
problema es que un acierto final no dice cuál de los ocho pasos lo produjo. Tres
cosas que sí ayudan. **Modelar la recompensa con señales intermedias verificables**:
una cita se puede verificar en el paso que la produce, no al final. **Comparación
relativa por grupos**: muestrear varias trayectorias para la misma entrada y
compararlas entre sí, de modo que la diferencia aísle la rama que importó — es la
idea de GRPO. Y **ablación**: reejecutar la trayectoria eliminando un paso cada vez
y ver cuál cambia el resultado, que es caro pero concluyente.

#### 4.15 Recompensas verificables sobre trayectorias

**Recolección sin contaminar producción ni filtrar datos sensibles.** Recojo en un
entorno en sombra con solicitudes sintéticas o desidentificadas, con el almacén de
recolección separado del de servicio. Si uso trazas reales, la anonimización ocurre
**en la frontera de captura**, no después, y queda registro de qué se autorizó a
usar. Ninguna traza con datos de cliente entra al entrenamiento sin ese registro.

**Por qué se penaliza la divergencia respecto al modelo base.** Sin ese término, la
política se mueve libremente hacia lo que maximiza el sustituto de recompensa, y
lo que maximiza el sustituto no es lo que se quería. Concretamente, sin penalizar:
las salidas colapsan hacia una plantilla que puntúa bien, el lenguaje se degrada,
el modelo deja de usar herramientas por las que no se le premia, y aparecen
respuestas repetitivas que un evaluador automático aprueba y una persona rechaza.

**Evitar que suba mi métrica y baje la capacidad general:** una batería de
capacidades **no relacionada con la recompensa**, evaluada en cada punto de
control y usada como puerta, más vigilancia de la diversidad y la longitud de las
salidas, que son los primeros indicadores del colapso.

**Qué evidencia me convencería de promover:** mejora en el conjunto congelado,
**sin regresión** en la batería general, mejora también en un conjunto nuevo que el
modelo no ha visto nunca, y tasa de activación de guardarraíles igual o mejor. Los
tres a la vez; cualquiera solo es insuficiente. **Qué me haría revertir:** que suban
las citas que no verifican, que la tasa de escalamiento se desplome —señal clásica
de explotación—, o que la batería general retroceda aunque la métrica objetivo
mejore.

---

### 4.F Fronteras de la inteligencia artificial

> Se responden tres de las doce, con al menos una fuente técnica primaria por
> respuesta.

#### 4.21 Representación del conocimiento, ontologías y razonamiento no monótono

Es la pregunta más cercana a lo que este proyecto tuvo que resolver: un corpus con
reglas por defecto, excepciones que las relajan y versiones que cambian.

**Ontología, sistema experto y grafo de conocimiento** resuelven cosas distintas.
Una **ontología** define el vocabulario y las relaciones —qué es una garantía, qué
tipos hay, qué implica cada una— y permite inferir por subsunción: si «hipotecaria»
es subclase de «garantía real», una regla sobre garantías reales aplica a las
hipotecarias sin escribirla dos veces. Un **sistema experto** codifica el
procedimiento: reglas condición-acción con un motor de encadenamiento y una
estrategia de resolución de conflictos, que es lo que decide qué pasa cuando dos
reglas aplican. Un **grafo de conocimiento** representa hechos e instancias y sus
relaciones, y es donde vive «esta política modifica a aquella».

**Mundo abierto frente a mundo cerrado.** Bajo mundo cerrado, lo que no consta es
falso: si no hay score, el score no cumple el mínimo y se rechaza. Bajo mundo
abierto, lo que no consta es **desconocido**: no se puede concluir ni que cumple ni
que no. Para crédito regulado, el mundo abierto es el correcto, y esta es
exactamente la laguna que dejé deliberadamente en el corpus — ninguna política
regula al solicitante **sin** score, y el sistema debe escalar en vez de deducir.
Un motor de mundo cerrado habría rechazado silenciosamente y nadie se habría
enterado.

**Qué aporta una lógica descriptiva:** decidibilidad. Restringe la expresividad a
cambio de que la inferencia termine siempre, lo que en un sistema que autoriza
créditos importa más que poder expresarlo todo.

**Consistencia cuando aparece una excepción que invalida una conclusión anterior.**
Esto es razonamiento **no monótono**: añadir información retira conclusiones, algo
que la lógica clásica no admite. Se modela con reglas por defecto —«normalmente el
endeudamiento no excede 0.65, salvo que…»— donde la excepción es una condición de
bloqueo del valor por defecto. La conclusión anterior no se «corrige»: queda
registrada como derivada bajo una teoría que ya no está vigente. Por eso en este
proyecto el dictamen **congela** el texto citado y la versión del corpus: la
consistencia se mantiene versionando, no reescribiendo.

**Mecanismo de explicación:** el motor devuelve la **derivación** — qué reglas se
dispararon, en qué orden, con qué hechos, y qué excepciones se evaluaron y por qué
no aplicaron. Es una prueba, reproducible y del mismo tamaño siempre.

**Contraste con pedirle al LLM que razone sobre el texto:** el LLM produce una
explicación **plausible**, no la derivación real. Puede llegar a la conclusión
correcta por el camino equivocado, y la explicación que dé será convincente en
ambos casos. Es la diferencia entre una prueba y una racionalización. Por eso este
sistema es híbrido: los umbrales los aplica el código, la cita se verifica contra
el corpus, y el LLM aporta la selección de norma y la redacción — donde una
explicación plausible es aceptable porque no es la que decide.

> **Fuente:** Reiter, R. «A Logic for Default Reasoning». _Artificial
> Intelligence_, 13(1–2), 1980, pp. 81–132. Complementada con: W3C, _OWL 2 Web
> Ontology Language Primer (Second Edition)_, Recomendación del W3C, 11 de
> diciembre de 2012.

#### 4.17 Lógica difusa y decisiones con fronteras imprecisas

Un comité habla de «capacidad de pago alta» o «riesgo moderado», que son conjuntos
sin frontera nítida. La lógica difusa formaliza eso con **funciones de pertenencia**
que asignan a cada valor un grado entre 0 y 1, en vez de una pertenencia binaria.

**Diseño para este caso.** Variables de entrada: cobertura de servicio de deuda,
antigüedad y score. Para la cobertura, funciones trapezoidales: «insuficiente»
plena hasta 1.0 y decayendo hasta 1.25; «adecuada» subiendo de 1.10 a 1.40 y plena
después. Nótese que se **solapan** a propósito: entre 1.10 y 1.25 un solicitante
pertenece parcialmente a ambos, que es justo lo que un umbral rígido no puede
expresar. **Reglas** del tipo «si cobertura es adecuada y antigüedad es suficiente
y riesgo es moderado, entonces recomendación es favorable», evaluadas todas en
paralelo con el grado de activación de cada una. **Desfusificación** por centroide
del área agregada, que es lo estándar y produce una salida continua.

**Comparación.** Frente a **umbrales rígidos**: elimina el acantilado en que 1.249
se rechaza y 1.251 se aprueba siendo indistinguibles, y hace explícito que la
frontera es convencional. Frente a un **modelo probabilístico**: no es lo mismo.
Una probabilidad dice «con qué frecuencia ocurre el incumplimiento»; un grado de
pertenencia dice «hasta qué punto este caso es de esta categoría». Confundirlos
lleva a interpretar un 0.7 de pertenencia como un 70 % de riesgo, que es falso. El
modelo probabilístico se estima con datos; el difuso se **declara** con el criterio
del comité, y esa es a la vez su ventaja —no necesita histórico— y su debilidad.

**Cómo auditaría las reglas:** son legibles por una persona no técnica, que es su
mayor virtud. Auditaría tres cosas: que las funciones de pertenencia cubren todo el
dominio sin huecos, que ninguna combinación de entradas deja el conjunto de reglas
sin disparar, y —lo importante— **la sensibilidad**: cuánto mueve la salida un
cambio pequeño en cada punto de quiebre, porque ahí es donde se esconde la
arbitrariedad que se decía haber eliminado.

**Qué riesgo introduce convertir una salida gradual en una decisión discreta.** El
riesgo es la falsa sensación de haber resuelto el problema. Si la salida difusa es
0.62 y el corte de aprobación está en 0.60, **hemos vuelto a tener un umbral
rígido**, solo que ahora escondido detrás de una capa que parece más sofisticada y
es más difícil de auditar. Peor para un regulador: al solicitante rechazado ya no
se le puede decir «su cobertura es 1.18 y el mínimo es 1.25», sino «su grado
agregado fue 0.58», que no es explicable ni recurrible. Por eso en este proyecto
los umbrales son **nítidos y citables**: la explicabilidad ante el solicitante pesa
más que la suavidad de la frontera.

> **Fuente:** Zadeh, L. A. «Fuzzy Sets». _Information and Control_, 8(3), 1965,
> pp. 338–353. Para el mecanismo de inferencia y desfusificación: Mamdani, E. H. y
> Assilian, S. «An experiment in linguistic synthesis with a fuzzy logic
> controller». _International Journal of Man-Machine Studies_, 7(1), 1975,
> pp. 1–13.

#### 4.18 IA causal y explicaciones contrafactuales

**Predicción no es causalidad.** Un modelo que predice incumplimiento aprende
asociaciones en la distribución observada; usarlo para **recomendar acciones**
supone que intervenir sobre una variable mueve el resultado como lo movía la
correlación, y eso solo es cierto si esa variable es causa y no está confundida.
El caso clásico aquí: «tener más productos contratados» predice menos
incumplimiento, pero venderle productos a un cliente en riesgo no lo mejora — ambas
cosas las causa la solvencia.

**Grafo causal propuesto,** con los confusores explícitos. Solvencia real del
negocio (no observada) → ventas, utilidad y comportamiento de pago histórico. Ciclo
económico sectorial (no observado) → ventas y también incumplimiento. Monto y plazo
→ cuota → incumplimiento. Garantía → pérdida dado el incumplimiento, no la
probabilidad de incumplir. Los dos no observados son confusores: explican a la vez
las variables que uso y el resultado que predigo.

**Explicación contrafactual.** «Qué tendría que cambiar»: el mínimo cambio en
variables **accionables** que voltearía la decisión. Para un rechazo por cobertura
0.98 frente al mínimo de 1.25, el contrafactual útil es «con un plazo de 60 meses en
vez de 24, la cuota baja y la cobertura sube a 1.31». Es accionable, es verificable
recalculando en código, y no requiere ningún supuesto causal: es aritmética sobre
la política.

**Qué afirmaciones NO podría sostener con datos observacionales.** No podría decir
«si aumenta sus ventas un 20 %, su probabilidad de incumplir baja X»: eso es un
efecto causal y las ventas están confundidas por la solvencia y el ciclo. Tampoco
podría atribuir el efecto de la garantía sobre la probabilidad de incumplir. Para
sostener afirmaciones así harían falta intervención —asignación aleatoria de
condiciones— o supuestos de identificación explícitos y comprobables.

**Cómo evitaría explicaciones manipulables o discriminatorias.** Manipulables:
restringir el contrafactual a variables que el solicitante no puede falsear
trivialmente, y no publicar la frontera exacta, porque un contrafactual completo es
un manual para pasar el filtro sin cambiar el riesgo. Discriminatorias: excluir del
espacio de contrafactuales las variables no accionables o protegidas —edad, sexo,
origen— y, más importante, sus **sustitutas**, porque un contrafactual sobre el
código postal es discriminación con otro nombre. Y comprobar que el contrafactual
propuesto es **alcanzable**: sugerirle a un negocio que duplique su patrimonio no es
una explicación, es una burla.

> **Fuente:** Wachter, S., Mittelstadt, B. y Russell, C. «Counterfactual
> Explanations Without Opening the Black Box: Automated Decisions and the GDPR».
> _Harvard Journal of Law & Technology_, 31(2), 2018, pp. 841–887. Para el marco
> causal: Pearl, J. _Causality: Models, Reasoning, and Inference_, 2.ª ed.,
> Cambridge University Press, 2009.
