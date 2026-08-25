import type { FastifyInstance } from 'fastify';
import { leerInforme } from '../../eval/informe.js';

/**
 * Lectura del informe del banco de evaluación (punto 5.3.6).
 *
 * Es de solo lectura a propósito: el informe lo produce `pnpm eval` desde la
 * terminal, porque ejecutarlo necesita Docker, la base de datos y la clave de
 * OpenRouter del entorno del servidor, no algo que un usuario del sistema deba
 * poder disparar desde el navegador. Esta ruta solo expone lo que ese script ya
 * escribió en `eval-results/ultima.json`, para que el estado de la evaluación
 * se pueda ver sin abrir una terminal.
 */
export async function rutasEvaluacion(app: FastifyInstance): Promise<void> {
  app.get('/api/evaluacion', async (_peticion, respuesta) => {
    const informe = await leerInforme();
    if (!informe) {
      return respuesta.code(404).send({
        error: 'Todavía no se ha corrido el banco de evaluación. Ejecuta "pnpm eval" en la terminal.',
      });
    }
    return informe;
  });
}
