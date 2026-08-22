import { env } from './config/env.js';
import { cerrarPool } from './db/pool.js';
import { construirServidor } from './http/server.js';

const app = await construirServidor();

/**
 * Apagado ordenado. Importa mas de lo que parece en este proyecto: a partir de
 * M12 habra respuestas SSE abiertas, y a partir de M7 ejecuciones del agente a
 * medias. Cerrar Fastify antes que el pool deja que las peticiones en vuelo
 * terminen en lugar de morir con la conexion a base de datos ya cortada.
 */
let apagando = false;
for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    if (apagando) return;
    apagando = true;
    app.log.info(`recibida ${senal}, cerrando`);
    void (async () => {
      try {
        await app.close();
        await cerrarPool();
        process.exit(0);
      } catch (error) {
        app.log.error({ error }, 'fallo el apagado ordenado');
        process.exit(1);
      }
    })();
  });
}

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
} catch (error) {
  app.log.error({ error }, 'no se pudo arrancar el servidor');
  await cerrarPool();
  process.exit(1);
}
