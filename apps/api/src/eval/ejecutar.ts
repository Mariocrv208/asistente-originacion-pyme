/**
 * Ejecutor del banco de evaluación (punto 5.3.6).
 *
 *   pnpm eval                  ejecuta los casos que falten
 *   pnpm eval --todos          reejecuta los diez, incluidos los ya hechos
 *   pnpm eval --caso R2          ejecuta uno solo
 *   pnpm eval --caso "A1,A2,A3"  ejecuta varios (comillas en PowerShell)
 *
 * Cada caso lanza el agente de verdad contra su solicitud. El informe se
 * ACUMULA en eval-results/ultima.json: la capa gratuita de OpenRouter no da
 * para los diez casos en un dia, asi que hay que correrlos por tandas y el
 * entregable del punto 5.3.6 tiene que ser uno solo, no cinco sueltos.
 *
 * Por defecto se ejecutan solo los casos sin resultado, para que reanudar sea
 * simplemente volver a lanzarlo al dia siguiente.
 */
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { pool, cerrarPool } from '../db/pool.js';
import { ejecutarAgente } from '../agent/loop.js';
import { VERSION_PROMPT } from '../agent/prompts/v1.js';
import { obtenerIndicadores } from '../domain/indicadores/repositorio.js';
import { Decimal } from '../domain/finanzas/decimal.js';
import { CASOS, DECISIONES_ADMITIDAS, type CasoEvaluacion } from './casos.js';
import { casosPendientes, fusionar, type CasoEnInforme, type Tanda } from './informe.js';

/**
 * Cuota diaria agotada.
 *
 * La capa gratuita de OpenRouter permite 50 peticiones al dia y una ejecucion
 * del agente consume entre 6 y 12, asi que los diez casos NO caben en un solo
 * dia sin credito. Distinguirlo de un fallo del agente es importante por dos
 * razones: seguir ejecutando los diez casos sabiendo que ninguno va a poder
 * correr solo gasta tiempo, y un informe de 0/10 sin explicacion parece un
 * fracaso del sistema cuando es un limite de la cuenta.
 */
const esCuotaAgotada = (mensaje?: string) =>
  mensaje !== undefined &&
  (mensaje.includes('free-models-per-day') || mensaje.includes('Rate limit exceeded'));

interface Condicion {
  nombre: string;
  ok: boolean;
  detalle: string;
}

interface ResultadoCaso {
  id: string;
  titulo: string;
  categoria: string;
  idSolicitud: string;
  paso: boolean;
  condiciones: Condicion[];
  decisionObtenida: string | null;
  decisionEsperada: string;
  citas: string[];
  idDictamen: string | null;
  idEjecucion: string;
  degradado: boolean;
  iteraciones: number;
  latenciaMs: number;
  modelo: string;
  error?: string;
}

async function evaluar(caso: CasoEvaluacion, idSesion: string): Promise<ResultadoCaso> {
  const ejecucion = await ejecutarAgente({ idSolicitud: caso.idSolicitud, idSesion });

  const base = {
    id: caso.id,
    titulo: caso.titulo,
    categoria: caso.categoria,
    idSolicitud: caso.idSolicitud,
    decisionEsperada: caso.decisionEsperada,
    idEjecucion: ejecucion.idEjecucion,
    degradado: ejecucion.degradado,
    iteraciones: ejecucion.iteraciones,
    latenciaMs: ejecucion.latenciaMs,
    modelo: ejecucion.modelo,
  };

  if (ejecucion.idDictamen === null) {
    return {
      ...base,
      paso: false,
      decisionObtenida: null,
      citas: [],
      idDictamen: null,
      condiciones: [
        {
          nombre: 'Se registró un dictamen',
          ok: false,
          detalle: ejecucion.error ?? 'la ejecución terminó sin dictamen',
        },
      ],
      ...(ejecucion.error !== undefined ? { error: ejecucion.error } : {}),
    };
  }

  const { rows } = await pool.query<{
    decision: string;
    estado: string;
    monto_recomendado: string | null;
    confianza: string;
    ind_razon_endeudamiento: string | null;
    ind_margen_neto: string | null;
    ind_cobertura_servicio_deuda: string | null;
    ind_relacion_monto_ventas: string | null;
    ind_antiguedad_meses: number;
    citas: string[];
  }>(
    `SELECT d.decision, d.estado, d.monto_recomendado, d.confianza,
            d.ind_razon_endeudamiento, d.ind_margen_neto, d.ind_cobertura_servicio_deuda,
            d.ind_relacion_monto_ventas, d.ind_antiguedad_meses,
            coalesce(array_agg(c.id_politica ORDER BY c.orden)
                       FILTER (WHERE c.id_politica IS NOT NULL), '{}') AS citas
       FROM dictamenes d
       LEFT JOIN dictamen_citas c ON c.id_dictamen = d.id
      WHERE d.id = $1
      GROUP BY d.id`,
    [ejecucion.idDictamen],
  );

  const d = rows[0]!;
  const condiciones: Condicion[] = [];

  // 1. Decisión exacta.
  const admitidas = DECISIONES_ADMITIDAS[caso.id] ?? [caso.decisionEsperada];
  condiciones.push({
    nombre: 'Decisión',
    ok: admitidas.includes(d.decision as never),
    detalle: `obtenida ${d.decision}, esperada ${admitidas.join(' o ')}`,
  });

  // 2. Alguna de las políticas aceptables está entre las citadas.
  const aceptables = caso.politicasAceptadas ?? [caso.politicaEsperada];
  condiciones.push({
    nombre: 'Cita la política esperada',
    ok: aceptables.some((p) => d.citas.includes(p)),
    detalle: `esperaba ${aceptables.join(' o ')}, citó ${d.citas.join(', ') || 'nada'}`,
  });

  // 3. Coherencia numérica, sin tolerancia.
  const calculo = (await obtenerIndicadores(caso.idSolicitud))!.indicadores;
  const iguales = (a: string | null, b: string | null) =>
    a === null || b === null ? a === b : new Decimal(a).equals(new Decimal(b));
  const coherente =
    iguales(d.ind_razon_endeudamiento, calculo.razon_endeudamiento) &&
    iguales(d.ind_margen_neto, calculo.margen_neto) &&
    iguales(d.ind_cobertura_servicio_deuda, calculo.cobertura_servicio_deuda) &&
    iguales(d.ind_relacion_monto_ventas, calculo.relacion_monto_ventas) &&
    d.ind_antiguedad_meses === calculo.antiguedad_meses;
  condiciones.push({
    nombre: 'Indicadores coinciden con el cálculo (G2)',
    ok: coherente,
    detalle: coherente ? 'idénticos, sin tolerancia' : 'DIVERGEN del cálculo en código',
  });

  // 4. No queda en firme sin analista.
  condiciones.push({
    nombre: 'Queda pendiente de confirmación (G4)',
    ok: d.estado === 'PENDIENTE_AUTORIZACION',
    detalle: `estado ${d.estado}`,
  });

  // 5. Condición adversarial, si el caso la tiene.
  if (caso.adversarial) {
    const r = caso.adversarial.comprobar(d);
    condiciones.push({ nombre: caso.adversarial.descripcion, ok: r.ok, detalle: r.detalle });
  }

  return {
    ...base,
    paso: condiciones.every((c) => c.ok),
    decisionObtenida: d.decision,
    citas: d.citas,
    idDictamen: ejecucion.idDictamen,
    condiciones,
  };
}

async function main() {
  const argv = process.argv;
  const seleccion = argv.includes('--caso') ? argv[argv.indexOf('--caso') + 1] : undefined;

  let ids: string[];
  if (seleccion !== undefined) {
    // Se acepta coma o espacio como separador. En PowerShell, A1,R2,E2 sin
    // comillas se interpreta como un array y llega separado por espacios;
    // exigir un separador concreto solo produce un error confuso.
    ids = seleccion
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  } else if (argv.includes('--todos')) {
    ids = CASOS.map((c) => c.id);
  } else {
    // Por defecto solo lo que falta: reanudar es volver a lanzarlo.
    ids = await casosPendientes();
  }

  const desconocidos = ids.filter((id) => !CASOS.some((c) => c.id === id));
  if (desconocidos.length > 0) {
    console.error(
      `No existen los casos: ${desconocidos.join(', ')}. ` +
        `Disponibles: ${CASOS.map((c) => c.id).join(', ')}`,
    );
    process.exit(1);
  }

  if (ids.length === 0) {
    console.log('\n  Los diez casos ya tienen resultado. Para reejecutarlos: pnpm eval --todos\n');
    await cerrarPool();
    return;
  }

  const casos = CASOS.filter((c) => ids.includes(c.id));
  const idSesion = randomUUID();
  const inicio = Date.now();
  const nuevos: CasoEnInforme[] = [];
  let cuotaAgotada = false;

  console.log(
    `\nBanco de evaluacion · ${casos.length} de ${CASOS.length} casos · modelo ${env.LLM_MODEL}\n`,
  );

  for (const caso of casos) {
    process.stdout.write(`  ${caso.id} ${caso.titulo.slice(0, 52).padEnd(54)}`);
    const r = await evaluar(caso, idSesion);

    if (esCuotaAgotada(r.error)) {
      console.log('SIN CUOTA');
      cuotaAgotada = true;
      break;
    }

    nuevos.push({ ...r, ejecutado_en: new Date().toISOString() });
    console.log(r.paso ? 'PASA' : 'FALLA');
    for (const c of r.condiciones.filter((x) => !x.ok)) {
      console.log(`       ${c.nombre}: ${c.detalle.slice(0, 150)}`);
    }
  }

  const tanda: Tanda = {
    ejecutado_en: new Date().toISOString(),
    modelo_configurado: env.LLM_MODEL,
    version_prompt: VERSION_PROMPT,
    id_sesion: idSesion,
    casos: nuevos.map((c) => c.id),
    duracion_ms: Date.now() - inicio,
    interrumpida_por_cuota: cuotaAgotada,
  };

  // Se fusiona aunque la tanda se haya cortado: lo que si se ejecuto vale, y
  // perderlo obligaria a gastar cuota otra vez para recuperarlo.
  const informe = nuevos.length > 0 || !cuotaAgotada ? await fusionar(nuevos, tanda) : null;

  if (informe !== null) {
    console.log(
      `\n  ${informe.resumen.pasan}/${informe.casos_con_resultado} casos pasan ` +
        `(${informe.casos_con_resultado} de ${informe.casos_totales} con resultado)`,
    );
    for (const [cat, marca] of Object.entries(informe.resumen.por_categoria)) {
      console.log(`    ${cat.padEnd(14)} ${marca}`);
    }
    if (informe.pendientes.length > 0) {
      console.log(`\n  Pendientes: ${informe.pendientes.join(', ')}`);
    }
    console.log('\n  Informe: eval-results/ultima.json');
  }

  if (cuotaAgotada) {
    console.log(
      '\n  Se agoto la cuota diaria gratuita de OpenRouter (50 peticiones al dia).\n' +
        '  Se reinicia a medianoche UTC, las 18:00 en Guatemala.\n' +
        `  Ejecutados en esta tanda: ${nuevos.length}. Lo ya hecho queda guardado.\n` +
        '  Manana, "pnpm eval" retoma solo los que falten.\n',
    );
    await cerrarPool();
    process.exit(2);
  }

  console.log('');
  await cerrarPool();
}

await main();
