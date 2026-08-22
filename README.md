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

| Comando             | Qué hace                                              |
| ------------------- | ----------------------------------------------------- |
| `pnpm dev`          | Levanta API y frontend en paralelo                    |
| `pnpm dev:api`      | Solo la API                                           |
| `pnpm dev:web`      | Solo el frontend                                      |
| `pnpm typecheck`    | Comprobación de tipos en todo el monorepo             |
| `pnpm lint`         | ESLint                                                |
| `pnpm format`       | Prettier en modo escritura                            |
| `pnpm db:up`        | Arranca PostgreSQL                                    |
| `pnpm db:migrate`   | Aplica las migraciones pendientes                     |
| `pnpm db:verificar` | Comprueba que las restricciones rechazan lo que deben |
| `pnpm db:psql`      | Abre una sesión `psql` contra el contenedor           |
| `pnpm db:nuke`      | Destruye el contenedor **y su volumen de datos**      |

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
