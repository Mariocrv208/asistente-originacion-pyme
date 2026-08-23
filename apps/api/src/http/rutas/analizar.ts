import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ejecutarAgente, type EventoPaso } from '../../agent/loop.js';

/**
 * Analisis de una solicitud, con la actividad del agente emitida por SSE.
 *
 * SSE FRENTE A WEBSOCKETS (pregunta 3.1 del cuestionario)
 *
 * El flujo es unidireccional: el servidor cuenta lo que va haciendo y el cliente
 * solo escucha. Un WebSocket daria un canal bidireccional que no se usa, a
 * cambio de un protocolo aparte, otro camino de autenticacion y un estado de
 * conexion que mantener. SSE viaja sobre HTTP normal y hereda todo lo que ya
 * funciona: proxies, cabeceras, cancelacion.
 *
 * POR QUE POST Y NO EventSource
 *
 * EventSource es la API estandar de SSE en el navegador, y aqui es justo la
 * equivocada, por dos razones:
 *
 *   - solo hace GET y no admite cuerpo ni cabeceras, asi que los parametros
 *     tendrian que ir en la URL;
 *   - reconecta sola al cortarse la conexion. Aqui eso es un defecto grave: cada
 *     reconexion relanzaria una ejecucion completa del agente, gastando cuota y
 *     escribiendo dictamenes duplicados. La idempotencia lo atraparia, pero
 *     estariamos pagando llamadas al modelo para descartarlas despues.
 *
 * El cliente usa fetch con ReadableStream, que ademas da lo que el punto 5.3.8
 * exige: cancelacion real desde el cliente con AbortController, propagada hasta
 * el proveedor.
 *
 * QUE CAMBIARIA CON UN SEGUNDO ESPECTADOR
 *
 * Si manana otro analista tuviera que ver el mismo flujo en vivo, SSE seguiria
 * sirviendo, pero el diseno cambiaria: la ejecucion dejaria de estar atada a una
 * peticion HTTP y pasaria a publicar sus pasos en un canal por sesion, con cada
 * espectador suscrito a ese canal por su propio SSE. Lo que obliga a cambiar no
 * es el transporte, es la propiedad de la ejecucion.
 */

const cuerpoSchema = z.object({
  id_solicitud: z.string().uuid(),
  peticion: z.string().max(2000).optional(),
  id_sesion: z.string().uuid().optional(),
});

/** Escribe un evento SSE con nombre y datos. */
function emitir(respuesta: FastifyReply, evento: string, datos: unknown): void {
  respuesta.raw.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
}

export async function rutasAnalizar(app: FastifyInstance): Promise<void> {
  app.post('/api/analizar', async (peticion, respuesta) => {
    const cuerpo = cuerpoSchema.parse(peticion.body);

    respuesta.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Sin esto, un proxy intermedio puede acumular la respuesta y entregarla
      // entera al final, que es exactamente lo contrario del streaming.
      'X-Accel-Buffering': 'no',
    });

    const controlador = new AbortController();

    // Cancelacion real: si el cliente aborta su fetch, el socket se cierra y la
    // senal se propaga hasta la llamada al proveedor, que corta la generacion
    // en curso en vez de dejarla terminar contra un cliente que ya no existe.
    peticion.raw.on('close', () => {
      if (!controlador.signal.aborted) controlador.abort();
    });

    // Latido cada 15 segundos. Una ejecucion del agente puede tardar mas de lo
    // que aguanta un proxy sin trafico, y un comentario SSE mantiene viva la
    // conexion sin ensuciar el flujo de eventos.
    const latido = setInterval(() => respuesta.raw.write(': latido\n\n'), 15_000);

    try {
      emitir(respuesta, 'inicio', {
        id_solicitud: cuerpo.id_solicitud,
        iniciado_en: new Date().toISOString(),
      });

      const resultado = await ejecutarAgente({
        idSolicitud: cuerpo.id_solicitud,
        ...(cuerpo.id_sesion ? { idSesion: cuerpo.id_sesion } : {}),
        ...(cuerpo.peticion ? { peticion: cuerpo.peticion } : {}),
        senal: controlador.signal,
        alPaso: (evento: EventoPaso) => {
          // La interfaz debe comunicar que esta trabajando el sistema, no
          // exponer el razonamiento interno. Se emite QUE se hizo —herramienta,
          // fuente consultada, resultado parcial— y nunca el contenido del
          // prompt ni los mensajes intermedios del modelo.
          emitir(respuesta, 'paso', evento);
        },
      });

      emitir(respuesta, 'fin', resultado);
    } catch (error) {
      emitir(respuesta, 'error', {
        mensaje: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(latido);
      respuesta.raw.end();
    }

    // Fastify no debe intentar serializar nada mas: la respuesta ya se escribio
    // a mano sobre el socket.
    return respuesta;
  });
}
