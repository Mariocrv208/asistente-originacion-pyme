/**
 * Verificacion de la API (M12).
 *
 * Usa app.inject() de Fastify: las peticiones entran por el mismo camino que
 * las reales pero sin abrir un socket. Ni red, ni puertos ocupados, ni cuota
 * del proveedor gastada.
 */
import { pool, cerrarPool } from '../db/pool.js';
import { construirServidor } from './server.js';

interface Comprobacion {
  bloque: string;
  nombre: string;
  ok: boolean;
  detalle: string;
}
const comprobaciones: Comprobacion[] = [];
const afirmar = (bloque: string, nombre: string, ok: boolean, detalle: string) =>
  comprobaciones.push({ bloque, nombre, ok, detalle });

async function main() {
  const app = await construirServidor();

  // Un dictamen que este pendiente, para ejercitar la confirmacion de G4.
  const { rows: pendientes } = await pool.query<{ id: string; id_solicitud: string }>(
    `SELECT id, id_solicitud FROM dictamenes
      WHERE estado = 'PENDIENTE_AUTORIZACION' ORDER BY creado_en DESC LIMIT 1`,
  );
  const { rows: firmes } = await pool.query<{ id: string }>(
    `SELECT id FROM dictamenes WHERE estado = 'EN_FIRME' LIMIT 1`,
  );

  // =========================================================================
  const L = 'A. Lectura';

  const bandeja = await app.inject({ method: 'GET', url: '/api/solicitudes?limite=5' });
  const bandejaJson = bandeja.json();
  afirmar(
    L,
    'La bandeja responde y pagina',
    bandeja.statusCode === 200 && bandejaJson.total > 0,
    `HTTP ${bandeja.statusCode}, ${bandejaJson.solicitudes?.length ?? 0} de ${bandejaJson.total}`,
  );

  afirmar(
    L,
    'Cada fila trae su dictamen mas reciente, si lo tiene',
    Array.isArray(bandejaJson.solicitudes) &&
      bandejaJson.solicitudes.every((s: Record<string, unknown>) => 'decision' in s),
    'columna decision presente en todas las filas',
  );

  const filtrada = await app.inject({
    method: 'GET',
    url: '/api/solicitudes?estado=PENDIENTE_AUTORIZACION&limite=5',
  });
  afirmar(
    L,
    'El filtro por estado discrimina',
    filtrada.statusCode === 200 &&
      filtrada
        .json()
        .solicitudes.every((s: { estado: string }) => s.estado === 'PENDIENTE_AUTORIZACION'),
    `${filtrada.json().total} pendientes`,
  );

  const sinDictamen = await app.inject({
    method: 'GET',
    url: '/api/solicitudes?estado=SIN_DICTAMEN&limite=5',
  });
  afirmar(
    L,
    'Se pueden listar las solicitudes sin dictaminar',
    sinDictamen.statusCode === 200 &&
      sinDictamen
        .json()
        .solicitudes.every((s: { id_dictamen: string | null }) => s.id_dictamen === null),
    `${sinDictamen.json().total} sin dictamen`,
  );

  const detalle = await app.inject({
    method: 'GET',
    url: `/api/solicitudes/${pendientes[0]!.id_solicitud}`,
  });
  const dJson = detalle.json();
  afirmar(
    L,
    'El detalle trae solicitud, indicadores e historial',
    detalle.statusCode === 200 &&
      dJson.solicitud &&
      dJson.indicadores &&
      Array.isArray(dJson.dictamenes),
    `${dJson.dictamenes?.length ?? 0} dictamenes en el historial`,
  );

  afirmar(
    L,
    'Los indicadores del detalle vienen del calculo, no del modelo',
    dJson.indicadores?.version_calculo !== undefined,
    `version_calculo=${dJson.indicadores?.version_calculo}`,
  );

  const dictamen = await app.inject({ method: 'GET', url: `/api/dictamenes/${pendientes[0]!.id}` });
  afirmar(
    L,
    'El dictamen incluye sus citas de politica',
    dictamen.statusCode === 200 &&
      Array.isArray(dictamen.json().citas) &&
      dictamen.json().citas.length >= 1,
    `${dictamen.json().citas?.length ?? 0} citas`,
  );

  const metricas = await app.inject({ method: 'GET', url: '/api/metricas' });
  const m = metricas.json();
  afirmar(
    L,
    'Las metricas traen los tres indicadores del punto 5.3.8',
    metricas.statusCode === 200 &&
      m.solicitudes_procesadas_por_estado !== undefined &&
      m.monto_promedio_recomendado !== undefined &&
      m.tasa_escalamiento !== undefined,
    `promedio=${m.monto_promedio_recomendado} escalamiento=${m.tasa_escalamiento}`,
  );

  // =========================================================================
  const E = 'B. Errores';

  const noExiste = await app.inject({
    method: 'GET',
    url: '/api/solicitudes/00000000-0000-4000-8000-000000000000',
  });
  afirmar(
    E,
    'Un identificador inexistente devuelve 404',
    noExiste.statusCode === 404,
    `HTTP ${noExiste.statusCode}`,
  );

  const malFormado = await app.inject({ method: 'GET', url: '/api/solicitudes/no-es-uuid' });
  afirmar(
    E,
    'Un identificador malformado devuelve 400, no 500',
    malFormado.statusCode === 400,
    `HTTP ${malFormado.statusCode}: ${malFormado.json().error}`,
  );

  const filtroMalo = await app.inject({ method: 'GET', url: '/api/solicitudes?limite=9999' });
  afirmar(
    E,
    'Un filtro fuera de rango devuelve 400 con el campo concreto',
    filtroMalo.statusCode === 400 && filtroMalo.json().detalles?.[0]?.campo === 'limite',
    `${filtroMalo.json().detalles?.[0]?.campo}: ${filtroMalo.json().detalles?.[0]?.mensaje}`,
  );

  const sinCuerpo = await app.inject({ method: 'POST', url: '/api/analizar', payload: {} });
  afirmar(
    E,
    'Analizar sin solicitud devuelve 400',
    sinCuerpo.statusCode === 400,
    `HTTP ${sinCuerpo.statusCode}`,
  );

  // =========================================================================
  const G = 'C. Confirmacion del analista (G4)';

  const sinAnalista = await app.inject({
    method: 'POST',
    url: `/api/dictamenes/${pendientes[0]!.id}/confirmar`,
    payload: {},
  });
  afirmar(
    G,
    'No se confirma sin identificar al analista',
    sinAnalista.statusCode === 400,
    `HTTP ${sinAnalista.statusCode}`,
  );

  if (firmes[0]) {
    const yaFirme = await app.inject({
      method: 'POST',
      url: `/api/dictamenes/${firmes[0].id}/confirmar`,
      payload: { analista: 'prueba.api' },
    });
    afirmar(
      G,
      'Un dictamen ya en firme no se vuelve a confirmar',
      yaFirme.statusCode === 409,
      `HTTP ${yaFirme.statusCode}: ${yaFirme.json().error?.slice(0, 60)}`,
    );
  }

  // La confirmacion real se hace y se deshace, para no ensuciar los datos.
  const objetivo = pendientes[0]!.id;
  const confirmada = await app.inject({
    method: 'POST',
    url: `/api/dictamenes/${objetivo}/confirmar`,
    payload: { analista: 'verificacion.api' },
  });
  afirmar(
    G,
    'La confirmacion explicita deja el dictamen en firme',
    confirmada.statusCode === 200 && confirmada.json().estado === 'EN_FIRME',
    `estado=${confirmada.json().estado} por ${confirmada.json().confirmado_por}`,
  );

  const segunda = await app.inject({
    method: 'POST',
    url: `/api/dictamenes/${objetivo}/confirmar`,
    payload: { analista: 'otro.analista' },
  });
  afirmar(
    G,
    'Confirmar dos veces no tiene efecto',
    segunda.statusCode === 409,
    `HTTP ${segunda.statusCode}`,
  );

  // Se devuelve a PENDIENTE por SQL directo: la API no lo permite a proposito,
  // y esa prohibicion es justamente la que se acaba de comprobar.
  await pool
    .query(
      `UPDATE dictamenes SET estado='PENDIENTE_AUTORIZACION', confirmado_por=NULL,
            confirmado_en=NULL WHERE id=$1`,
      [objetivo],
    )
    .catch(() => undefined);

  const { rows: tras } = await pool.query<{ estado: string }>(
    'SELECT estado FROM dictamenes WHERE id=$1',
    [objetivo],
  );
  afirmar(
    G,
    'Ni siquiera por SQL directo se revierte una confirmacion',
    tras[0]!.estado === 'EN_FIRME',
    `sigue en ${tras[0]!.estado}: lo impide el trigger de la maquina de estados`,
  );

  // =========================================================================
  const S = 'D. Streaming';

  const cabeceras = await app.inject({
    method: 'POST',
    url: '/api/analizar',
    payload: { id_solicitud: '00000000-0000-4000-8000-000000000000' },
  });
  afirmar(
    S,
    'El endpoint responde como flujo de eventos',
    cabeceras.headers['content-type']?.toString().includes('text/event-stream') === true,
    `content-type: ${cabeceras.headers['content-type']}`,
  );

  afirmar(
    S,
    'Desactiva el almacenamiento intermedio de los proxies',
    cabeceras.headers['x-accel-buffering'] === 'no',
    'X-Accel-Buffering: no',
  );

  const cuerpo = cabeceras.body;
  afirmar(
    S,
    'Emite eventos con nombre en formato SSE',
    cuerpo.includes('event: inicio') && cuerpo.includes('data: '),
    cuerpo.split('\n')[0] ?? '(vacio)',
  );

  afirmar(
    S,
    'Una solicitud inexistente termina con evento de error, no cuelga',
    cuerpo.includes('event: error') || cuerpo.includes('event: fin'),
    cuerpo.includes('event: error') ? 'event: error' : 'event: fin',
  );

  // =========================================================================
  const ancho = Math.max(...comprobaciones.map((c) => c.nombre.length));
  let bloque = '';
  console.log('\nVerificacion de la API (M12)');
  for (const c of comprobaciones) {
    if (c.bloque !== bloque) {
      bloque = c.bloque;
      console.log(`\n  ${bloque}`);
    }
    console.log(`    ${c.ok ? 'OK   ' : 'FALLA'} ${c.nombre.padEnd(ancho)}  ${c.detalle}`);
  }
  const fallos = comprobaciones.filter((c) => !c.ok).length;
  console.log(
    `\n  ${comprobaciones.length - fallos}/${comprobaciones.length} comprobaciones correctas\n`,
  );

  await app.close();
  await cerrarPool();
  if (fallos > 0) process.exit(1);
}

await main();
