# Asistente de Originación Crediticia PyME

Examen práctico de AI Engineer — Gerencia de Innovación.

> **Estado:** en construcción. Este README se completa en el módulo M19 con las
> decisiones técnicas exigidas por el punto 5.3.2 y 5.3.1 del enunciado.

## Stack elegido

| Capa | Elección |
| --- | --- |
| Backend | Node.js 24 + TypeScript (Fastify) |
| Framework de agentes | Llamada directa al SDK del proveedor (`openai` apuntando a OpenRouter) con ciclo de ejecución propio |
| Frontend | React 19 + TypeScript + Vite |
| Base de datos | PostgreSQL 16 + `pgvector` en contenedor |
| Proveedor de LLM | OpenRouter (modelos gratuitos) |
| Decimal exacto | `decimal.js` + `NUMERIC(18,2)` en PostgreSQL |
| Validación de salida estructurada | Zod |

La justificación de cada elección —en particular por qué se escribe el ciclo del
agente a mano en vez de usar Mastra— está en [`docs/DECISIONES.md`](docs/DECISIONES.md).

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
