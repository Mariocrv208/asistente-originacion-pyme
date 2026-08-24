-- ---------------------------------------------------------------------------
-- 0004 · Observabilidad de las ejecuciones del agente (punto 5.3.7).
--
-- Va antes que los dictamenes porque un dictamen apunta a la ejecucion que lo
-- produjo. Ese enlace es lo que convierte la pregunta del regulador —"por que
-- se rechazo esta solicitud hace seis meses"— en una consulta y no en una
-- reconstruccion.
-- ---------------------------------------------------------------------------

CREATE TYPE estado_ejecucion AS ENUM (
  'EN_CURSO',
  'COMPLETADA',
  'FALLIDA',
  'CANCELADA',        -- el analista aborto el streaming desde la interfaz
  'TOPE_EXCEDIDO'     -- corto el limite de iteraciones, de costo o de tiempo
);

CREATE TYPE tipo_paso AS ENUM (
  'LLM',              -- turno del modelo
  'HERRAMIENTA',      -- invocacion de una tool con sus argumentos y resultado
  'GUARDARRAIL',      -- veredicto de G1..G5
  'REPARACION'        -- reintento dirigido tras salida estructurada invalida
);

CREATE TABLE ejecuciones_agente (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_sesion          UUID NOT NULL,
  id_solicitud       UUID REFERENCES solicitudes (id_solicitud) ON DELETE SET NULL,

  version_prompt     TEXT NOT NULL,
  modelo             TEXT NOT NULL,
  -- Con modelos gratuitos el primero devuelve 429 a menudo y se cae a la
  -- reserva. Registrar la cascada completa evita comparar metricas de
  -- ejecuciones que en realidad corrieron sobre modelos distintos.
  modelos_intentados TEXT[] NOT NULL DEFAULT '{}',

  estado             estado_ejecucion NOT NULL DEFAULT 'EN_CURSO',
  iteraciones        INTEGER NOT NULL DEFAULT 0 CHECK (iteraciones >= 0),

  tokens_entrada     INTEGER NOT NULL DEFAULT 0 CHECK (tokens_entrada >= 0),
  tokens_salida      INTEGER NOT NULL DEFAULT 0 CHECK (tokens_salida >= 0),
  -- Seis decimales: una ejecucion con modelo gratuito cuesta fracciones de
  -- centavo y redondear a dos haria que todo pareciera valer cero.
  costo_estimado_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (costo_estimado_usd >= 0),

  latencia_ms        INTEGER CHECK (latencia_ms >= 0),
  iniciado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_en      TIMESTAMPTZ,
  error              TEXT,

  CONSTRAINT terminal_tiene_fin CHECK (
    (estado = 'EN_CURSO') = (finalizado_en IS NULL)
  ),
  CONSTRAINT fin_no_precede_inicio CHECK (
    finalizado_en IS NULL OR finalizado_en >= iniciado_en
  )
);

CREATE INDEX idx_ejecuciones_sesion    ON ejecuciones_agente (id_sesion, iniciado_en DESC);
CREATE INDEX idx_ejecuciones_solicitud ON ejecuciones_agente (id_solicitud);
CREATE INDEX idx_ejecuciones_estado    ON ejecuciones_agente (estado);

CREATE TABLE pasos_agente (
  id             BIGSERIAL PRIMARY KEY,
  id_ejecucion   UUID NOT NULL REFERENCES ejecuciones_agente (id) ON DELETE CASCADE,
  indice         INTEGER NOT NULL CHECK (indice >= 0),
  tipo           tipo_paso NOT NULL,

  -- Nombre de la herramienta, del guardarrail o del modelo, segun el tipo.
  nombre         TEXT NOT NULL,
  argumentos     JSONB,
  resultado      JSONB,
  error          TEXT,

  tokens_entrada INTEGER CHECK (tokens_entrada >= 0),
  tokens_salida  INTEGER CHECK (tokens_salida >= 0),
  latencia_ms    INTEGER CHECK (latencia_ms >= 0),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (id_ejecucion, indice)
);

COMMENT ON TABLE pasos_agente IS
  'Secuencia completa y ordenada de una ejecucion: cada llamada al modelo, '
  'cada herramienta con sus argumentos y su resultado, y cada veredicto de '
  'guardarrail. Es la traza que sustenta la auditabilidad del punto 4.5.';
