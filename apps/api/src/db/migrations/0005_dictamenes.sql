-- ---------------------------------------------------------------------------
-- 0005 · Dictamenes. Aqui viven G3 y G4 respaldados por la base de datos.
-- ---------------------------------------------------------------------------

CREATE TYPE decision_dictamen AS ENUM ('APROBADO', 'RECHAZADO', 'ESCALADO_A_COMITE');
CREATE TYPE nivel_riesgo      AS ENUM ('BAJO', 'MEDIO', 'ALTO');
CREATE TYPE estado_dictamen   AS ENUM ('PENDIENTE_AUTORIZACION', 'EN_FIRME', 'ANULADO');

-- ---------------------------------------------------------------------------
-- Umbrales numericos de las politicas.
--
-- Un CHECK no puede leer prosa. Los numeros que G3 y G4 necesitan se extraen
-- del corpus a esta tabla, con el identificador de la politica que los
-- respalda para que el vinculo quede documentado y auditable. M3 rellena
-- id_politica al cargar el corpus.
-- ---------------------------------------------------------------------------
CREATE TABLE parametros_politica (
  clave       TEXT PRIMARY KEY,
  valor       NUMERIC(18, 6) NOT NULL,
  descripcion TEXT NOT NULL,
  id_politica TEXT REFERENCES politicas (id)
);

INSERT INTO parametros_politica (clave, valor, descripcion) VALUES
  ('tope_absoluto_monto',        500000,  'Tope maximo por operacion en GTQ (POL-4.1)'),
  ('porcentaje_ventas_max',      0.30,    'Fraccion maxima de las ventas anuales (POL-4.1)'),
  ('umbral_autorizacion_comite', 250000,  'Monto a partir del cual se exige comite (POL-6.2, G4)');

-- ---------------------------------------------------------------------------
CREATE TABLE dictamenes (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_solicitud              UUID NOT NULL REFERENCES solicitudes (id_solicitud),

  -- Idempotencia. La clave la genera el SERVIDOR, nunca el modelo: si la
  -- generara el LLM, un reintento disparado por el propio modelo produciria
  -- una clave distinta y la escritura se duplicaria, que es exactamente lo que
  -- la clave existe para impedir.
  clave_idempotencia        TEXT NOT NULL UNIQUE,

  decision                  decision_dictamen NOT NULL,
  monto_recomendado         NUMERIC(18, 2),
  plazo_recomendado_meses   INTEGER CHECK (plazo_recomendado_meses BETWEEN 1 AND 360),

  -- G3: operandos materializados por trigger desde la solicitud y los
  -- parametros de politica. Un CHECK solo ve columnas de su propia fila, asi
  -- que sin materializarlos la restriccion no podria existir. Al escribirlos
  -- la base de datos y no la aplicacion, el guardarrail no se puede burlar
  -- enviando un tope inflado.
  monto_solicitado_snapshot NUMERIC(18, 2) NOT NULL,
  tope_politica             NUMERIC(18, 2) NOT NULL,

  -- Indicadores CONGELADOS al momento de emision (pregunta 1.3 del
  -- cuestionario). Si manana se corrige el estado financiero, el dictamen debe
  -- seguir mostrando sobre que cifras se decidio; lo contrario haria que un
  -- expediente cambiara de sentido despues de firmado.
  ind_razon_endeudamiento      NUMERIC(14, 6),
  ind_margen_neto              NUMERIC(14, 6),
  ind_cobertura_servicio_deuda NUMERIC(14, 6),
  ind_relacion_monto_ventas    NUMERIC(14, 6),
  ind_antiguedad_meses         INTEGER NOT NULL,

  motivos                   TEXT[] NOT NULL CHECK (cardinality(motivos) >= 1),
  nivel_riesgo              nivel_riesgo NOT NULL,
  requiere_autorizacion_humana BOOLEAN NOT NULL,
  confianza                 NUMERIC(4, 3) NOT NULL CHECK (confianza >= 0 AND confianza <= 1),

  estado                    estado_dictamen NOT NULL DEFAULT 'PENDIENTE_AUTORIZACION',
  confirmado_por            TEXT,
  confirmado_en             TIMESTAMPTZ,
  motivo_anulacion          TEXT,

  id_ejecucion              UUID REFERENCES ejecuciones_agente (id) ON DELETE SET NULL,
  creado_en                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ---- G3 -----------------------------------------------------------------
  CONSTRAINT g3_no_supera_solicitado CHECK (
    monto_recomendado IS NULL OR monto_recomendado <= monto_solicitado_snapshot
  ),
  CONSTRAINT g3_no_supera_tope_politica CHECK (
    monto_recomendado IS NULL OR monto_recomendado <= tope_politica
  ),
  CONSTRAINT g3_monto_positivo CHECK (
    monto_recomendado IS NULL OR monto_recomendado > 0
  ),

  -- Coherencia de la decision: un rechazo no recomienda dinero.
  CONSTRAINT rechazo_sin_monto CHECK (
    decision <> 'RECHAZADO' OR monto_recomendado IS NULL
  ),
  CONSTRAINT aprobado_con_monto CHECK (
    decision <> 'APROBADO' OR (monto_recomendado IS NOT NULL AND plazo_recomendado_meses IS NOT NULL)
  ),

  -- ---- G4 -----------------------------------------------------------------
  -- La marca no la decide el modelo: se comprueba contra la regla.
  CONSTRAINT g4_marca_coherente CHECK (
    requiere_autorizacion_humana = (
      COALESCE(monto_recomendado, monto_solicitado_snapshot) > 250000
      OR nivel_riesgo = 'ALTO'
      OR decision = 'ESCALADO_A_COMITE'
    )
  ),
  -- Ningun dictamen queda en firme sin confirmacion explicita. El enunciado lo
  -- exige para monto alto o riesgo ALTO; se aplica a todos porque el principio
  -- rector es que el sistema no sustituye al analista.
  CONSTRAINT g4_en_firme_exige_confirmacion CHECK (
    estado <> 'EN_FIRME' OR (confirmado_por IS NOT NULL AND confirmado_en IS NOT NULL)
  ),
  CONSTRAINT confirmacion_completa CHECK (
    (confirmado_por IS NULL) = (confirmado_en IS NULL)
  ),
  CONSTRAINT anulacion_con_motivo CHECK (
    estado <> 'ANULADO' OR motivo_anulacion IS NOT NULL
  )
);

CREATE INDEX idx_dictamenes_solicitud ON dictamenes (id_solicitud, creado_en DESC);
CREATE INDEX idx_dictamenes_estado    ON dictamenes (estado);
CREATE INDEX idx_dictamenes_ejecucion ON dictamenes (id_ejecucion);

-- ---------------------------------------------------------------------------
-- Citas de politica. La clave foranea garantiza a nivel de base de datos que
-- la politica citada existe; que el TEXTO sea literal lo valida G1 en codigo,
-- como exige el enunciado.
-- ---------------------------------------------------------------------------
CREATE TABLE dictamen_citas (
  id            BIGSERIAL PRIMARY KEY,
  id_dictamen   UUID NOT NULL REFERENCES dictamenes (id) ON DELETE CASCADE,
  id_politica   TEXT NOT NULL REFERENCES politicas (id),
  seccion       TEXT NOT NULL,
  texto_literal TEXT NOT NULL CHECK (length(btrim(texto_literal)) > 0),
  orden         INTEGER NOT NULL CHECK (orden >= 0),

  UNIQUE (id_dictamen, orden)
);

CREATE INDEX idx_citas_politica ON dictamen_citas (id_politica);

-- "politicas_citadas: minimo 1 elemento". Se comprueba al confirmar la
-- transaccion, no en el INSERT, porque el dictamen se inserta antes que sus
-- citas. Diferido, el orden de escritura dentro de la transaccion deja de
-- importar y la garantia se mantiene.
CREATE FUNCTION fn_dictamen_exige_cita() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dictamen_citas WHERE id_dictamen = NEW.id) THEN
    RAISE EXCEPTION
      'El dictamen % no tiene ninguna cita de politica (guardarrail G1)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_dictamen_exige_cita
  AFTER INSERT ON dictamenes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_dictamen_exige_cita();
