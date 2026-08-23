/**
 * Ejecutor del banco de evaluación (punto 5.3.6).
 *
 *   pnpm eval            ejecuta los diez casos y escribe el informe
 *   pnpm eval --caso R2  ejecuta uno solo, útil al depurar
 *
 * Cada caso lanza el agente de verdad contra la solicitud correspondiente. El
 * informe se escribe en eval-results/ con marca de tiempo, modelo y versión de
 * prompt, porque un resultado sin esos tres datos no se puede comparar con otro.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { pool, cerrarPool } from '../db/pool.js';
import { ejecutarAgente } from '../agent/loop.js';
import { VERSION_PROMPT } from '../agent/prompts/v1.js';
import { obtenerIndicadores } from '../domain/indicadores/repositorio.js';
import { Decimal } from '../domain/finanzas/decimal.js';
import { CASOS, DECISIONES_ADMITIDAS, type CasoEvaluacion } from './casos.js';

const DIRECTORIO = join(import.meta.dirname, '../../../../eval-results');

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

  // 2. La política esperada está entre las citadas.
  condiciones.push({
    nombre: 'Cita la política esperada',
    ok: d.citas.includes(caso.politicaEsperada),
    detalle: `esperaba ${caso.politicaEsperada}, citó ${d.citas.join(', ') || 'nada'}`,
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
  const filtro = process.argv.includes('--caso')
    ? process.argv[process.argv.indexOf('--caso') + 1]
    : undefined;
  const casos = filtro !== undefined ? CASOS.filter((c) => c.id === filtro) : CASOS;

  if (casos.length === 0) {
    console.error(
      `No existe el caso "${filtro}". Disponibles: ${CASOS.map((c) => c.id).join(', ')}`,
    );
    process.exit(1);
  }

  const idSesion = randomUUID();
  const inicio = Date.now();
  const resultados: ResultadoCaso[] = [];

  console.log(`\nBanco de evaluación · ${casos.length} casos · modelo ${env.LLM_MODEL}\n`);

  for (const caso of casos) {
    process.stdout.write(`  ${caso.id} ${caso.titulo.slice(0, 52).padEnd(54)}`);
    const r = await evaluar(caso, idSesion);
    resultados.push(r);
    console.log(r.paso ? 'PASA' : 'FALLA');
    for (const c of r.condiciones.filter((x) => !x.ok)) {
      console.log(`       ${c.nombre}: ${c.detalle}`);
    }
  }

  const pasan = resultados.filter((r) => r.paso).length;
  const informe = {
    generado_en: new Date().toISOString(),
    modelo: env.LLM_MODEL,
    modelos_reserva: env.LLM_FALLBACK_MODELS,
    version_prompt: VERSION_PROMPT,
    id_sesion: idSesion,
    duracion_ms: Date.now() - inicio,
    resumen: {
      total: resultados.length,
      pasan,
      fallan: resultados.length - pasan,
      por_categoria: Object.fromEntries(
        ['aprobacion', 'rechazo', 'escalamiento', 'adversarial'].map((cat) => {
          const de = resultados.filter((r) => r.categoria === cat);
          return [cat, `${de.filter((r) => r.paso).length}/${de.length}`];
        }),
      ),
    },
    casos: resultados,
  };

  await mkdir(DIRECTORIO, { recursive: true });
  const archivo = join(DIRECTORIO, `evaluacion-${informe.generado_en.replace(/[:.]/g, '-')}.json`);
  await writeFile(archivo, `${JSON.stringify(informe, null, 2)}\n`, 'utf8');
  await writeFile(join(DIRECTORIO, 'ultima.json'), `${JSON.stringify(informe, null, 2)}\n`, 'utf8');

  console.log(`\n  ${pasan}/${resultados.length} casos pasan`);
  for (const [cat, marca] of Object.entries(informe.resumen.por_categoria)) {
    console.log(`    ${cat.padEnd(14)} ${marca}`);
  }
  console.log(`\n  Informe: eval-results/${archivo.split(/[\\/]/).pop()}\n`);

  await cerrarPool();
  // No se sale con error si algún caso falla: el enunciado admite entregar un
  // caso fallando siempre que se indique y se explique. Lo que no puede pasar
  // es que el informe no quede escrito.
}

await main();
