/**
 * Cliente SSE sobre fetch.
 *
 * No se usa EventSource. Ver la nota en apps/api/src/http/rutas/analizar.ts: solo
 * hace GET y reconecta sola, y aquí reconectar relanzaría una ejecución completa
 * del agente. Con fetch se obtiene además cancelación real con AbortController,
 * que es lo que el punto 5.3.8 exige.
 *
 * El troceado del flujo importa: un `chunk` de red no coincide con un evento
 * SSE. Puede traer tres eventos o medio evento, así que hay que acumular en un
 * buffer y cortar por la línea en blanco que separa eventos. Procesar cada chunk
 * como si fuera un evento completo funciona en desarrollo y se rompe en cuanto
 * hay latencia real.
 */

export interface EventoSse {
  evento: string;
  datos: unknown;
}

export interface OpcionesFlujo {
  ruta: string;
  cuerpo: unknown;
  senal: AbortSignal;
  alEvento: (evento: EventoSse) => void;
}

export async function consumirFlujo({
  ruta,
  cuerpo,
  senal,
  alEvento,
}: OpcionesFlujo): Promise<void> {
  const respuesta = await fetch(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(cuerpo),
    signal: senal,
  });

  if (!respuesta.ok || respuesta.body === null) {
    const detalle = await respuesta.text().catch(() => '');
    throw new Error(
      `La API respondió ${respuesta.status}${detalle !== '' ? `: ${detalle.slice(0, 200)}` : ''}`,
    );
  }

  const lector = respuesta.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;

      buffer += value;

      // Los eventos SSE se separan por una línea en blanco.
      let corte = buffer.indexOf('\n\n');
      while (corte !== -1) {
        const bloque = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        const evento = interpretar(bloque);
        if (evento !== null) alEvento(evento);
        corte = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Liberar el lector cierra el cuerpo. Sin esto, cancelar dejaría el socket
    // colgando hasta que el navegador lo recogiera por su cuenta.
    lector.releaseLock();
  }
}

function interpretar(bloque: string): EventoSse | null {
  let nombre = 'message';
  const datos: string[] = [];

  for (const linea of bloque.split('\n')) {
    // Los comentarios (el latido del servidor) empiezan por dos puntos.
    if (linea.startsWith(':')) continue;
    if (linea.startsWith('event:')) nombre = linea.slice(6).trim();
    else if (linea.startsWith('data:')) datos.push(linea.slice(5).trim());
  }

  if (datos.length === 0) return null;

  try {
    return { evento: nombre, datos: JSON.parse(datos.join('\n')) };
  } catch {
    return { evento: nombre, datos: datos.join('\n') };
  }
}
