import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';

/**
 * Confirmacion y anulacion de dictamenes.
 *
 * Es donde vive la mitad visible del guardarrail G4: el dictamen no queda en
 * firme hasta que un analista lo confirma explicitamente desde la interfaz. La
 * otra mitad la impone la base de datos, que rechaza cualquier EN_FIRME sin
 * confirmante y prohibe las transiciones que no estan permitidas.
 *
 * Estos endpoints no comprueban nada de eso por su cuenta a proposito: se
 * limitan a intentar la transicion y a traducir el rechazo de la base de datos
 * a un mensaje util. Duplicar la regla aqui crearia una segunda version de la
 * verdad que podria separarse de la primera sin que nadie se entere.
 */

const cuerpoConfirmacion = z.object({
  // El enunciado deja la autenticacion fuera de alcance (punto 5.6), asi que el
  // analista se identifica por nombre. En un sistema real vendria del token de
  // sesion, y esa es la unica diferencia.
  analista: z.string().min(2).max(80),
});

const cuerpoAnulacion = z.object({
  analista: z.string().min(2).max(80),
  motivo: z.string().min(5).max(500),
});

/** Traduce un rechazo de la base de datos a algo que el analista entienda. */
function traducirRechazo(error: unknown): { codigo: number; mensaje: string } {
  const e = error as { constraint?: string; message?: string };
  const detalle = e.message?.split('\n')[0] ?? 'sin detalle';

  if (e.constraint === 'g4_en_firme_exige_confirmacion') {
    return { codigo: 409, mensaje: 'Un dictamen no puede quedar en firme sin confirmacion.' };
  }
  if (detalle.includes('Transicion de estado no permitida')) {
    return { codigo: 409, mensaje: detalle };
  }
  if (detalle.includes('ya no es modificable')) {
    return { codigo: 409, mensaje: detalle };
  }
  return { codigo: 400, mensaje: detalle };
}

export async function rutasDictamenes(app: FastifyInstance): Promise<void> {
  app.get('/api/dictamenes/:id', async (peticion, respuesta) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(peticion.params);

    const { rows } = await pool.query(
      `SELECT d.*, s.nombre_empresa, s.sector,
              coalesce(
                (SELECT json_agg(json_build_object(
                          'id_politica', c.id_politica,
                          'seccion', c.seccion,
                          'texto_literal', c.texto_literal) ORDER BY c.orden)
                   FROM dictamen_citas c WHERE c.id_dictamen = d.id), '[]'::json) AS citas
         FROM dictamenes d JOIN solicitudes s USING (id_solicitud)
        WHERE d.id = $1`,
      [id],
    );

    if (!rows[0]) return respuesta.code(404).send({ error: 'Dictamen no encontrado' });
    return rows[0];
  });

  /**
   * Confirmacion explicita del analista (G4).
   *
   * Esto es lo que convierte una propuesta reversible en un efecto confirmado.
   * Hasta aqui, todo lo que produjo el agente era una recomendacion.
   */
  app.post('/api/dictamenes/:id/confirmar', async (peticion, respuesta) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(peticion.params);
    const { analista } = cuerpoConfirmacion.parse(peticion.body);

    try {
      const { rows } = await pool.query(
        `UPDATE dictamenes
            SET estado = 'EN_FIRME', confirmado_por = $2, confirmado_en = now()
          WHERE id = $1 AND estado = 'PENDIENTE_AUTORIZACION'
          RETURNING id, estado, decision, confirmado_por, confirmado_en`,
        [id, analista],
      );

      if (!rows[0]) {
        const { rows: actual } = await pool.query('SELECT estado FROM dictamenes WHERE id = $1', [
          id,
        ]);
        if (!actual[0]) return respuesta.code(404).send({ error: 'Dictamen no encontrado' });
        return respuesta.code(409).send({
          error: `El dictamen esta en estado ${actual[0].estado} y ya no admite confirmacion.`,
          estado: actual[0].estado,
        });
      }

      return rows[0];
    } catch (error) {
      const { codigo, mensaje } = traducirRechazo(error);
      return respuesta.code(codigo).send({ error: mensaje });
    }
  });

  app.post('/api/dictamenes/:id/anular', async (peticion, respuesta) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(peticion.params);
    const { analista, motivo } = cuerpoAnulacion.parse(peticion.body);

    try {
      const { rows } = await pool.query(
        `UPDATE dictamenes
            SET estado = 'ANULADO', motivo_anulacion = $2 || ' (' || $3 || ')'
          WHERE id = $1 AND estado <> 'ANULADO'
          RETURNING id, estado, motivo_anulacion`,
        [id, motivo, analista],
      );

      if (!rows[0]) {
        return respuesta.code(409).send({ error: 'El dictamen no existe o ya estaba anulado.' });
      }
      return rows[0];
    } catch (error) {
      const { codigo, mensaje } = traducirRechazo(error);
      return respuesta.code(codigo).send({ error: mensaje });
    }
  });
}
