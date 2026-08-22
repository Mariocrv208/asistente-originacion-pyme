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

| Comando          | Qué hace                                         |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | Levanta API y frontend en paralelo               |
| `pnpm dev:api`   | Solo la API                                      |
| `pnpm dev:web`   | Solo el frontend                                 |
| `pnpm typecheck` | Comprobación de tipos en todo el monorepo        |
| `pnpm lint`      | ESLint                                           |
| `pnpm format`    | Prettier en modo escritura                       |
| `pnpm db:up`     | Arranca PostgreSQL                               |
| `pnpm db:psql`   | Abre una sesión `psql` contra el contenedor      |
| `pnpm db:nuke`   | Destruye el contenedor **y su volumen de datos** |

### Variables de entorno

Todas están documentadas en `.env.example`. La única que exige intervención
manual es `OPENROUTER_API_KEY`, que se obtiene en
<https://openrouter.ai/keys> y **no se necesita hasta el módulo M7**: toda la
parte determinista del sistema —cálculo de indicadores, corpus de políticas,
guardarraíles— se desarrolla y se evalúa sin credenciales.

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
