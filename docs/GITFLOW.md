# Modelo de ramas (GitFlow) y convención de commits

El desarrollo avanza **un módulo a la vez**. Cada módulo del plan
([`PLAN.md`](PLAN.md)) equivale exactamente a una rama de característica.

## Ramas permanentes

| Rama      | Propósito                                                                                  | Quién escribe en ella  |
| --------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| `main`    | Estado entregable. Solo recibe merges desde `release/*` o `hotfix/*`, siempre etiquetados. | Nadie directamente.    |
| `develop` | Integración continua de módulos terminados. Es la rama base de todo `feature/*`.           | Solo merges `--no-ff`. |

## Ramas temporales

| Patrón                | Nace de   | Muere en           | Ejemplo                                 |
| --------------------- | --------- | ------------------ | --------------------------------------- |
| `feature/M<n>-<slug>` | `develop` | `develop`          | `feature/M04-nucleo-financiero-decimal` |
| `release/<version>`   | `develop` | `main` + `develop` | `release/1.0.0`                         |
| `hotfix/<slug>`       | `main`    | `main` + `develop` | `hotfix/g3-check-constraint`            |

## Ciclo por módulo

```bash
git switch develop
git switch -c feature/M04-nucleo-financiero-decimal
# ... trabajo del módulo ...
git add -A && git commit -m "feat(indicadores): calculo decimal exacto de razon de endeudamiento"
git switch develop
git merge --no-ff feature/M04-nucleo-financiero-decimal
git branch -d feature/M04-nucleo-financiero-decimal
```

El merge es siempre `--no-ff` para que el historial conserve la frontera de cada
módulo: en la defensa técnica se puede señalar exactamente qué commits
introdujeron cada guardarraíl o cada decisión de arquitectura.

## Convención de commits

Conventional Commits, en español, con ámbito explícito:

```
<tipo>(<ámbito>): <descripción en imperativo, minúscula, sin punto final>
```

Tipos: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`.

Ámbitos del proyecto: `db`, `politicas`, `datos`, `indicadores`, `retrieval`,
`agente`, `tools`, `guardrails`, `dictamenes`, `observabilidad`, `api`, `web`,
`eval`, `docs`.

## Etiquetas

El plan original contemplaba una etiqueta anotada por cada bloque de módulos
cerrado en `develop` (`v0.1.0` … `v0.9.0`), pero en la práctica el ritmo de
desarrollo no dejó espacio para pararse a etiquetar cada bloque. La única
etiqueta que existe de verdad es la que importa para la entrega:

- `v1.0.0` — release final en `main`, con todo el trabajo hasta el punto de
  entrega del examen.
