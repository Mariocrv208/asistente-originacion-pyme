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
