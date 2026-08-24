import type { PoolClient } from 'pg';
import type { IndicadoresCalculados } from '@aop/shared';
import { pool } from '../../db/pool.js';
import { Decimal, desdeBd } from '../finanzas/decimal.js';
import { calcularIndicadores, VERSION_CALCULO, type EntradasIndicadores } from './calcular.js';

/**
 * Lectura y persistencia de los indicadores precalculados.
 *
 * Aqui se materializa la estrategia de precalculo documentada en el README y
 * en la migracion 0003: la aplicacion calcula, la tabla guarda, y el trigger
 * borra la fila en cuanto cambia una entrada. La ausencia de fila significa
 * "pendiente de recalculo", nunca "sin datos".
 */

type Ejecutor = Pick<PoolClient, 'query'>;

interface FilaSolicitud {
  monto_solicitado: string;
  plazo_meses: number;
  meses_operacion: number;
  ventas_anuales: string | null;
  utilidad_neta: string | null;
  activos_totales: string | null;
  pasivos_totales: string | null;
  deuda_vigente_anual: string | null;
  score_historial: number | null;
}

/** Tasa vigente, leida del mismo sitio del que la leen los guardarrailes. */
export async function tasaAnualReferencia(ejecutor: Ejecutor = pool): Promise<Decimal> {
  const { rows } = await ejecutor.query<{ valor: string }>(
    `SELECT valor FROM parametros_politica WHERE clave = 'tasa_anual_referencia'`,
  );
  const valor = rows[0]?.valor;
  if (valor === undefined) {
    throw new Error(
      'Falta el parametro tasa_anual_referencia. Ejecuta las migraciones: pnpm db:migrate',
    );
  }
  return new Decimal(valor);
}

export async function obtenerEntradas(
  idSolicitud: string,
  ejecutor: Ejecutor = pool,
): Promise<EntradasIndicadores | null> {
  const { rows } = await ejecutor.query<FilaSolicitud>(
    `SELECT monto_solicitado, plazo_meses, meses_operacion, ventas_anuales, utilidad_neta,
            activos_totales, pasivos_totales, deuda_vigente_anual, score_historial
       FROM solicitudes WHERE id_solicitud = $1`,
    [idSolicitud],
  );

  const f = rows[0];
  if (!f) return null;

  return {
    monto_solicitado: new Decimal(f.monto_solicitado),
    plazo_meses: f.plazo_meses,
    meses_operacion: f.meses_operacion,
    ventas_anuales: desdeBd(f.ventas_anuales),
    utilidad_neta: desdeBd(f.utilidad_neta),
    activos_totales: desdeBd(f.activos_totales),
    pasivos_totales: desdeBd(f.pasivos_totales),
    deuda_vigente_anual: desdeBd(f.deuda_vigente_anual),
    score_historial: f.score_historial,
    tasa_anual: await tasaAnualReferencia(ejecutor),
  };
}

async function guardar(
  idSolicitud: string,
  ind: IndicadoresCalculados,
  ejecutor: Ejecutor,
): Promise<void> {
  await ejecutor.query(
    `INSERT INTO indicadores_solicitud (
       id_solicitud, razon_endeudamiento, margen_neto, cobertura_servicio_deuda,
       relacion_monto_ventas, antiguedad_meses, tasa_anual_aplicada,
       cuota_mensual_estimada, cuota_anual_estimada, hallazgos,
       huella_entradas, version_calculo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id_solicitud) DO UPDATE SET
       razon_endeudamiento      = EXCLUDED.razon_endeudamiento,
       margen_neto              = EXCLUDED.margen_neto,
       cobertura_servicio_deuda = EXCLUDED.cobertura_servicio_deuda,
       relacion_monto_ventas    = EXCLUDED.relacion_monto_ventas,
       antiguedad_meses         = EXCLUDED.antiguedad_meses,
       tasa_anual_aplicada      = EXCLUDED.tasa_anual_aplicada,
       cuota_mensual_estimada   = EXCLUDED.cuota_mensual_estimada,
       cuota_anual_estimada     = EXCLUDED.cuota_anual_estimada,
       hallazgos                = EXCLUDED.hallazgos,
       huella_entradas          = EXCLUDED.huella_entradas,
       version_calculo          = EXCLUDED.version_calculo,
       calculado_en             = now()`,
    [
      idSolicitud,
      ind.razon_endeudamiento,
      ind.margen_neto,
      ind.cobertura_servicio_deuda,
      ind.relacion_monto_ventas,
      ind.antiguedad_meses,
      ind.tasa_anual_aplicada,
      ind.cuota_mensual_estimada,
      ind.cuota_anual_estimada,
      ind.hallazgos.map((h) => h.codigo),
      ind.huella_entradas,
      ind.version_calculo,
    ],
  );
}

/**
 * Devuelve los indicadores de una solicitud, calculandolos si hace falta.
 *
 * Es el punto por el que pasan la herramienta calcular_indicadores y el
 * guardarrail G2. Que ambos usen esta misma ruta es lo que hace que la
 * comparacion de G2 tenga sentido.
 *
 * El precalculo se aprovecha solo si la huella coincide: la version del
 * algoritmo forma parte de la huella, asi que cambiar la formula invalida todo
 * lo precalculado sin necesidad de vaciar la tabla a mano.
 */
export async function obtenerIndicadores(
  idSolicitud: string,
  ejecutor: Ejecutor = pool,
): Promise<{ indicadores: IndicadoresCalculados; recalculado: boolean } | null> {
  const entradas = await obtenerEntradas(idSolicitud, ejecutor);
  if (!entradas) return null;

  const recien = calcularIndicadores(entradas);

  const { rows } = await ejecutor.query<{ huella_entradas: string; version_calculo: string }>(
    `SELECT huella_entradas, version_calculo FROM indicadores_solicitud WHERE id_solicitud = $1`,
    [idSolicitud],
  );

  const precalculo = rows[0];
  const vigente =
    precalculo?.huella_entradas === recien.huella_entradas &&
    precalculo?.version_calculo === VERSION_CALCULO;

  if (!vigente) {
    await guardar(idSolicitud, recien, ejecutor);
  }

  return { indicadores: recien, recalculado: !vigente };
}

/** Recalcula todo lo que el trigger de invalidacion haya dejado pendiente. */
export async function recalcularPendientes(): Promise<number> {
  const { rows } = await pool.query<{ id_solicitud: string }>(
    'SELECT id_solicitud FROM solicitudes_sin_indicadores',
  );
  for (const { id_solicitud } of rows) {
    await obtenerIndicadores(id_solicitud);
  }
  return rows.length;
}
