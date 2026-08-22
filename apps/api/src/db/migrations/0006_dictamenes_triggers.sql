-- ---------------------------------------------------------------------------
-- 0006 · Materializacion de G3 y maquina de estados de G4.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- G3 · La base de datos calcula los operandos de sus propias restricciones.
--
-- Si monto_solicitado_snapshot y tope_politica los escribiera la aplicacion,
-- bastaria con enviar un tope inflado para que el CHECK pasara. Al derivarlos
-- aqui, desde la solicitud y desde parametros_politica, la restriccion es
-- verdaderamente de base de datos: no hay valor que la aplicacion pueda mandar
-- para saltarsela.
--
-- Sin ventas anuales declaradas el tope por ventas no existe y se fija en
-- cero, lo que obliga a monto_recomendado NULL. Es el resultado correcto:
-- POL-4.1 limita al 30 % de las ventas declaradas, y sin ventas declaradas no
-- hay nada que aprobar. La decision puede seguir siendo escalamiento.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_dictamen_materializar_g3() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  v_monto_solicitado NUMERIC(18, 2);
  v_ventas           NUMERIC(18, 2);
  v_tope_absoluto    NUMERIC(18, 6);
  v_porcentaje       NUMERIC(18, 6);
BEGIN
  SELECT monto_solicitado, ventas_anuales
    INTO v_monto_solicitado, v_ventas
    FROM solicitudes
   WHERE id_solicitud = NEW.id_solicitud;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La solicitud % no existe', NEW.id_solicitud
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT valor INTO STRICT v_tope_absoluto
    FROM parametros_politica WHERE clave = 'tope_absoluto_monto';
  SELECT valor INTO STRICT v_porcentaje
    FROM parametros_politica WHERE clave = 'porcentaje_ventas_max';

  NEW.monto_solicitado_snapshot := v_monto_solicitado;
  NEW.tope_politica := LEAST(
    v_tope_absoluto,
    COALESCE(round(v_ventas * v_porcentaje, 2), 0)
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dictamen_materializar_g3
  BEFORE INSERT ON dictamenes
  FOR EACH ROW EXECUTE FUNCTION fn_dictamen_materializar_g3();

-- ---------------------------------------------------------------------------
-- El umbral de G4 aparece como literal dentro de un CHECK, porque un CHECK no
-- admite subconsultas. Este trigger impide que ese literal y el valor de
-- parametros_politica se separen sin que nadie se entere.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_verificar_umbral_g4() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  v_umbral NUMERIC(18, 6);
BEGIN
  SELECT valor INTO STRICT v_umbral
    FROM parametros_politica WHERE clave = 'umbral_autorizacion_comite';

  IF v_umbral <> 250000 THEN
    RAISE EXCEPTION
      'umbral_autorizacion_comite vale % pero la restriccion g4_marca_coherente '
      'tiene 250000 escrito en duro. Cambia ambos con una migracion.', v_umbral
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_verificar_umbral_g4
  BEFORE INSERT ON dictamenes
  FOR EACH ROW EXECUTE FUNCTION fn_verificar_umbral_g4();

-- ---------------------------------------------------------------------------
-- G4 · Maquina de estados.
--
-- Transiciones permitidas:
--   PENDIENTE_AUTORIZACION -> EN_FIRME   (exige confirmacion explicita)
--   PENDIENTE_AUTORIZACION -> ANULADO
--   EN_FIRME               -> ANULADO
--   ANULADO                -> (terminal)
--
-- Ademas, un dictamen deja de ser modificable en cuanto sale de
-- PENDIENTE_AUTORIZACION. Un expediente que puede reescribirse despues de
-- firmado no sirve como evidencia de auditoria, que es justo el hallazgo que
-- el sistema viene a resolver.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_dictamen_transicion() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  -- Los operandos de G3 y el vinculo con la solicitud son inmutables: se
  -- fijaron al emitir y congelan el contexto de la decision.
  IF NEW.id_solicitud IS DISTINCT FROM OLD.id_solicitud
     OR NEW.monto_solicitado_snapshot IS DISTINCT FROM OLD.monto_solicitado_snapshot
     OR NEW.tope_politica IS DISTINCT FROM OLD.tope_politica
     OR NEW.clave_idempotencia IS DISTINCT FROM OLD.clave_idempotencia
  THEN
    RAISE EXCEPTION
      'No se pueden alterar la solicitud, la clave de idempotencia ni los '
      'topes materializados de un dictamen ya emitido'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.estado <> 'PENDIENTE_AUTORIZACION' THEN
    IF NEW.decision IS DISTINCT FROM OLD.decision
       OR NEW.monto_recomendado IS DISTINCT FROM OLD.monto_recomendado
       OR NEW.plazo_recomendado_meses IS DISTINCT FROM OLD.plazo_recomendado_meses
       OR NEW.nivel_riesgo IS DISTINCT FROM OLD.nivel_riesgo
       OR NEW.motivos IS DISTINCT FROM OLD.motivos
       OR NEW.ind_razon_endeudamiento IS DISTINCT FROM OLD.ind_razon_endeudamiento
       OR NEW.ind_margen_neto IS DISTINCT FROM OLD.ind_margen_neto
       OR NEW.ind_cobertura_servicio_deuda IS DISTINCT FROM OLD.ind_cobertura_servicio_deuda
       OR NEW.ind_relacion_monto_ventas IS DISTINCT FROM OLD.ind_relacion_monto_ventas
       OR NEW.ind_antiguedad_meses IS DISTINCT FROM OLD.ind_antiguedad_meses
    THEN
      RAISE EXCEPTION
        'El dictamen % esta en estado % y su contenido ya no es modificable',
        OLD.id, OLD.estado
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    IF NOT (
      (OLD.estado = 'PENDIENTE_AUTORIZACION' AND NEW.estado IN ('EN_FIRME', 'ANULADO'))
      OR (OLD.estado = 'EN_FIRME' AND NEW.estado = 'ANULADO')
    ) THEN
      RAISE EXCEPTION 'Transicion de estado no permitida: % -> %', OLD.estado, NEW.estado
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dictamen_transicion
  BEFORE UPDATE ON dictamenes
  FOR EACH ROW EXECUTE FUNCTION fn_dictamen_transicion();

-- Las citas de un dictamen que ya salio de PENDIENTE_AUTORIZACION tampoco se
-- tocan: son la justificacion que sustenta la decision.
CREATE FUNCTION fn_citas_inmutables() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  v_estado estado_dictamen;
  v_id     UUID := COALESCE(NEW.id_dictamen, OLD.id_dictamen);
BEGIN
  SELECT estado INTO v_estado FROM dictamenes WHERE id = v_id;

  -- Si el dictamen ya no existe estamos dentro de un borrado en cascada.
  IF FOUND AND v_estado <> 'PENDIENTE_AUTORIZACION' THEN
    RAISE EXCEPTION
      'No se pueden modificar las citas del dictamen %, que esta en estado %',
      v_id, v_estado
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_citas_inmutables
  BEFORE INSERT OR UPDATE OR DELETE ON dictamen_citas
  FOR EACH ROW EXECUTE FUNCTION fn_citas_inmutables();
