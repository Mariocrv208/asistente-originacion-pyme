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

| Comando                   | Qué hace                                              |
| ------------------------- | ----------------------------------------------------- |
| `pnpm dev`                | Levanta API y frontend en paralelo                    |
| `pnpm dev:api`            | Solo la API                                           |
| `pnpm dev:web`            | Solo el frontend                                      |
| `pnpm typecheck`          | Comprobación de tipos en todo el monorepo             |
| `pnpm lint`               | ESLint                                                |
| `pnpm format`             | Prettier en modo escritura                            |
| `pnpm db:up`              | Arranca PostgreSQL                                    |
| `pnpm db:migrate`         | Aplica las migraciones pendientes                     |
| `pnpm db:verificar`       | Comprueba que las restricciones rechazan lo que deben |
| `pnpm corpus:cargar`      | Carga el corpus de políticas (idempotente)            |
| `pnpm corpus:verificar`   | Integridad del corpus y verificación de citas         |
| `pnpm finanzas:verificar` | Amortización, redondeo e indicadores del punto 5.3.1  |
| `pnpm db:psql`            | Abre una sesión `psql` contra el contenedor           |
| `pnpm db:nuke`            | Destruye el contenedor **y su volumen de datos**      |

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
