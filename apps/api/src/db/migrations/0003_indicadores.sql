-- ---------------------------------------------------------------------------
-- 0003 · Indicadores financieros precalculados (punto 5.3.1).
--
-- ESTRATEGIA DE PRECALCULO ELEGIDA: tabla materializada por la aplicacion,
-- con invalidacion por trigger.
--
-- El enunciado ofrece cuatro opciones: vista materializada, columna generada,
-- trigger o cache en aplicacion. Cuatro de los cinco indicadores son cocientes
-- de columnas de la misma fila y se expresarian sin esfuerzo como columnas
-- generadas STORED, que ademas harian la invalidacion imposible de equivocar,
-- porque PostgreSQL las recalcula solo.
--
-- Aun asi se descartan, por dos razones:
--
--   1. El punto 5.3.1 exige que los indicadores se calculen EN CODIGO con el
--      tipo decimal exacto del lenguaje. Una columna generada los calcularia
--      en SQL.
--   2. Mas importante: el guardarrail G2 rechaza la persistencia cuando un
--      indicador del dictamen no coincide con la salida de
--      calcular_indicadores. Para que esa comparacion signifique algo,
--      calcular_indicadores tiene que ser la unica fuente de verdad. Una
--      columna generada seria una segunda implementacion del mismo calculo, en
--      otro lenguaje y con otras reglas de redondeo, capaz de discrepar en
--      silencio. G2 existe precisamente para impedir que haya dos fuentes.
--
-- El quinto indicador, la cobertura de servicio de deuda, cierra el argumento:
-- depende de la cuota anual del credito nuevo, que sale de la formula de
-- amortizacion y de una tasa que no vive en la fila. Ninguna columna generada
-- puede calcularlo.
--
-- INVALIDACION: la ausencia de fila ES la invalidacion. El trigger de mas
-- abajo borra la fila de indicadores en cuanto cambia cualquier entrada del
-- calculo. No existe el estado "calculado pero obsoleto", que es donde suelen
-- vivir los errores de un cache. Un LEFT JOIN revela al instante que
-- solicitudes necesitan recalculo.
-- ---------------------------------------------------------------------------

CREATE TABLE indicadores_solicitud (
  id_solicitud             UUID PRIMARY KEY
                             REFERENCES solicitudes (id_solicitud) ON DELETE CASCADE,

  -- NUMERIC, nunca punto flotante. Se admiten NULL: con ventas o activos
  -- ausentes o en cero el cociente no esta definido, y "no calculable" es un
  -- resultado legitimo que el dictamen debe poder explicar. Sustituirlo por
  -- cero seria inventar un dato.
  razon_endeudamiento      NUMERIC(14, 6),
  margen_neto              NUMERIC(14, 6),
  cobertura_servicio_deuda NUMERIC(14, 6),
  relacion_monto_ventas    NUMERIC(14, 6),
  antiguedad_meses         INTEGER NOT NULL CHECK (antiguedad_meses >= 0),

  -- Insumos del calculo de cobertura, guardados para que el resultado sea
  -- reproducible seis meses despues sin tener que adivinar con que tasa se
  -- calculo (auditoria: pregunta 4.5 del cuestionario).
  tasa_anual_aplicada      NUMERIC(8, 6) NOT NULL CHECK (tasa_anual_aplicada >= 0),
  cuota_mensual_estimada   NUMERIC(18, 2) CHECK (cuota_mensual_estimada >= 0),
  cuota_anual_estimada     NUMERIC(18, 2) CHECK (cuota_anual_estimada >= 0),

  -- Hallazgos de consistencia detectados al calcular: pasivos mayores que
  -- activos, utilidad superior a ventas, campos ausentes. No son un error del
  -- calculo, son informacion para el dictamen.
  hallazgos                TEXT[] NOT NULL DEFAULT '{}',

  -- Defensa en profundidad sobre la invalidacion: huella de las entradas y
  -- version del algoritmo. Si el trigger fallara o alguien cargara datos
  -- saltandoselo, la discrepancia de huella lo delata.
  huella_entradas          TEXT NOT NULL,
  version_calculo          TEXT NOT NULL,

  calculado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE indicadores_solicitud IS
  'Indicadores del punto 5.3.1, calculados en aplicacion con decimal.js. '
  'Una fila ausente significa "pendiente de recalculo", nunca "sin datos".';

-- ---------------------------------------------------------------------------
-- Invalidacion.
--
-- El trigger se dispara solo cuando cambia alguna columna que participa en el
-- calculo. UPDATE OF limita el disparo a nivel de sentencia; la comparacion
-- IS DISTINCT FROM del cuerpo lo confirma a nivel de fila, porque UPDATE OF se
-- activa aunque el valor asignado sea identico al anterior.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_invalidar_indicadores() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF ROW (
       NEW.monto_solicitado, NEW.plazo_meses, NEW.ventas_anuales,
       NEW.utilidad_neta, NEW.activos_totales, NEW.pasivos_totales,
       NEW.deuda_vigente_anual, NEW.meses_operacion
     ) IS DISTINCT FROM ROW (
       OLD.monto_solicitado, OLD.plazo_meses, OLD.ventas_anuales,
       OLD.utilidad_neta, OLD.activos_totales, OLD.pasivos_totales,
       OLD.deuda_vigente_anual, OLD.meses_operacion
     )
  THEN
    DELETE FROM indicadores_solicitud WHERE id_solicitud = NEW.id_solicitud;
  END IF;
  RETURN NULL; -- AFTER trigger: el valor de retorno se ignora.
END;
$$;

CREATE TRIGGER trg_invalidar_indicadores
  AFTER UPDATE OF
    monto_solicitado, plazo_meses, ventas_anuales, utilidad_neta,
    activos_totales, pasivos_totales, deuda_vigente_anual, meses_operacion
  ON solicitudes
  FOR EACH ROW EXECUTE FUNCTION fn_invalidar_indicadores();

-- Vista de conveniencia: solicitudes cuyos indicadores hay que recalcular.
CREATE VIEW solicitudes_sin_indicadores AS
  SELECT s.id_solicitud, s.nombre_empresa, s.actualizado_en
    FROM solicitudes s
    LEFT JOIN indicadores_solicitud i USING (id_solicitud)
   WHERE i.id_solicitud IS NULL;
