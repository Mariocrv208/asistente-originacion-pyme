import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { obtenerIndicadores } from '../../domain/indicadores/repositorio.js';

/**
 * Endpoints de lectura: bandeja de solicitudes, detalle, dictamenes, metricas
 * y trazas de ejecucion.
 *
 * Ninguno toca el LLM. Es intencional: la interfaz tiene que ser navegable y
 * util sin gastar una sola peticion del proveedor, y el analista pasa mucho mas
 * tiempo revisando expedientes que lanzando analisis.
 */

const filtrosSchema = z.object({
  estado: z.enum(['PENDIENTE_AUTORIZACION', 'EN_FIRME', 'ANULADO', 'SIN_DICTAMEN']).optional(),
  sector: z.string().optional(),
  busqueda: z.string().optional(),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  desplazamiento: z.coerce.number().int().min(0).default(0),
});

export async function rutasLectura(app: FastifyInstance): Promise<void> {
  /**
   * Bandeja de solicitudes.
   *
   * Cada fila trae el dictamen mas reciente, si lo hay. Se resuelve con
   * DISTINCT ON, que es la forma de PostgreSQL de decir "una fila por grupo,
   * la primera segun este orden", en vez de traer todos los dictamenes y
   * filtrarlos en JavaScript.
   */
  app.get('/api/solicitudes', async (peticion) => {
    const f = filtrosSchema.parse(peticion.query);

    const { rows } = await pool.query(
      `WITH ultimo AS (
         SELECT DISTINCT ON (id_solicitud)
                id_solicitud, id, decision, estado, monto_recomendado, nivel_riesgo,
                requiere_autorizacion_humana, confianza, creado_en
           FROM dictamenes
          ORDER BY id_solicitud, creado_en DESC
       )
       SELECT s.id_solicitud, s.nombre_empresa, s.sector, s.monto_solicitado,
              s.plazo_meses, s.meses_operacion, s.score_historial, s.garantia_ofrecida,
              s.fecha_solicitud,
              u.id AS id_dictamen, u.decision, u.estado, u.monto_recomendado,
              u.nivel_riesgo, u.requiere_autorizacion_humana, u.confianza,
              count(*) OVER () AS total
         FROM solicitudes s
         LEFT JOIN ultimo u USING (id_solicitud)
        WHERE ($1::text IS NULL OR
               ($1 = 'SIN_DICTAMEN' AND u.id IS NULL) OR
               u.estado::text = $1)
          AND ($2::text IS NULL OR s.sector::text = $2)
          AND ($3::text IS NULL OR s.nombre_empresa ILIKE '%' || $3 || '%')
        ORDER BY s.fecha_solicitud DESC, s.nombre_empresa
        LIMIT $4 OFFSET $5`,
      [f.estado ?? null, f.sector ?? null, f.busqueda ?? null, f.limite, f.desplazamiento],
    );

    return {
      total: rows[0] ? Number(rows[0].total) : 0,
      limite: f.limite,
      desplazamiento: f.desplazamiento,
      solicitudes: rows.map(({ total: _total, ...resto }) => resto),
    };
  });

  /** Detalle de una solicitud, con sus indicadores y su historial. */
  app.get('/api/solicitudes/:id', async (peticion, respuesta) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(peticion.params);

    const { rows } = await pool.query('SELECT * FROM solicitudes WHERE id_solicitud = $1', [id]);
    if (!rows[0]) return respuesta.code(404).send({ error: 'Solicitud no encontrada' });

    const calculo = await obtenerIndicadores(id);

    const { rows: dictamenes } = await pool.query(
      `SELECT d.id, d.decision, d.estado, d.monto_recomendado, d.plazo_recomendado_meses,
              d.nivel_riesgo, d.requiere_autorizacion_humana, d.confianza, d.motivos,
              d.creado_en, d.confirmado_por, d.confirmado_en, d.id_ejecucion,
              coalesce(
                (SELECT json_agg(json_build_object(
                          'id_politica', c.id_politica,
                          'seccion', c.seccion,
                          'texto_literal', c.texto_literal) ORDER BY c.orden)
                   FROM dictamen_citas c WHERE c.id_dictamen = d.id), '[]'::json) AS citas
         FROM dictamenes d
        WHERE d.id_solicitud = $1
        ORDER BY d.creado_en DESC`,
      [id],
    );

    return {
      solicitud: rows[0],
      indicadores: calculo?.indicadores ?? null,
      dictamenes,
    };
  });

  /** Traza completa de una ejecucion. Es la respuesta a la pregunta 4.5. */
  app.get('/api/ejecuciones/:id', async (peticion, respuesta) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(peticion.params);

    const { rows } = await pool.query('SELECT * FROM ejecuciones_agente WHERE id = $1', [id]);
    if (!rows[0]) return respuesta.code(404).send({ error: 'Ejecucion no encontrada' });

    const { rows: pasos } = await pool.query(
      `SELECT indice, tipo, nombre, argumentos, resultado, error,
              tokens_entrada, tokens_salida, latencia_ms, creado_en
         FROM pasos_agente WHERE id_ejecucion = $1 ORDER BY indice`,
      [id],
    );

    return { ejecucion: rows[0], pasos };
  });

  /**
   * Metricas de cartera para el panel (punto 5.3.8).
   *
   * Los tres indicadores minimos que pide el enunciado, mas el desglose por
   * sector que la vista necesita para ser algo mas que tres numeros sueltos.
   */
  app.get('/api/metricas', async () => {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM solicitudes)                                      AS solicitudes,
         (SELECT count(*)::int FROM dictamenes)                                       AS dictamenes,
         (SELECT count(*)::int FROM dictamenes WHERE decision='APROBADO')             AS aprobados,
         (SELECT count(*)::int FROM dictamenes WHERE decision='RECHAZADO')            AS rechazados,
         (SELECT count(*)::int FROM dictamenes WHERE decision='ESCALADO_A_COMITE')    AS escalados,
         (SELECT count(*)::int FROM dictamenes WHERE estado='PENDIENTE_AUTORIZACION') AS pendientes,
         (SELECT count(*)::int FROM dictamenes WHERE estado='EN_FIRME')               AS en_firme,
         (SELECT count(*)::int FROM dictamenes WHERE estado='ANULADO')                AS anulados,
         (SELECT round(avg(monto_recomendado),2) FROM dictamenes
           WHERE monto_recomendado IS NOT NULL)                                       AS monto_promedio`,
    );

    const m = rows[0] as Record<string, number | string | null>;
    const dictamenes = Number(m.dictamenes ?? 0);

    const { rows: porSector } = await pool.query(
      `SELECT s.sector::text AS sector, count(*)::int AS total,
              count(*) FILTER (WHERE d.decision='ESCALADO_A_COMITE')::int AS escalados
         FROM dictamenes d JOIN solicitudes s USING (id_solicitud)
        GROUP BY s.sector ORDER BY total DESC`,
    );

    return {
      solicitudes_procesadas_por_estado: {
        PENDIENTE_AUTORIZACION: m.pendientes,
        EN_FIRME: m.en_firme,
        ANULADO: m.anulados,
        SIN_DICTAMEN: Number(m.solicitudes ?? 0) - dictamenes,
      },
      por_decision: {
        APROBADO: m.aprobados,
        RECHAZADO: m.rechazados,
        ESCALADO_A_COMITE: m.escalados,
      },
      monto_promedio_recomendado: m.monto_promedio,
      // Tercera metrica exigida por el punto 5.3.8.
      tasa_escalamiento:
        dictamenes === 0 ? null : Number((Number(m.escalados ?? 0) / dictamenes).toFixed(4)),
      total_solicitudes: m.solicitudes,
      total_dictamenes: dictamenes,
      por_sector: porSector,
    };
  });
}
