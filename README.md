# Asistente de Originación Crediticia PyME

Examen práctico de AI Engineer — Gerencia de Innovación.

> **Estado:** en construcción. Este README se completa en el módulo M19 con las
> decisiones técnicas exigidas por el punto 5.3.2 y 5.3.1 del enunciado.

## Stack elegido

| Capa                              | Elección                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Backend                           | Node.js 24 + TypeScript (Fastify)                                                                    |
| Framework de agentes              | Llamada directa al SDK del proveedor (`openai` apuntando a OpenRouter) con ciclo de ejecución propio |
| Frontend                          | React 19 + TypeScript + Vite                                                                         |
| Base de datos                     | PostgreSQL 16 + `pgvector` en contenedor                                                             |
| Proveedor de LLM                  | OpenRouter (modelos gratuitos)                                                                       |
| Decimal exacto                    | `decimal.js` + `NUMERIC(18,2)` en PostgreSQL                                                         |
| Validación de salida estructurada | Zod                                                                                                  |

La justificación de cada elección —en particular por qué se escribe el ciclo del
agente a mano en vez de usar Mastra— está en [`docs/DECISIONES.md`](docs/DECISIONES.md).

## Puesta en marcha

Requisitos: Node.js 22 o superior, pnpm 11 y Docker Desktop en ejecución.

```bash
pnpm install
cp .env.example .env
pnpm db:up
pnpm dev
```

Eso deja tres cosas corriendo: PostgreSQL en el contenedor `aop-db`, la API en
`http://localhost:4000` y el frontend en `http://localhost:5173`. La pantalla de
inicio verifica la cadena completa y muestra el estado de cada pieza.

### Puertos

| Servicio   | Puerto | Nota                                                                              |
| ---------- | ------ | --------------------------------------------------------------------------------- |
| PostgreSQL | `5440` | 5432, 5433 y 5434 estaban ocupados por otros Postgres de la máquina.              |
| API        | `4000` |                                                                                   |
| Frontend   | `5173` | Hace proxy de `/api` hacia la API, así que en desarrollo todo es un mismo origen. |

> **Cuidado con el puerto de PostgreSQL.** En Windows, si el puerto elegido ya
> está tomado por un Postgres local, Docker publica el suyo igualmente y ambos
> quedan escuchando: la conexión parece funcionar pero llega a la base
> equivocada, y el síntoma es un error de autenticación desconcertante. Si
> cambias `DATABASE_URL`, comprueba antes que nadie más escuche en ese puerto.

### Comandos útiles

| Comando                           | Qué hace                                                |
| --------------------------------- | ------------------------------------------------------- |
| `pnpm dev`                        | Levanta API y frontend en paralelo                      |
| `pnpm dev:api`                    | Solo la API                                             |
| `pnpm dev:web`                    | Solo el frontend                                        |
| `pnpm typecheck`                  | Comprobación de tipos en todo el monorepo               |
| `pnpm lint`                       | ESLint                                                  |
| `pnpm format`                     | Prettier en modo escritura                              |
| `pnpm db:up`                      | Arranca PostgreSQL                                      |
| `pnpm db:migrate`                 | Aplica las migraciones pendientes                       |
| `pnpm db:verificar`               | Comprueba que las restricciones rechazan lo que deben   |
| `pnpm corpus:cargar`              | Carga el corpus de políticas (idempotente)              |
| `pnpm corpus:verificar`           | Integridad del corpus y verificación de citas           |
| `pnpm finanzas:verificar`         | Amortización, redondeo e indicadores del punto 5.3.1    |
| `pnpm datos:generar`              | Regenera `data/dataset.json` de forma determinista      |
| `pnpm datos:sembrar`              | Siembra el conjunto en la base de datos                 |
| `pnpm datos:verificar`            | Determinismo, exigencias del 5.2.1 y cobertura          |
| `pnpm recuperacion:verificar`     | Enrutamiento, BM25 y cierre por excepciones             |
| `pnpm agente:verificar`           | Herramientas, guardarraíles y ejecución real del agente |
| `pnpm agente:verificar --sin-llm` | Igual, sin gastar cuota del proveedor                   |
| `pnpm llm:modelos`                | Lista los modelos gratuitos aptos del catálogo actual   |
| `pnpm api:verificar`              | Endpoints, errores, confirmación G4 y formato SSE       |
| `pnpm db:psql`                    | Abre una sesión `psql` contra el contenedor             |
| `pnpm db:nuke`                    | Destruye el contenedor **y su volumen de datos**        |

### Variables de entorno

Todas están documentadas en `.env.example`. La única que exige intervención
manual es `OPENROUTER_API_KEY`, que se obtiene en
<https://openrouter.ai/keys> y **no se necesita hasta el módulo M7**: toda la
parte determinista del sistema —cálculo de indicadores, corpus de políticas,
guardarraíles— se desarrolla y se evalúa sin credenciales.

## Esquema de base de datos

Seis migraciones SQL versionadas en `apps/api/src/db/migrations`, aplicadas por
un ejecutor propio (`pnpm db:migrate`) que corre cada una en su propia
transacción, registra un checksum del archivo y se niega a continuar si una
migración ya aplicada cambió después.

### Estrategia de precálculo de indicadores (punto 5.3.1)

El enunciado ofrece cuatro caminos —vista materializada, columna generada,
trigger o caché en aplicación— y pide justificar el elegido y su invalidación.

**Elegido: tabla materializada por la aplicación, con invalidación por trigger.**

Cuatro de los cinco indicadores son cocientes de columnas de la misma fila y
serían columnas generadas `STORED` sin ningún esfuerzo. La opción es tentadora
porque hace la invalidación imposible de equivocar: PostgreSQL las recalcula
solo. Aun así se descarta, por dos razones.

La primera es literal: el punto 5.3.1 exige que el cálculo ocurra **en código**
con el tipo decimal exacto del lenguaje, y una columna generada lo haría en SQL.

La segunda importa más. El guardarraíl G2 rechaza la persistencia cuando un
indicador del dictamen no coincide con la salida de `calcular_indicadores`.
Para que esa comparación signifique algo, `calcular_indicadores` tiene que ser
la única fuente de verdad. Una columna generada sería una segunda
implementación del mismo cálculo, en otro lenguaje y con otras reglas de
redondeo, capaz de discrepar en silencio. G2 existe precisamente para impedir
que haya dos fuentes; introducir una segunda por comodidad vaciaría de
contenido el guardarraíl.

El quinto indicador cierra el argumento: la cobertura de servicio de deuda
depende de la cuota anual del crédito nuevo, que sale de la fórmula de
amortización y de una tasa que no vive en la fila. Ninguna columna generada
puede calcularla.

**Invalidación: la ausencia de fila es la invalidación.** Un trigger sobre
`solicitudes` borra la fila de `indicadores_solicitud` en cuanto cambia alguna
entrada del cálculo. No existe el estado «calculado pero obsoleto», que es donde
suelen esconderse los errores de un caché. La vista
`solicitudes_sin_indicadores` muestra de un vistazo qué falta recalcular. Como
defensa en profundidad, cada fila guarda además una huella de sus entradas y la
versión del algoritmo, de modo que una carga que se saltara el trigger quedaría
delatada por la discrepancia.

### Los guardarraíles que vive la base de datos

G3 exige, palabra del enunciado, «una restricción a nivel de base de datos, no
solo validación en aplicación». Un `CHECK` solo ve columnas de su propia fila,
así que el monto solicitado y el tope de política se materializan en la fila del
dictamen. El detalle que hace que la restricción sea real: **esos dos valores
los escribe un trigger**, derivándolos de la solicitud y de la tabla
`parametros_politica`. Si los escribiera la aplicación, bastaría con enviar un
tope inflado para burlar el `CHECK`.

G4 vive en una máquina de estados con triggers: ningún dictamen nace en firme,
las transiciones válidas son explícitas, y el contenido y las citas de un
dictamen que salió de `PENDIENTE_AUTORIZACION` dejan de ser modificables. Un
expediente reescribible después de firmado no sirve como evidencia de auditoría,
que es justo el hallazgo recurrente que el sistema viene a resolver.

`pnpm db:verificar` demuestra lo anterior atacando la base de datos por SQL
directo, sin pasar por la aplicación: 23 comprobaciones que verifican tanto que
lo inválido se rechaza como que lo legítimo pasa.

### Datos deliberadamente laxos

Las columnas financieras de `solicitudes` admiten `NULL` y no hay ninguna
restricción entre columnas: nada impide que los pasivos superen a los activos o
que la utilidad supere a las ventas. Es intencional. El punto 5.2.1 exige que al
menos cinco solicitudes lleguen con datos incompletos o inconsistentes, así que
son entrada legítima del sistema y no datos corruptos. Detectarlas es trabajo de
la capa de dominio, que las reporta como hallazgo del dictamen; rechazarlas en el
esquema haría imposible ejercitar el caso que el propio examen pide probar.

## Corpus de políticas

`data/politicas.json` extiende el archivo de ejemplo del enunciado de 8 a **31
políticas** en 10 categorías. Se carga con `pnpm corpus:cargar`, que es
idempotente, y se comprueba con `pnpm corpus:verificar`.

Las ocho políticas originales conservan su texto **exactamente** como se
entregó, sin corregirles la falta de tildes. No es descuido: G1 verifica
literalidad contra el corpus, y reescribir el texto de referencia habría
falseado esa verificación. Las políticas añadidas usan ortografía normal, y la
normalización de acentos hace que la comparación funcione igual en ambos casos.

### Lo que el corpus contiene a propósito

**Tres excepciones parciales.** POL-7.3 relaja POL-2.3, POL-7.5 relaja POL-1.2 y
POL-7.7 relaja POL-2.7. En los tres casos la excepción no sustituye a la regla
general, la modifica bajo condiciones. Es el caso difícil que el enunciado pide
ejercitar, y la relación queda explícita en la columna `modifica_a` en vez de
confiarse a que la búsqueda por similitud traiga ambas juntas por casualidad.

**Una laguna deliberada.** Ninguna política dice nada sobre solicitantes **sin
score de historial**. POL-3.4 regula los tramos de 0 a 39 y de 40 a 59, y las
excepciones se apoyan en umbrales superiores, pero la _ausencia_ de score —la
situación real de un negocio formal sin historial crediticio previo— no está
cubierta. Ante un caso así el sistema no debe inventar una regla: debe escalar.

Esa laguna es frágil, porque es fácil taparla sin querer al añadir políticas. Por
eso `pnpm corpus:verificar` incluye una comprobación que falla si alguna política
llega a regularla: si se tapa, el caso de escalamiento por falta de política
aplicable que exige el punto 5.3.6 deja de existir.

### Verificación de citas (base de G1)

`normalizar()` es la única autoridad sobre qué significa «el mismo texto». Ignora
acentos, mayúsculas, espacios y comillas tipográficas —diferencias de forma que
un modelo introduce al copiar— pero **no** ignora números ni palabras: citar
«0.75» donde el corpus dice «0.65» es inventar una política, y es exactamente el
fallo que G1 debe atrapar.

Tres decisiones del verificador que conviene conocer:

- **Se verifica contra la política que la cita declara**, no contra el corpus
  entero. Un texto puede ser literal de POL-2.3 y estar atribuido a POL-4.1; esa
  cita sustenta la decisión con la política equivocada, y buscar en todo el
  corpus la daría por buena.
- **Se admite citar un fragmento contiguo**, no solo la política completa: un
  dictamen suele apoyarse en la cláusula concreta.
- **Hay una longitud mínima de 25 caracteres normalizados.** Sin ella, citar la
  palabra «el» pasaría la comprobación de literalidad.

Las 24 comprobaciones de `pnpm corpus:verificar` cubren los tres bloques:
integridad del corpus, aceptación y rechazo de citas, y coherencia entre el
JSON, la base de datos y los umbrales que aplican G3 y G4.

## Núcleo financiero

Todo el cálculo monetario pasa por `decimal.js`. El driver de PostgreSQL
devuelve `NUMERIC` como cadena y esa cadena entra directamente a `Decimal`: un
importe del sistema nunca toca el punto flotante binario en ningún tramo del
recorrido.

### Las tres decisiones que siempre generan incidentes

El punto 2.6 del cuestionario pregunta exactamente por ellas. Están resueltas en
`apps/api/src/domain/finanzas/` y explicadas donde se toman.

**Dónde redondear.** En dos puntos y solo dos: la cuota nivelada, una vez al
final de la fórmula de anualidad, y el interés de cada período, porque es lo que
se cobra y lo que se contabiliza. La potencia y la división intermedias se hacen
con 34 dígitos. Redondear dentro de la fórmula arrastraría el error a las 360
cuotas; no redondear nunca produciría importes que no existen en centavos.

**Cómo se reparte el residuo.** La última cuota amortiza todo el saldo restante y
su importe se recalcula como capital más interés. Por construcción, entonces: la
suma de los capitales es exactamente el principal, la suma de las cuotas es
exactamente capital más intereses, y el saldo final es cero exacto. Se aplica al
final y no repartido entre las primeras cuotas porque «cuota nivelada» es una
promesa al cliente: todas las cuotas menos una son idénticas.

**Qué regla de redondeo.** Mitad al par, no mitad hacia arriba. La diferencia es
irrelevante en una operación y decisiva en cientos de miles. El verificador lo
mide sobre 100 000 empates exactos: mitad al par acumula **0.00** de sesgo, mitad
hacia arriba acumula **+500.00** cobrados de más sin ninguna base.

> Un matiz que se descubrió construyendo esa medición: si todos los empates se
> generan en la posición `.005`, las candidatas son siempre `.00` y `.01`, y como
> el cero es par, mitad al par los baja **todos**. Esa muestra no mide el sesgo de
> la regla sino el de la muestra. Los empates tienen que repartirse por toda la
> escala de centavos, que es la situación real de una cartera.

### Por qué `saldo == 0` es peligroso

Con punto flotante la comparación es una trampa: tras 240 restas el saldo vale
algo como `3.517`, nunca cero, y el crédito queda vivo devengando intereses sobre
un residuo que nadie sabe explicar. El verificador lo demuestra con la misma
tabla calculada en `number`.

Con `decimal.js` el cero exacto sí es alcanzable, y esta implementación lo
garantiza. Pero la comparación sigue sin poder escribirse como `saldo === 0`,
porque un `Decimal` es un objeto y esa expresión compara referencias. De ahí que
exista `estaLiquidado()` y que ningún otro punto del código compare saldos a
mano.

### El residuo, medido

Redondear la cuota a centavos y mantenerla fija hace que la diferencia se acumule
período a período, así que el residuo crece con el plazo y con la tasa. Los
números reales: un céntimo a 24 meses, Q3.53 a 240, Q13.20 a 360.

Lo que importa es el envolvente real del producto — POL-10.1 fija la tasa en 18 %
y POL-4.6 limita el plazo a 84 meses. Dentro de ese rango el peor ajuste medido
es de **Q0.58**, que es lo que el cliente verá en su última cuota.

### La tabla es iterativa, no recursiva

Una implementación con una llamada por cuota parece elegante y es una bomba: con
240 o 360 meses cada crédito abre esa profundidad de pila, y el proceso nocturno
que recalcula 500 000 créditos en paralelo multiplica el consumo por hilo. V8 no
aplica optimización de llamada de cola —se especificó en ES2015 y no se
implementó—, así que en Node la recursión aquí no tiene red de seguridad.

### Verificación

`pnpm finanzas:verificar` ejecuta 82 comprobaciones en cuatro bloques. Los valores
esperados de la cuota nivelada **no salen de esta implementación**: se calcularon
aparte con el módulo `decimal` de Python, para que la prueba no sea circular.
Ambas coinciden al centavo sobre plazos de 24, 36, 240 y 360 meses.

## Conjunto de datos sintéticos

`data/dataset.json` contiene **210 solicitudes** y **78 dictámenes históricos**.
Se regenera con `pnpm datos:generar` y se siembra con `pnpm datos:sembrar`.

### Determinismo

Nada aquí usa `Math.random()` ni `new Date()`. Hay una semilla fija, un
generador `mulberry32` propio y una fecha de referencia constante. Los UUID se
derivan de un hash en vez de `gen_random_uuid()`.

No es purismo: los diez casos de evaluación de M18 apuntan a solicitudes
concretas por su identificador. Si los datos cambiaran entre ejecuciones, el
banco de pruebas dejaría de referirse a los mismos casos y no valdría nada.

`pnpm datos:verificar` comprueba el determinismo de dos formas: generando dos
veces en memoria, y comparando contra el archivo en disco. La segunda es la que
importa, porque detecta que alguien editó el JSON a mano.

### Lo que el conjunto contiene a propósito

| Rasgo                                        | Casos | Para qué                                        |
| -------------------------------------------- | ----- | ----------------------------------------------- |
| Intentos de manipulación en `destino_fondos` | 4     | Verificar G5 (el mínimo son 3)                  |
| Datos incompletos o inconsistentes           | 6     | POL-8.4 y casos adversariales (el mínimo son 5) |
| Endeudamiento sobre 0.65 sin hipoteca        | 32    | Rechazo por POL-2.3                             |
| Antigüedad bajo 24 meses                     | 14    | Rechazo por POL-1.2                             |
| Score bajo 40                                | 18    | Rechazo por POL-3.4                             |
| Monto sobre el 30 % de las ventas            | 34    | Rechazo por POL-4.1                             |
| Monto sobre Q250 000                         | 19    | Escalamiento por monto (POL-6.2)                |
| Score ausente                                | 8     | Escalamiento por falta de política aplicable    |
| Sin ningún rasgo bloqueante                  | 93    | Aprobación clara                                |

El verificador comprueba que cada bucket tenga material suficiente. Es lo que
garantiza que el punto 5.3.6 —tres rechazos por motivos de política **distintos**
y dos escalamientos de tipos diferentes— sea construible.

Los cuatro intentos de manipulación se guardan **sin sanear**. Sanearlos al
escribir destruiría la evidencia con la que se verifica G5: el aislamiento
ocurre al construir el contexto del agente, no al guardar el dato.

### Una distribución que hubo que corregir

La primera versión del generador derivaba el monto de unas ventas log-uniformes
de hasta 7,5 millones, y el resultado fue que **120 de 210 solicitudes superaban
los Q250 000**: el 57 % escalaba a comité y el conjunto perdía capacidad de
discriminar entre caminos de decisión. Ahora el monto ordinario se topa por
debajo del umbral y solo los perfiles marcados lo superan, que es la forma de
una cartera PyME real.

### Los históricos recorren su ciclo de vida

El sembrador no escribe el estado final de golpe: inserta el dictamen en
`PENDIENTE_AUTORIZACION`, le añade sus citas y solo entonces lo confirma con un
`UPDATE`.

No es una florituras. El trigger `trg_citas_inmutables` rechaza añadir citas a un
dictamen que ya salió de `PENDIENTE_AUTORIZACION`, así que insertarlo
directamente como `EN_FIRME` haría imposible citarlo. Que la siembra tenga que
respetar el ciclo es una confirmación de que la máquina de estados de G4 funciona
también contra datos realistas, y no solo contra el script de M2.

## Acceso al corpus de políticas

El punto 5.3.2 deja la estrategia libre pero exige justificarla y decir qué
cambiaría con 500 políticas o con un corpus que cambia cada semana.

**Elegido: índice léxico BM25 en memoria, con enrutamiento por categoría y
cierre por excepciones.**

### Por qué no búsqueda vectorial

El corpus tiene 32 políticas. Recorrer 32 documentos cortos cuesta
microsegundos, da recall perfecto y no aproxima nada. Montar embeddings y un
índice ANN encima sería más lento —una inferencia de CPU o una llamada de red
por consulta—, menos exacto y bastante más difícil de auditar, a cambio de nada.

Es un cambio respecto a lo que anuncié en el documento inicial, donde había
previsto embeddings locales. La evidencia que me hizo cambiar fue el tamaño real
del corpus una vez construido: a esta escala, la parte vectorial resolvía un
problema que no existe.

### Las tres etapas

**1. Enrutamiento por categoría, como sesgo y nunca como filtro.** Esto importa
más de lo que parece. Las excepciones viven en la categoría `excepcion`, no en
la de la regla que modifican. Una consulta sobre endeudamiento filtrada
duramente a `capacidad_pago` **nunca** recuperaría POL-7.3, que es justo la
política que permite superar el límite: el sistema citaría la regla general y
aplicaría un rechazo que la excepción desmiente. Es un error sistemático y de
los que no se notan hasta que lo encuentra un auditor.

**2. Ordenación BM25** sobre términos exactos. Los números se conservan enteros
—`0.65`, `1.25`, `250,000` son términos con significado propio— y las negaciones
(`no`, `sin`, `salvo`) **no** se tratan como palabras vacías, porque en un texto
normativo distinguen una regla de su contraria.

**3. Cierre por excepciones**, en ambos sentidos: si entra una regla general
entran sus excepciones, y si entra una excepción entra la regla que modifica. El
fallo es simétrico — recuperar POL-2.3 sin POL-7.3 rechaza a quien la excepción
ampara, y recuperar POL-7.3 sin POL-2.3 deja al modelo aplicando una excepción
sin conocer la regla que relaja.

### Dónde se demuestra que el cierre hace falta

Midiéndolo, no afirmándolo. Con consultas que casi citan la norma —«la razón de
endeudamiento excede 0.65»— BM25 ya trae la excepción por su cuenta y el cierre
no aporta nada. El caso realista es otro: el agente formula la consulta desde la
**situación del solicitante**, no copiando el texto de la política. Con la
paráfrasis «el flujo no alcanza para pagar la cuota», el ranking devuelve POL-2.7
y **pierde POL-7.7**; solo el cierre la recupera. Esa es la comprobación que
está en el banco de pruebas.

### Limitación conocida

Una paráfrasis sin vocabulario compartido no recupera nada: BM25 no relaciona
«empresa recién constituida» con «24 meses continuos de operación». Está
declarado como comprobación explícita en `pnpm recuperacion:verificar` en vez de
escondido, porque es exactamente el hueco que cubriría una estrategia vectorial.

### Qué haría con 500 políticas o con cambios semanales

- **500 políticas:** el índice deja de caber cómodamente por proceso y la
  recuperación pasa a PostgreSQL. El esquema ya está preparado: la tabla
  `politica_fragmentos` con su columna `vector(384)` y las extensiones
  `pgvector` y `pg_trgm` están instaladas desde M1. La estrategia pasaría a
  híbrida —léxica más vectorial con fusión de rankings— y el cierre por
  excepciones se vuelve **más** importante, no menos: con más documentos, la
  regla general y su excepción se separan más fácilmente en el ranking.
- **Cambios semanales:** el corpus ya está versionado (`version` en el JSON, y
  `version_corpus` en cada fila de `politicas`), y los dictámenes congelan el
  texto citado. Añadiría vigencia temporal efectiva a la consulta —las columnas
  `vigente_desde` y `vigente_hasta` ya existen— para que un dictamen de hace seis
  meses se pueda releer contra el corpus que estaba vigente entonces, no contra
  el de hoy.

### Precedencia entre regla y excepción

`agruparPorPrecedencia()` devuelve la regla con sus excepciones colgando y **no
descarta ninguna de las dos**. La excepción no sustituye a la regla: la relaja
bajo condiciones que hay que comprobar contra los datos de esta solicitud
concreta. Resolver la precedencia en la capa de recuperación, sin mirar al
solicitante, sería inventarse el resultado.

## El agente

Ciclo de ejecución **escrito a mano sobre `fetch`**, sin SDK. La API de
OpenRouter es HTTP con cuerpo JSON, y un SDK encima solo añadiría una capa entre
la decisión y su explicación; lo que se evalúa es el control sobre el bucle, el
contrato de las herramientas y el contenido exacto del contexto. Además M12
necesita cancelación propagada hasta el proveedor, que con `fetch` es un
`AbortSignal`.

### Criterio de parada

Cuatro salidas, y no hay una quinta: el modelo deja de pedir herramientas, el
dictamen queda registrado, se agotan las iteraciones, o se agota el tope de
costo o de tiempo. Los topes son la garantía de terminación, y con modelos
gratuitos hacen falta de verdad.

### Cinco herramientas, no una

Una `evaluar_solicitud(id)` monolítica devolvería un veredicto ya cocinado: el
LLM no aportaría nada —lo calcularía el código— y a la vez no habría pasos que
auditar. Con cinco herramientas la traza muestra qué consultó, en qué orden y con
qué argumentos, que es lo que un regulador necesita ver seis meses después. El
contraargumento honesto: cuesta más turnos, más tokens y más latencia. Se acepta
porque la trazabilidad es el producto.

Ninguna herramienta lanza excepciones hacia el modelo. Todas devuelven el error
como **valor**, redactado para que pueda corregir. Una excepción aborta el ciclo;
un error como valor le da la oportunidad de arreglar «citaste una política que no
existe».

### El camino de fallo de la salida estructurada

El punto 5.3.4 dice que reintentar a ciegas no es aceptable. Se comprobó por qué
en una ejecución real **antes** de escribir la solución: el modelo produjo un
dictamen con la forma equivocada, la validación lo rechazó, y al no decirle nada
nuevo repitió el mismo error tres veces hasta agotar las ocho iteraciones sin
registrar nada. El reintento a ciegas no converge porque no cambia ninguna de las
condiciones que produjeron el fallo.

Lo que se hace en su lugar, en tres escalones:

1. **Reparación dirigida.** El error de validación vuelve al modelo como
   contenido concreto —qué campo, qué se esperaba, qué llegó—. Eso sí cambia las
   condiciones: en la ejecución siguiente, un `dictamen.id_solicitud: Required`
   devuelto al modelo bastó para que acertara al segundo intento.
2. **Presupuesto acotado.** Dos reparaciones. Si con el error delante no acierta
   dos veces seguidas, no es cuestión de suerte.
3. **Degradación construida por el servidor.** El dictamen lo arma el código:
   escalamiento a comité, indicadores del cálculo, citas de las políticas que el
   agente sí llegó a recuperar, motivos que dicen qué falló, y confianza 0.1 para
   que la interfaz muestre que es una salida degradada.

Una solicitud **siempre** acaba con un dictamen trazable en la bandeja del
analista. Un fallo del modelo se convierte en trabajo humano, que es el
comportamiento correcto en un sistema que no sustituye al analista; nunca en un
expediente que desaparece.

Si no hay ninguna política recuperada, la degradación devuelve `null` y el fallo
se reporta tal cual: **no se fabrica una cita** para poder cumplir el formato.

### Control de deriva

Otra ejecución real encadenó **seis búsquedas seguidas** y agotó las iteraciones
sin decidir nada. El tope las habría cortado igual, pero cortar no es reconducir:
tras cuatro búsquedas se le dice **una sola vez** que ya tiene material
suficiente y que registre. Es información nueva, no una repetición de la orden.

Ese mismo caso destapó un hueco: la degradación solo se disparaba al agotar
reparaciones, no al agotar iteraciones. Ahora cubre las dos formas de fallar.

### La clave de idempotencia

La genera el servidor a partir de `(solicitud, ejecución)`. La firma del enunciado
la acepta como parámetro y el servidor **la ignora**: si la generara el modelo, un
reintento disparado por el propio LLM produciría una clave distinta, la restricción
de unicidad no vería colisión y se escribirían dos dictámenes — justo lo que la
clave existe para impedir.

### Límite práctico: la cuota gratuita

La capa gratuita de OpenRouter permite **50 peticiones al día**. Una ejecución del
agente consume entre 6 y 12, así que verificar un par de veces la agota. El
verificador distingue «cuota agotada» de fallo real y lo reporta como omisión, y
acepta `--sin-llm` para correr solo lo que no depende del proveedor.

Conviene tenerlo en cuenta **antes de grabar el video**: hay que llegar con cuota.

## API

Endpoints de lectura (bandeja, detalle, dictamen, métricas, traza de ejecución),
confirmación y anulación de dictámenes, y análisis por streaming.

**Ninguna lectura toca el LLM.** Es intencional: la interfaz tiene que ser
navegable y útil sin gastar una sola petición del proveedor, y el analista pasa
mucho más tiempo revisando expedientes que lanzando análisis.

### SSE frente a WebSockets (pregunta 3.1)

El flujo es unidireccional: el servidor cuenta qué va haciendo y el cliente
escucha. Un WebSocket daría un canal bidireccional que no se usa, a cambio de un
protocolo aparte, otro camino de autenticación y un estado de conexión que
mantener. SSE viaja sobre HTTP normal y hereda proxies, cabeceras y cancelación.

**Por qué POST y no `EventSource`.** `EventSource` es la API estándar de SSE en el
navegador y aquí es justo la equivocada: solo hace `GET`, no admite cuerpo ni
cabeceras, y —lo grave— **reconecta sola**. Cada reconexión relanzaría una
ejecución completa del agente, gastando cuota y escribiendo dictámenes
duplicados. La idempotencia los atraparía, pero estaríamos pagando llamadas al
modelo para descartarlas después.

El cliente usa `fetch` con `ReadableStream`, que además da lo que el punto 5.3.8
exige: **cancelación real desde el cliente** con `AbortController`, propagada
hasta el proveedor. Si el analista cancela, el socket se cierra, la señal llega a
la llamada en curso y la generación se corta.

**Qué cambiaría con un segundo espectador.** SSE seguiría sirviendo, pero la
ejecución dejaría de estar atada a una petición HTTP: publicaría sus pasos en un
canal por sesión y cada espectador se suscribiría con su propio SSE. Lo que
obliga a cambiar no es el transporte, es la propiedad de la ejecución.

### Qué se emite y qué no

Los eventos dicen **qué** se hizo —herramienta invocada, fuente consultada,
resultado parcial— y nunca el contenido del prompt ni los mensajes intermedios
del modelo. El enunciado pide comunicar que hay un sistema trabajando «sin
exponer razonamientos internos sensibles», y esa frontera se decide aquí, en el
servidor, no en el frontend.

Hay latido cada 15 segundos: una ejecución puede durar más de lo que aguanta un
proxy sin tráfico, y un comentario SSE mantiene viva la conexión sin ensuciar el
flujo de eventos.

### La confirmación no duplica la regla

Los endpoints de confirmación y anulación **no comprueban G4 por su cuenta**: se
limitan a intentar la transición y a traducir el rechazo de la base de datos a un
mensaje útil. Duplicar la regla en la capa HTTP crearía una segunda versión de la
verdad que podría separarse de la primera sin que nadie se entere.

Se comprueba con un caso que lo demuestra: tras confirmar un dictamen, el
verificador intenta devolverlo a pendiente **por SQL directo** y el trigger lo
impide.

## Frontend

React 19 + Vite + Tailwind CSS v4, con TanStack Query para el estado del
servidor. Tema oscuro único —no un tema claro invertido— porque el analista pasa
horas leyendo expedientes y el blanco sostenido cansa.

### Tres reglas que gobiernan la paleta

1. **El acento (cian) señala actividad del sistema**: el agente trabajando,
   fuentes consultadas, progreso. Nunca decora.
2. **Los colores semánticos pertenecen a las decisiones de crédito y a nada más.**
   Verde es `APROBADO`, no «correcto»; ámbar es `ESCALADO`, no «aviso».
   Reutilizarlos haría ilegible la bandeja de un vistazo.
3. **Todo lo que sea dinero usa cifras tabulares.** Una columna de importes que no
   alinea es una columna que no se puede comparar.

El vocabulario del dominio vive en un módulo aparte de las primitivas. No es
diseño genérico: es la traducción de las decisiones a color y palabra, y tiene
que ser idéntica en la bandeja, en el detalle y en las métricas. Un
`ESCALADO_A_COMITE` que fuera ámbar en una pantalla y gris en otra obligaría al
analista a releer en vez de reconocer.

### Adaptable, sin duplicar lógica

La misma lista de navegación se pinta como barra lateral desde 768 px y como
barra inferior por debajo — al alcance del pulgar, que es donde tiene que estar
en una herramienta que se consulta de pie. En la bandeja, la tabla se convierte
en tarjetas: una fila de siete columnas en 375 px no se lee, se adivina.

Verificado a 375 px: tabla oculta, tarjetas visibles, navegación inferior
presente y **sin desbordamiento horizontal**.

El punto 5.6 deja el diseño adaptable avanzado fuera de alcance. Esto no lo es:
son dos disposiciones de la misma lista, sin lógica duplicada.

### Los números llevan su lectura al lado

El enunciado avisa de que la interfaz no debe parecer un tablero de inteligencia
de negocios. Por eso la vista de métricas no muestra «21,1 %» a secas sino
«aproximadamente una de cada cinco solicitudes necesita comité». Un número sin
interpretación obliga a interpretarlo cada vez.

### Dónde se convierte el decimal a número

En un solo sitio: la función de formato, en el último paso antes de pintar. En
todo el trayecto anterior —base de datos, API, cliente— el importe viaja como
cadena exacta.

## Chat, actividad del agente y dictamen en vivo

### Propuesta reversible frente a efecto confirmado (pregunta 3.3)

Es la distinción que gobierna todo el estado del cliente, que tiene tres capas
que nunca se mezclan:

- **`pasos`** — lo que el agente ha ido haciendo. Es narración: se puede perder
  sin consecuencias.
- **`propuesta`** — el dictamen que el modelo está intentando registrar. Es
  **reversible**: puede cambiar, puede ser tumbada por un guardarraíl, puede no
  llegar a existir. El panel la marca como tentativa, con franja de actividad y
  la palabra «propuesta».
- **`idDictamen`** — llega solo cuando el servidor confirma la escritura. A
  partir de ahí hay un **efecto confirmado**, y la verdad deja de estar en el
  cliente: está en la base de datos.

Por eso, al terminar, la interfaz **recarga el expediente desde la API** en vez
de pintar lo que tiene en memoria. El cliente nunca trata su vista local como
autoridad.

**Qué pasa al reconectar:** nada que reconstruir. Si la conexión se cae o el
analista cancela, el dictamen o se escribió o no, y eso se consulta. No se
reanuda el flujo. Reanudar exigiría que el servidor guardara el flujo a medias, y
no hay nada que ganar guardándolo: el único resultado que importa ya es
transaccional.

### Qué se muestra y qué no

Se muestra lo que el agente **hace**: herramienta invocada, consulta lanzada al
corpus, políticas recuperadas, dictamen propuesto, nivel de confianza. No se
muestra el prompt, ni los mensajes intermedios del modelo, ni nada que parezca
razonamiento interno — la frontera la decide el servidor, que solo emite
argumentos de herramienta y resultados.

La propuesta se pinta **en cuanto el modelo la intenta**, no cuando lo consigue.
Si un guardarraíl la tumba, el analista ve qué se propuso y por qué se rechazó.

### Dos fallos que encontró la verificación en navegador

**La ejecución se cancelaba sola.** La desconexión se detectaba con
`peticion.raw.on('close')`, pero en Node ese evento se dispara cuando termina de
leerse el **cuerpo de la petición**, no cuando el cliente se va. En un POST eso
ocurre de inmediato, así que toda ejecución se abortaba antes de la primera
llamada al modelo — con `iteraciones: 0` y ningún modelo intentado. Se escucha
ahora en el socket de **respuesta**, que sí refleja la desconexión real.

**La interfaz mentía sobre el resultado.** Al recibir el evento `fin` se daba la
ejecución por completada sin mirar el estado que devuelve el servidor. Una
ejecución `FALLIDA` también emite `fin`, así que el analista leía «ejecución
terminada» cuando el análisis no se había hecho. Ahora la fase la decide el
servidor y la interfaz solo la traduce.

Ninguno de los dos se habría visto sin ejecutar la interfaz contra el sistema
real.

## Documentación

- [`docs/00-analisis-enunciado.pdf`](docs/00-analisis-enunciado.pdf) — análisis del enunciado, stack y plan de módulos.
- [`docs/GITFLOW.md`](docs/GITFLOW.md) — modelo de ramas y convención de commits.
- [`docs/PLAN.md`](docs/PLAN.md) — plan de desarrollo por módulos.

## Entregables del examen

1. Repositorio (este).
2. Video de demostración.
3. Cuestionario técnico contestado — `docs/CUESTIONARIO.md`.
4. README de decisiones — `docs/DECISIONES.md`.
5. JSON de políticas extendido — `data/politicas.json`.
6. Script y resultados de los 10 casos de evaluación — `apps/api/src/eval/`.
7. Bitácora de aprendizaje — `docs/BITACORA.md`.
