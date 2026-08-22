# Plan de desarrollo por módulos

Cada módulo es una unidad cerrada: se implementa, se verifica y se integra a
`develop` en su propia rama `feature/M<n>-<slug>` antes de pasar al siguiente.
El avance se dispara con el comando **`continua`**.

**M0 — Repositorio y GitFlow — COMPLETADO.**

---

## Bloque A · Cimientos

### M1 — Andamiaje del monorepo e infraestructura local
Monorepo pnpm (`apps/api`, `apps/web`, `packages/shared`). TypeScript estricto,
ESLint, Prettier. `docker-compose.yml` con PostgreSQL 16 + `pgvector`.
`.env.example` con todas las variables. Esqueleto Fastify que arranca y esqueleto
Vite que renderiza. Criterio de cierre: `pnpm dev` levanta API y web contra la base
de datos en contenedor.

### M2 — Esquema de base de datos y migraciones
Migraciones SQL versionadas: `solicitudes`, `indicadores`, `politicas`,
`politica_chunks` (vector), `dictamenes`, `dictamen_citas`, `agent_runs`,
`agent_steps`. Aquí viven las restricciones que el enunciado exige **a nivel de
base de datos**: el `CHECK` de G3 sobre `monto_recomendado` y la máquina de
estados de G4. Incluye la estrategia de precálculo de indicadores del 5.3.1 con
su mecanismo de invalidación. Criterio de cierre: migraciones aplicadas y
restricciones probadas con `INSERT` que deben fallar.

### M3 — Corpus de políticas
Extensión del JSON base a **≥25 políticas**, con ≥2 excepciones que modifican
parcialmente una regla anterior, ≥1 situación deliberadamente no cubierta (ruta
de escalamiento) y categorías suficientemente distintas para que la recuperación
tenga que discriminar. Cargador idempotente y verificación de integridad del
corpus. Criterio de cierre: corpus cargado y un test que detecta citas
inventadas.

---

## Bloque B · Dominio determinista

### M4 — Núcleo financiero en decimal exacto
`decimal.js` en todo el cálculo monetario. Cuota nivelada, tabla de amortización
iterativa (no recursiva), política de redondeo declarada, reparto del residuo en
la última cuota. Los cinco indicadores del 5.3.1. Criterio de cierre: la suma de
las cuotas cuadra exactamente contra capital más intereses.

### M5 — Generación de datos sintéticos
≥200 solicitudes con distribución realista por sector, **3+ con intentos de
manipulación en `destino_fondos`** y **5+ con datos financieros incompletos o
inconsistentes**. Histórico de dictámenes previos para alimentar la vista de
métricas. Seed determinista con semilla fija. Criterio de cierre: seed
reproducible byte a byte.

### M6 — Recuperación de políticas y verificación de citas
Estrategia híbrida: enrutamiento por categoría, recuperación léxica y vectorial
(`pgvector` con embeddings locales, sin costo ni clave externa). Resolución de
precedencia entre regla general y excepción. Verificador de literalidad de citas
(insumo de G1). Criterio de cierre: banco de consultas donde la excepción y su
regla general se recuperan juntas.

---

## Bloque C · Agente

### M7 — Ciclo de ejecución propio
Bucle del agente escrito a mano sobre el SDK del proveedor: despacho de
herramientas, criterio de parada, tope de iteraciones y de costo por ejecución,
prompts versionados en archivo. Criterio de cierre: una ejecución completa
imposible de convertir en bucle infinito.

### M8 — Herramientas del agente
Las cinco herramientas obligatorias con contrato de entrada y salida en Zod:
`obtener_solicitud`, `calcular_indicadores`, `buscar_politica`,
`registrar_dictamen`, `metricas_cartera`. Manejo de errores como valor de
retorno, no como excepción hacia el modelo.

### M9 — Salida estructurada y camino de fallo
Esquema `Dictamen` en Zod. Camino explícito para objeto inválido, incompleto o
fuera del enumerado: reparación dirigida con el error de validación como
retroalimentación, presupuesto acotado de intentos y degradación a
`ESCALADO_A_COMITE`. Documentado por qué esto supera al reintento ciego.

### M10 — Guardarraíles G1 a G5
Implementados en código, fuera del prompt: verificación literal de citas (G1),
recomputación y comparación de indicadores (G2), tope de monto respaldado por la
restricción de base de datos de M2 (G3), estado `PENDIENTE_AUTORIZACION` (G4) y
aislamiento de `destino_fondos` como entrada no confiable (G5). Criterio de
cierre: un test por guardarraíl que demuestra el bloqueo.

### M11 — Persistencia idempotente y observabilidad
Escritura transaccional del dictamen con clave de idempotencia **generada por el
servidor**, nunca por el modelo. Registro por ejecución de: identificador de
sesión, versión de prompt, modelo, secuencia de herramientas con argumentos y
resultados, tokens de entrada y salida, latencia y costo estimado.

---

## Bloque D · API

### M12 — API HTTP y streaming
Endpoints de solicitudes, dictámenes, confirmación del analista, métricas de
cartera y trazas de ejecución. Chat por SSE con cancelación real desde el cliente
(propagación de `AbortSignal` hasta el proveedor).

---

## Bloque E · Frontend

### M13 — Sistema de diseño y shell responsive
Tema oscuro especializado, tokens de color y tipografía, primitivas de interfaz,
navegación y layout adaptable de escritorio a móvil.

### M14 — Chat en streaming con actividad del agente
Renderizado incremental sin bloquear el hilo principal, cancelación, y línea de
tiempo que comunica qué está haciendo el agente: herramientas invocadas, fuentes
consultadas, resultados parciales.

### M15 — Panel de dictamen en vivo
Renderizado progresivo del objeto estructurado conforme el agente lo construye,
citas con identificador y sección, indicador de confianza, y confirmación
explícita del analista para G4. Distinción visual entre propuesta reversible y
efecto ya confirmado en el servidor.

### M16 — Bandeja y detalle de solicitudes
Listado filtrable con los indicadores precalculados y detalle con su historial de
dictámenes.

### M17 — Vista de métricas
Tres indicadores mínimos: solicitudes procesadas por estado, monto promedio
recomendado y tasa de escalamiento.

---

## Bloque F · Evaluación y punto extra

### M18 — Banco de evaluación
10 casos con resultado esperado según la distribución exigida (3 aprobación, 3
rechazo por motivos distintos, 2 escalamiento, 2 adversariales), script ejecutor
y reporte. Criterio de aprobación documentado.

### M19 — Punto extra 5.4: reranking con evidencia medida
Reordenamiento de los fragmentos recuperados y comparación A/B contra la línea
base de M6, con métricas de precisión de citas. Cubre también los puntos extra
del 5.3.2 por medir dos estrategias de acceso al corpus.

---

## Bloque G · Documentación y entrega

### M20 — README de decisiones y bitácora de aprendizaje
### M21 — Cuestionario, secciones 1 a 3 (bases de datos, backend, frontend)
### M22 — Cuestionario, sección 4 (IA) y tres preguntas de 4.F
### M23 — Cierre: `release/1.0.0`, etiqueta `v1.0.0` y guion del video
