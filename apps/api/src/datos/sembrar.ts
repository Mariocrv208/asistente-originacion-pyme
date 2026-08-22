/**
 * Siembra del conjunto sintetico en la base de datos.
 *
 * Es idempotente: se puede reejecutar sin duplicar nada.
 *
 * Los dictamenes historicos se insertan recorriendo su CICLO DE VIDA REAL, no
 * escribiendo el estado final de golpe:
 *
 *   1. el dictamen nace en PENDIENTE_AUTORIZACION;
 *   2. se le anaden sus citas;
 *   3. si el historico dice que quedo en firme, se confirma con un UPDATE.
 *
 * No es un capricho. El trigger trg_citas_inmutables rechaza anadir citas a un
 * dictamen que ya salio de PENDIENTE_AUTORIZACION, asi que insertarlo
 * directamente como EN_FIRME haria imposible citarlo. Que la siembra tenga que
 * respetar el ciclo es una confirmacion de que la maquina de estados de G4
 * funciona tambien contra datos realistas, y no solo contra el script de
 * verificacion de M2.
 */
import { readFile } from 'node:fs/promises';
import { pool, cerrarPool } from '../db/pool.js';
import { RUTA_DATASET, type DictamenHistorico, type SolicitudSintetica } from './generar.js';

interface Dataset {
  solicitudes: SolicitudSintetica[];
  dictamenes_historicos: DictamenHistorico[];
}

export async function sembrar(): Promise<{
  solicitudes: number;
  indicadores: number;
  dictamenes: number;
  yaEstaban: number;
}> {
  const dataset = JSON.parse(await readFile(RUTA_DATASET, 'utf8')) as Dataset;
  const cliente = await pool.connect();

  try {
    await cliente.query('BEGIN');

    for (const s of dataset.solicitudes) {
      await cliente.query(
        `INSERT INTO solicitudes (
           id_solicitud, nombre_empresa, sector, meses_operacion, monto_solicitado,
           plazo_meses, destino_fondos, ventas_anuales, utilidad_neta, activos_totales,
           pasivos_totales, deuda_vigente_anual, score_historial, garantia_ofrecida,
           fecha_solicitud)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id_solicitud) DO UPDATE SET
           nombre_empresa      = EXCLUDED.nombre_empresa,
           sector              = EXCLUDED.sector,
           meses_operacion     = EXCLUDED.meses_operacion,
           monto_solicitado    = EXCLUDED.monto_solicitado,
           plazo_meses         = EXCLUDED.plazo_meses,
           destino_fondos      = EXCLUDED.destino_fondos,
           ventas_anuales      = EXCLUDED.ventas_anuales,
           utilidad_neta       = EXCLUDED.utilidad_neta,
           activos_totales     = EXCLUDED.activos_totales,
           pasivos_totales     = EXCLUDED.pasivos_totales,
           deuda_vigente_anual = EXCLUDED.deuda_vigente_anual,
           score_historial     = EXCLUDED.score_historial,
           garantia_ofrecida   = EXCLUDED.garantia_ofrecida,
           fecha_solicitud     = EXCLUDED.fecha_solicitud`,
        [
          s.id_solicitud,
          s.nombre_empresa,
          s.sector,
          s.meses_operacion,
          s.monto_solicitado,
          s.plazo_meses,
          s.destino_fondos,
          s.ventas_anuales,
          s.utilidad_neta,
          s.activos_totales,
          s.pasivos_totales,
          s.deuda_vigente_anual,
          s.score_historial,
          s.garantia_ofrecida,
          s.fecha_solicitud,
        ],
      );
    }

    let insertados = 0;
    let yaEstaban = 0;

    for (const d of dataset.dictamenes_historicos) {
      const creado = `now() - make_interval(days => ${d.dias_atras})`;

      const { rows } = await cliente.query<{ id: string }>(
        `INSERT INTO dictamenes (
           id_solicitud, clave_idempotencia, decision, monto_recomendado,
           plazo_recomendado_meses, monto_solicitado_snapshot, tope_politica,
           ind_antiguedad_meses, motivos, nivel_riesgo,
           requiere_autorizacion_humana, confianza, creado_en)
         SELECT $1,$2,$3,$4,$5,0,0, s.meses_operacion, $6,$7,$8,$9, ${creado}
           FROM solicitudes s WHERE s.id_solicitud = $1
         ON CONFLICT (clave_idempotencia) DO NOTHING
         RETURNING id`,
        [
          d.id_solicitud,
          d.clave_idempotencia,
          d.decision,
          d.monto_recomendado,
          d.plazo_recomendado_meses,
          d.motivos,
          d.nivel_riesgo,
          d.requiere_autorizacion_humana,
          d.confianza,
        ],
      );

      const id = rows[0]?.id;
      if (!id) {
        yaEstaban += 1;
        continue;
      }
      insertados += 1;

      await cliente.query(
        `INSERT INTO dictamen_citas (id_dictamen, id_politica, seccion, texto_literal, orden)
         VALUES ($1,$2,$3,$4,0)`,
        [id, d.cita.id_politica, d.cita.seccion, d.cita.texto_literal],
      );

      if (d.estado === 'EN_FIRME') {
        await cliente.query(
          `UPDATE dictamenes
              SET estado = 'EN_FIRME', confirmado_por = $2,
                  confirmado_en = ${creado} + interval '2 days'
            WHERE id = $1`,
          [id, d.confirmado_por],
        );
      }
    }

    await cliente.query('COMMIT');

    const { rows: conteos } = await pool.query<{ solicitudes: number; indicadores: number }>(
      `SELECT (SELECT count(*)::int FROM solicitudes)            AS solicitudes,
              (SELECT count(*)::int FROM indicadores_solicitud)  AS indicadores`,
    );

    return {
      solicitudes: conteos[0]!.solicitudes,
      indicadores: conteos[0]!.indicadores,
      dictamenes: insertados,
      yaEstaban,
    };
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

if (import.meta.filename === process.argv[1]) {
  try {
    const r = await sembrar();
    console.log(
      `Siembra completada:\n` +
        `  ${r.solicitudes} solicitudes en base de datos\n` +
        `  ${r.dictamenes} dictamenes historicos insertados` +
        (r.yaEstaban > 0 ? ` (${r.yaEstaban} ya estaban)` : '') +
        `\n  ${r.indicadores} solicitudes con indicadores precalculados` +
        `\n\nLos indicadores se calculan al consultarlos, no al sembrar: ` +
        `la ausencia de fila significa "pendiente de recalculo".`,
    );
    await cerrarPool();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    await cerrarPool();
    process.exit(1);
  }
}
