-- ---------------------------------------------------------------------------
-- 0001 · Cimientos: tipos del dominio, funcion de normalizacion y solicitudes.
-- ---------------------------------------------------------------------------

-- Enumerados del enunciado (punto 5.2.1).
CREATE TYPE sector_negocio AS ENUM (
  'comercio', 'manufactura', 'servicios', 'agropecuario',
  'transporte', 'construccion', 'otros'
);

CREATE TYPE tipo_garantia AS ENUM ('ninguna', 'fiduciaria', 'prendaria', 'hipotecaria');

-- ---------------------------------------------------------------------------
-- Normalizacion de texto.
--
-- unaccent() es STABLE, no IMMUTABLE, porque depende del diccionario que se
-- resuelva por search_path. Fijando el diccionario de forma explicita la
-- funcion pasa a ser inmutable, que es lo que permite usarla en columnas
-- generadas y en indices.
--
-- IMPORTANTE: esta normalizacion sirve a la RECUPERACION lexica del modulo M6.
-- No es la que valida el guardarrail G1. El enunciado exige que la
-- verificacion de citas ocurra en codigo, y tener dos implementaciones de la
-- misma normalizacion —una en SQL y otra en JavaScript— crearia justo el tipo
-- de segunda fuente de verdad que G1 existe para impedir.
-- ---------------------------------------------------------------------------
CREATE FUNCTION texto_normalizado(entrada text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
$$
  SELECT lower(
           regexp_replace(
             public.unaccent('public.unaccent'::regdictionary, entrada),
             '\s+', ' ', 'g'
           )
         );
$$;

-- ---------------------------------------------------------------------------
-- Solicitudes de credito.
--
-- Decision deliberada: los campos financieros son NULL-ables y NO hay
-- restricciones entre columnas (nada de pasivos <= activos ni utilidad <=
-- ventas). El enunciado exige que al menos 5 solicitudes lleguen con datos
-- incompletos o inconsistentes; son entrada legitima del sistema, no datos
-- corruptos. Rechazarlas en el esquema haria imposible ejercitar el caso que
-- el propio examen pide probar. La deteccion de inconsistencias es trabajo de
-- la capa de dominio, que la reporta como hallazgo, no del motor de base de
-- datos, que la rechazaria en silencio.
-- ---------------------------------------------------------------------------
CREATE TABLE solicitudes (
  id_solicitud        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_empresa      TEXT NOT NULL CHECK (length(btrim(nombre_empresa)) > 0),
  sector              sector_negocio NOT NULL,
  meses_operacion     INTEGER NOT NULL CHECK (meses_operacion >= 0),
  monto_solicitado    NUMERIC(18, 2) NOT NULL CHECK (monto_solicitado > 0),
  plazo_meses         INTEGER NOT NULL CHECK (plazo_meses BETWEEN 1 AND 360),

  -- Entrada NO confiable (guardarrail G5). Se guarda tal cual la escribio el
  -- solicitante, sin sanear: sanear aqui destruiria la evidencia de los
  -- intentos de manipulacion que los casos adversariales deben poder mostrar.
  -- El aislamiento ocurre al construir el contexto del agente, no al guardar.
  destino_fondos      TEXT NOT NULL,

  ventas_anuales      NUMERIC(18, 2),
  utilidad_neta       NUMERIC(18, 2),
  activos_totales     NUMERIC(18, 2),
  pasivos_totales     NUMERIC(18, 2),
  deuda_vigente_anual NUMERIC(18, 2),

  score_historial     INTEGER CHECK (score_historial BETWEEN 0 AND 100),
  garantia_ofrecida   tipo_garantia NOT NULL,
  fecha_solicitud     DATE NOT NULL,

  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN solicitudes.destino_fondos IS
  'Texto libre del solicitante. Entrada no confiable segun el guardarrail G5.';

CREATE INDEX idx_solicitudes_fecha  ON solicitudes (fecha_solicitud DESC);
CREATE INDEX idx_solicitudes_sector ON solicitudes (sector);

-- Marca de tiempo de actualizacion, para que la invalidacion de indicadores
-- (migracion 0003) tenga siempre una referencia fiable.
CREATE FUNCTION fn_marcar_actualizacion() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_solicitudes_actualizacion
  BEFORE UPDATE ON solicitudes
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizacion();
