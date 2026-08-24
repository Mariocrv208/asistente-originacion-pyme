/**
 * Verificación del informe acumulativo, sin gastar cuota.
 *
 * Lo que se comprueba aquí es lo único que no se puede permitir que falle en una
 * evaluación repartida en varios días: que una tanda no borre el trabajo de la
 * anterior. Si eso se rompiera, el fallo aparecería el último día, con la cuota
 * ya gastada y sin margen para repetir.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CASOS } from './casos.js';
import {
  casosPendientes,
  DIRECTORIO,
  fusionar,
  type CasoEnInforme,
  type Tanda,
} from './informe.js';

const RUTA = join(DIRECTORIO, 'ultima.json');
const RESPALDO = join(DIRECTORIO, 'ultima.respaldo.json');

const comprobaciones: Array<{ nombre: string; ok: boolean; detalle: string }> = [];
const afirmar = (nombre: string, ok: boolean, detalle: string) =>
  comprobaciones.push({ nombre, ok, detalle });

function casoFalso(id: string, paso: boolean): CasoEnInforme {
  const c = CASOS.find((x) => x.id === id)!;
  return {
    id,
    titulo: c.titulo,
    categoria: c.categoria,
    idSolicitud: c.idSolicitud,
    paso,
    condiciones: [{ nombre: 'simulada', ok: paso, detalle: 'prueba del informe' }],
    decisionObtenida: c.decisionEsperada,
    decisionEsperada: c.decisionEsperada,
    citas: [c.politicaEsperada],
    idDictamen: null,
    idEjecucion: '00000000-0000-4000-8000-000000000000',
    degradado: false,
    iteraciones: 3,
    latenciaMs: 1000,
    modelo: 'prueba',
    ejecutado_en: new Date().toISOString(),
  };
}

const tanda = (casos: string[]): Tanda => ({
  ejecutado_en: new Date().toISOString(),
  modelo_configurado: 'prueba',
  version_prompt: 'prueba',
  id_sesion: '00000000-0000-4000-8000-000000000000',
  casos,
  duracion_ms: 100,
  interrumpida_por_cuota: false,
});

async function main() {
  // El informe real, si existe, se aparta y se restaura al final.
  let habiaInforme = true;
  try {
    await writeFile(RESPALDO, await readFile(RUTA, 'utf8'), 'utf8');
  } catch {
    habiaInforme = false;
  }
  await rm(RUTA, { force: true });

  try {
    afirmar(
      'Sin informe previo, están pendientes los diez casos',
      (await casosPendientes()).length === CASOS.length,
      `${(await casosPendientes()).length} pendientes`,
    );

    // --- Primera tanda -----------------------------------------------------
    const primera = await fusionar(
      [casoFalso('A1', true), casoFalso('A2', true), casoFalso('R1', false)],
      tanda(['A1', 'A2', 'R1']),
    );

    afirmar(
      'Tras la primera tanda hay tres casos con resultado',
      primera.casos_con_resultado === 3 && primera.estado === 'parcial',
      `${primera.casos_con_resultado}/10, estado ${primera.estado}`,
    );
    afirmar(
      'Los pendientes son los siete que faltan',
      primera.pendientes.length === 7 && !primera.pendientes.includes('A1'),
      primera.pendientes.join(', '),
    );
    afirmar(
      'El resumen cuenta solo lo ejecutado',
      primera.resumen.pasan === 2 && primera.resumen.fallan === 1,
      `${primera.resumen.pasan} pasan, ${primera.resumen.fallan} fallan`,
    );

    // --- Segunda tanda: lo importante --------------------------------------
    const segunda = await fusionar(
      [casoFalso('R2', true), casoFalso('E1', true)],
      tanda(['R2', 'E1']),
    );

    afirmar(
      'La segunda tanda NO borra los resultados de la primera',
      segunda.casos_con_resultado === 5 &&
        segunda.casos.A1 !== undefined &&
        segunda.casos.R1 !== undefined,
      `${segunda.casos_con_resultado} casos acumulados`,
    );
    afirmar(
      'Las tandas quedan registradas por separado',
      segunda.tandas.length === 2,
      `${segunda.tandas.length} tandas en el historial`,
    );
    afirmar(
      'casosPendientes solo devuelve los que faltan de verdad',
      (await casosPendientes()).length === 5,
      (await casosPendientes()).join(', '),
    );

    // --- Reejecutar un caso reemplaza su resultado --------------------------
    const tercera = await fusionar([casoFalso('R1', true)], tanda(['R1']));
    afirmar(
      'Reejecutar un caso reemplaza su resultado, no lo duplica',
      tercera.casos_con_resultado === 5 && tercera.casos.R1!.paso === true,
      `R1 pasa ahora de fallar a pasar, con ${tercera.casos_con_resultado} casos en total`,
    );

    // --- Informe completo ----------------------------------------------------
    const completo = await fusionar(
      ['A3', 'R3', 'E2', 'X1', 'X2'].map((id) => casoFalso(id, true)),
      tanda(['A3', 'R3', 'E2', 'X1', 'X2']),
    );
    afirmar(
      'Con los diez casos el informe se marca completo',
      completo.estado === 'completo' && completo.pendientes.length === 0,
      `estado ${completo.estado}, ${completo.casos_con_resultado}/10`,
    );
    afirmar(
      'Los casos se ordenan como el banco, no por cronología',
      Object.keys(completo.casos).join(',') === CASOS.map((c) => c.id).join(','),
      Object.keys(completo.casos).join(', '),
    );
  } finally {
    await rm(RUTA, { force: true });
    if (habiaInforme) {
      await writeFile(RUTA, await readFile(RESPALDO, 'utf8'), 'utf8');
    }
    await rm(RESPALDO, { force: true });
  }

  const ancho = Math.max(...comprobaciones.map((c) => c.nombre.length));
  console.log('\nVerificacion del informe acumulativo de evaluacion\n');
  for (const c of comprobaciones) {
    console.log(`  ${c.ok ? 'OK   ' : 'FALLA'} ${c.nombre.padEnd(ancho)}  ${c.detalle}`);
  }
  const fallos = comprobaciones.filter((c) => !c.ok).length;
  console.log(
    `\n  ${comprobaciones.length - fallos}/${comprobaciones.length} comprobaciones correctas\n`,
  );
  if (fallos > 0) process.exit(1);
}

await main();
