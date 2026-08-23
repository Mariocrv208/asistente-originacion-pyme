import { createHash } from 'node:crypto';
import type { Dictamen } from '@aop/shared';
import { pool } from '../../db/pool.js';
import { Decimal } from '../finanzas/decimal.js';
import { verificarCitas } from '../politicas/citas.js';
import { indexar, leerCorpus } from '../politicas/corpus.js';
import { obtenerIndicadores } from '../indicadores/repositorio.js';

/**
 * Persistencia transaccional e idempotente del dictamen.
 *
 * Es el punto donde la propuesta del modelo se convierte —o no— en un hecho del
 * sistema. Aqui se aplican G1 y G2; G3 y G4 los aplica la propia base de datos
 * con sus restricciones, asi que ni siquiera hace falta comprobarlos: si algo
 * se colara, el INSERT falla.
 */

export interface Confirmacion {
  id_dictamen: string;
  estado: string;
  decision: string;
  /** true si la clave de idempotencia ya existia y no se escribio nada nuevo. */
  ya_existia: boolean;
  /** Ajustes que los guardarrailes impusieron sobre lo que propuso el modelo. */
  ajustes: string[];
}

export type ResultadoPersistencia =
  | { ok: true; confirmacion: Confirmacion }
  | {
      ok: false;
      codigo: 'G1_SIN_CITA_VERIFICABLE' | 'G2_INDICADORES_NO_COINCIDEN' | 'RECHAZO_BASE_DATOS';
      error: string;
    };

/**
 * Clave de idempotencia, generada por el SERVIDOR.
 *
 * El enunciado incluye clave_idempotencia en la firma de registrar_dictamen,
 * pero la clave NO puede venir del modelo (pregunta 1.2 del cuestionario). El
 * motivo es concreto: cuando el reintento lo dispara el propio LLM —porque no
 * recibio la respuesta de la herramienta y vuelve a invocarla— generaria una
 * clave nueva, la restriccion de unicidad no veria colision y se escribirian
 * dos dictamenes para la misma solicitud. La clave existe justo para impedir
 * eso, asi que tiene que derivarse de algo estable: la solicitud y la ejecucion
 * que la produjo.
 */
export function claveIdempotencia(idSolicitud: string, idEjecucion: string): string {
  return createHash('sha256').update(`${idSolicitud}:${idEjecucion}`).digest('hex').slice(0, 40);
}

/** Compara dos decimales opcionales por valor, no por texto. */
function mismoDecimal(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Decimal(a).equals(new Decimal(b));
}

export async function persistirDictamen(
  dictamen: Dictamen,
  idEjecucion: string,
): Promise<ResultadoPersistencia> {
  const clave = claveIdempotencia(dictamen.id_solicitud, idEjecucion);
  const ajustes: string[] = [];

  // ---- Idempotencia: antes que nada -------------------------------------
  const { rows: previos } = await pool.query<{ id: string; estado: string; decision: string }>(
    'SELECT id, estado, decision FROM dictamenes WHERE clave_idempotencia = $1',
    [clave],
  );
  if (previos[0]) {
    return {
      ok: true,
      confirmacion: {
        id_dictamen: previos[0].id,
        estado: previos[0].estado,
        decision: previos[0].decision,
        ya_existia: true,
        ajustes: ['La ejecucion ya habia registrado este dictamen. No se escribio nada nuevo.'],
      },
    };
  }

  // ---- G2: coherencia numerica ------------------------------------------
  // Se recalcula en codigo y se compara con lo que dice el dictamen. Si el
  // modelo invento, redondeo o copio mal un indicador, la persistencia se
  // rechaza. No se "corrige" en silencio: un dictamen cuyos numeros no son los
  // que el sistema calculo no es un dictamen, es otra cosa.
  const calculo = await obtenerIndicadores(dictamen.id_solicitud);
  if (!calculo) {
    return {
      ok: false,
      codigo: 'RECHAZO_BASE_DATOS',
      error: `La solicitud ${dictamen.id_solicitud} no existe.`,
    };
  }

  const reales = calculo.indicadores;
  const propuestos = dictamen.indicadores;
  const discrepancias: string[] = [];

  const comparar = (campo: keyof typeof propuestos, real: string | null) => {
    const valor = propuestos[campo] as string | null;
    if (!mismoDecimal(valor, real)) {
      discrepancias.push(
        `${campo}: el dictamen dice ${valor ?? 'null'}, el calculo da ${real ?? 'null'}`,
      );
    }
  };

  comparar('razon_endeudamiento', reales.razon_endeudamiento);
  comparar('margen_neto', reales.margen_neto);
  comparar('cobertura_servicio_deuda', reales.cobertura_servicio_deuda);
  comparar('relacion_monto_ventas', reales.relacion_monto_ventas);
  if (propuestos.antiguedad_meses !== reales.antiguedad_meses) {
    discrepancias.push(
      `antiguedad_meses: el dictamen dice ${propuestos.antiguedad_meses}, el calculo da ${reales.antiguedad_meses}`,
    );
  }

  if (discrepancias.length > 0) {
    return {
      ok: false,
      codigo: 'G2_INDICADORES_NO_COINCIDEN',
      error:
        'Los indicadores del dictamen no coinciden con el calculo del sistema. ' +
        'Copia EXACTAMENTE los valores que devuelve calcular_indicadores.\n' +
        discrepancias.map((d) => `  - ${d}`).join('\n'),
    };
  }

  // ---- G1: toda cita debe ser verificable --------------------------------
  const corpus = indexar(await leerCorpus());
  const veredicto = verificarCitas(dictamen.politicas_citadas, corpus);
  const verificadas = veredicto.veredictos.filter((v) => v.verificada).map((v) => v.cita);
  const rechazadas = veredicto.veredictos.filter((v) => !v.verificada);

  if (verificadas.length === 0) {
    return {
      ok: false,
      codigo: 'G1_SIN_CITA_VERIFICABLE',
      error:
        'Ninguna cita se pudo verificar contra el corpus. Toda decision necesita al menos una ' +
        'cita cuyo texto aparezca LITERALMENTE en la politica que dices citar.\n' +
        rechazadas.map((v) => `  - ${v.cita.id_politica}: ${v.detalle}`).join('\n'),
    };
  }

  let decision = dictamen.decision;
  if (rechazadas.length > 0) {
    // Alguna cita era inventada o estaba alterada. Aunque queden citas validas,
    // el razonamiento se apoyo en algo que no existe: se fuerza escalamiento,
    // como manda el guardarrail G1.
    decision = 'ESCALADO_A_COMITE';
    ajustes.push(
      `G1 forzo ESCALADO_A_COMITE: ${rechazadas.length} cita(s) no verificable(s) ` +
        `(${rechazadas.map((v) => `${v.cita.id_politica}/${v.motivo}`).join(', ')}).`,
    );
  }

  // ---- G4: la marca la decide la regla, no el modelo ---------------------
  const montoRelevante = new Decimal(dictamen.monto_recomendado ?? '0');
  const requiere =
    (dictamen.monto_recomendado !== null && montoRelevante.gt(250_000)) ||
    dictamen.nivel_riesgo === 'ALTO' ||
    decision === 'ESCALADO_A_COMITE';

  // Un rechazo no recomienda monto, y un escalamiento tampoco lo fija.
  const montoRecomendado = decision === 'APROBADO' ? dictamen.monto_recomendado : null;
  const plazoRecomendado = decision === 'APROBADO' ? dictamen.plazo_recomendado_meses : null;

  if (decision !== dictamen.decision || requiere !== dictamen.requiere_autorizacion_humana) {
    if (requiere !== dictamen.requiere_autorizacion_humana) {
      ajustes.push(
        `requiere_autorizacion_humana corregido a ${requiere}: lo determina la regla, no el modelo.`,
      );
    }
  }

  const motivos = [...dictamen.motivos, ...ajustes];

  // ---- Escritura transaccional -------------------------------------------
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const { rows } = await cliente.query<{ id: string; estado: string }>(
      `INSERT INTO dictamenes (
         id_solicitud, clave_idempotencia, decision, monto_recomendado,
         plazo_recomendado_meses, monto_solicitado_snapshot, tope_politica,
         ind_razon_endeudamiento, ind_margen_neto, ind_cobertura_servicio_deuda,
         ind_relacion_monto_ventas, ind_antiguedad_meses,
         motivos, nivel_riesgo, requiere_autorizacion_humana, confianza, id_ejecucion)
       VALUES ($1,$2,$3,$4,$5,0,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, estado`,
      [
        dictamen.id_solicitud,
        clave,
        decision,
        montoRecomendado,
        plazoRecomendado,
        reales.razon_endeudamiento,
        reales.margen_neto,
        reales.cobertura_servicio_deuda,
        reales.relacion_monto_ventas,
        reales.antiguedad_meses,
        motivos,
        dictamen.nivel_riesgo,
        requiere,
        dictamen.confianza,
        idEjecucion,
      ],
    );

    const id = rows[0]!.id;
    for (const [orden, cita] of verificadas.entries()) {
      await cliente.query(
        `INSERT INTO dictamen_citas (id_dictamen, id_politica, seccion, texto_literal, orden)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, cita.id_politica, cita.seccion, cita.texto_literal, orden],
      );
    }

    await cliente.query('COMMIT');

    return {
      ok: true,
      confirmacion: {
        id_dictamen: id,
        estado: rows[0]!.estado,
        decision,
        ya_existia: false,
        ajustes,
      },
    };
  } catch (error) {
    await cliente.query('ROLLBACK');

    // Aqui aterrizan G3 y G4 cuando la aplicacion deja pasar algo: los rechaza
    // la base de datos. El mensaje se devuelve al agente como valor, no como
    // excepcion, para que pueda corregir en vez de morir.
    const err = error as { constraint?: string; message?: string };
    return {
      ok: false,
      codigo: 'RECHAZO_BASE_DATOS',
      error: `La base de datos rechazo el dictamen${err.constraint ? ` por la restriccion ${err.constraint}` : ''}: ${err.message?.split('\n')[0] ?? 'sin detalle'}`,
    };
  } finally {
    cliente.release();
  }
}
