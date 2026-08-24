-- ---------------------------------------------------------------------------
-- 0002 · Corpus de politicas de credito.
-- ---------------------------------------------------------------------------

CREATE TYPE severidad_politica AS ENUM ('bloqueante', 'informativa');

-- Las categorias viven en una tabla y no en un ENUM a proposito: el modulo M3
-- extiende el corpus a 25 o mas politicas y necesita categorias nuevas.
-- Anadir una fila no requiere migracion; ampliar un ENUM si.
CREATE TABLE categorias_politica (
  categoria   TEXT PRIMARY KEY CHECK (categoria ~ '^[a-z_]+$'),
  descripcion TEXT NOT NULL
);

INSERT INTO categorias_politica (categoria, descripcion) VALUES
  ('capacidad_pago', 'Razones financieras que miden la capacidad de servir la deuda'),
  ('elegibilidad',   'Requisitos minimos del solicitante para ser sujeto de credito'),
  ('monto',          'Topes de monto y plazo'),
  ('garantia',       'Exigencias de garantia segun perfil de riesgo'),
  ('sector',         'Restricciones por actividad economica'),
  ('autorizacion',   'Niveles de autorizacion y delegacion'),
  ('excepcion',      'Reglas que modifican parcialmente una politica anterior');

CREATE TABLE politicas (
  id                TEXT PRIMARY KEY CHECK (id ~ '^POL-[0-9]+\.[0-9]+$'),
  version_corpus    TEXT NOT NULL,
  seccion           TEXT NOT NULL,
  categoria         TEXT NOT NULL REFERENCES categorias_politica (categoria),
  texto             TEXT NOT NULL CHECK (length(btrim(texto)) > 0),
  severidad         severidad_politica NOT NULL,

  -- Excepciones: politicas que modifican parcialmente a otras, como POL-7.3
  -- sobre POL-2.3. Guardar la relacion de forma explicita es lo que permite
  -- recuperar la regla general junto a su excepcion en vez de confiar en que
  -- la busqueda por similitud las traiga juntas por casualidad.
  modifica_a        TEXT[] NOT NULL DEFAULT '{}',

  vigente_desde     DATE NOT NULL DEFAULT CURRENT_DATE,
  vigente_hasta     DATE,

  -- Solo para la recuperacion lexica de M6. Ver la nota de texto_normalizado()
  -- en la migracion 0001: G1 valida en codigo, no contra esta columna.
  texto_busqueda    TEXT GENERATED ALWAYS AS (texto_normalizado(texto)) STORED,

  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vigencia_coherente CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde),
  -- Una politica no puede declararse excepcion de si misma.
  CONSTRAINT no_se_modifica_a_si_misma CHECK (NOT (id = ANY (modifica_a)))
);

CREATE INDEX idx_politicas_categoria ON politicas (categoria);
CREATE INDEX idx_politicas_modifica  ON politicas USING gin (modifica_a);
-- Trigramas sobre el texto normalizado: recuperacion lexica tolerante a
-- variaciones de redaccion (modulo M6).
CREATE INDEX idx_politicas_busqueda  ON politicas USING gin (texto_busqueda gin_trgm_ops);

-- Integridad referencial de las excepciones: cada id listado en modifica_a
-- debe existir. Un array no admite clave foranea, asi que se comprueba con un
-- trigger diferido, para que el orden de insercion del corpus no importe.
CREATE FUNCTION fn_validar_modifica_a() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  referencia TEXT;
BEGIN
  FOREACH referencia IN ARRAY NEW.modifica_a LOOP
    IF NOT EXISTS (SELECT 1 FROM politicas WHERE id = referencia) THEN
      RAISE EXCEPTION
        'La politica % declara modificar a %, que no existe en el corpus',
        NEW.id, referencia
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_politicas_modifica_a
  AFTER INSERT OR UPDATE ON politicas
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_validar_modifica_a();

-- ---------------------------------------------------------------------------
-- Fragmentos vectoriales del corpus (se llenan en M6).
--
-- 384 dimensiones: es lo que produce el modelo de embeddings local previsto
-- (familia MiniLM / e5-small). Se fija aqui porque pgvector exige dimension
-- declarada.
--
-- Sin indice ANN a proposito. Con un corpus de 25 a 40 politicas, un recorrido
-- secuencial exacto es mas rapido que cualquier grafo HNSW y ademas da recall
-- perfecto. El indice se anadira si el corpus crece, y esa decision se discute
-- en la respuesta a la pregunta 1.1 del cuestionario.
-- ---------------------------------------------------------------------------
CREATE TABLE politica_fragmentos (
  id           BIGSERIAL PRIMARY KEY,
  id_politica  TEXT NOT NULL REFERENCES politicas (id) ON DELETE CASCADE,
  indice       INTEGER NOT NULL CHECK (indice >= 0),
  texto        TEXT NOT NULL,
  embedding    vector(384),
  modelo       TEXT,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (id_politica, indice)
);
