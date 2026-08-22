/**
 * Verificacion del criterio de cierre de M5.
 *
 * El criterio es que la generacion sea reproducible byte a byte. Se comprueba
 * de dos formas: generando dos veces en memoria y comparando, y comparando
 * contra el archivo que hay en disco. La segunda es la que importa: detecta que
 * alguien edito data/dataset.json a mano, lo que romperia la correspondencia
 * entre el archivo versionado y lo que el generador produce.
 */
import { readFile } from 'node:fs/promises';
import { Decimal } from '../domain/finanzas/decimal.js';
import { pool, cerrarPool } from '../db/pool.js';
import { generarDataset, huella, RUTA_DATASET, serializar } from './generar.js';

interface Comprobacion {
  bloque: string;
  nombre: string;
  ok: boolean | null; // null = omitida
  detalle: string;
}

const comprobaciones: Comprobacion[] = [];
const afirmar = (bloque: string, nombre: string, ok: boolean | null, detalle: string) =>
  comprobaciones.push({ bloque, nombre, ok, detalle });

async function main() {
  // =========================================================================
  const D = 'A. Determinismo';

  const primera = serializar(await generarDataset());
  const segunda = serializar(await generarDataset());

  afirmar(
    D,
    'Dos generaciones seguidas producen bytes identicos',
    primera === segunda,
    `sha256 = ${huella(primera).slice(0, 16)}...`,
  );

  let enDisco: string | null = null;
  try {
    enDisco = await readFile(RUTA_DATASET, 'utf8');
  } catch {
    enDisco = null;
  }

  afirmar(
    D,
    'El archivo en disco coincide con lo que produce el generador',
    enDisco === null ? false : enDisco === primera,
    enDisco === null
      ? 'no existe data/dataset.json: ejecuta pnpm datos:generar'
      : enDisco === primera
        ? 'identicos'
        : 'DIVERGEN: el archivo se edito a mano o el generador cambio',
  );

  const dataset = JSON.parse(primera) as Awaited<ReturnType<typeof generarDataset>>;
  const S = dataset.solicitudes;

  // =========================================================================
  const E = 'B. Exigencias del punto 5.2.1';

  afirmar(E, 'Al menos 200 solicitudes', S.length >= 200, `${S.length} solicitudes`);

  const manipuladas = S.filter((s) => s.etiquetas.includes('intento_manipulacion'));
  afirmar(
    E,
    'Al menos 3 con intentos de manipulacion en destino_fondos',
    manipuladas.length >= 3,
    `${manipuladas.length} solicitudes (G5)`,
  );

  const inconsistentes = S.filter((s) => s.etiquetas.includes('datos_inconsistentes'));
  afirmar(
    E,
    'Al menos 5 con datos incompletos o inconsistentes',
    inconsistentes.length >= 5,
    inconsistentes.map((s) => s.etiquetas.at(-1)).join(', '),
  );

  afirmar(
    E,
    'Hay historico de dictamenes para la vista de metricas',
    dataset.dictamenes_historicos.length >= 30,
    `${dataset.dictamenes_historicos.length} dictamenes`,
  );

  afirmar(
    E,
    'Identificadores unicos',
    new Set(S.map((s) => s.id_solicitud)).size === S.length,
    `${new Set(S.map((s) => s.id_solicitud)).size} identificadores`,
  );

  const decimalValido = (v: string | null) => v === null || /^-?\d+\.\d{2}$/.test(v);
  const malFormados = S.filter(
    (s) =>
      !decimalValido(s.monto_solicitado) ||
      !decimalValido(s.ventas_anuales) ||
      !decimalValido(s.utilidad_neta) ||
      !decimalValido(s.activos_totales) ||
      !decimalValido(s.pasivos_totales) ||
      !decimalValido(s.deuda_vigente_anual),
  );
  afirmar(
    E,
    'Todos los importes son decimales con dos posiciones',
    malFormados.length === 0,
    malFormados.length === 0
      ? 'sin notacion exponencial ni flotantes'
      : `${malFormados.length} mal formados`,
  );

  // =========================================================================
  // Cobertura de caminos de decision. Si el conjunto no contiene casos de cada
  // tipo, el banco de evaluacion de M18 no se puede construir: el enunciado
  // exige tres rechazos por motivos de politica DISTINTOS y dos escalamientos,
  // uno por monto y otro por ausencia de politica aplicable.
  const C = 'C. Cobertura para el banco de evaluacion';
  const dec = (v: string | null) => (v === null ? null : new Decimal(v));

  const cuenta = (predicado: (s: (typeof S)[number]) => boolean) => S.filter(predicado).length;

  const buckets: Array<[string, number, number]> = [
    [
      'Endeudamiento sobre 0.65 sin garantia hipotecaria (POL-2.3)',
      cuenta((s) => {
        const a = dec(s.activos_totales);
        const p = dec(s.pasivos_totales);
        return (
          a !== null &&
          p !== null &&
          !a.isZero() &&
          p.div(a).gt('0.65') &&
          s.garantia_ofrecida !== 'hipotecaria'
        );
      }),
      5,
    ],
    ['Antiguedad menor a 24 meses (POL-1.2)', cuenta((s) => s.meses_operacion < 24), 5],
    [
      'Score por debajo de 40 (POL-3.4)',
      cuenta((s) => s.score_historial !== null && s.score_historial < 40),
      5,
    ],
    [
      'Monto sobre el 30 por ciento de las ventas (POL-4.1)',
      cuenta((s) => {
        const v = dec(s.ventas_anuales);
        return v !== null && !v.isZero() && new Decimal(s.monto_solicitado).div(v).gt('0.30');
      }),
      5,
    ],
    [
      'Monto sobre Q250,000: escalamiento por monto (POL-6.2)',
      cuenta((s) => new Decimal(s.monto_solicitado).gt(250_000)),
      5,
    ],
    [
      'Score ausente: escalamiento por falta de politica aplicable',
      cuenta((s) => s.score_historial === null),
      2,
    ],
    [
      'Sin ningun rasgo bloqueante: aprobacion clara',
      cuenta((s) => {
        const a = dec(s.activos_totales);
        const p = dec(s.pasivos_totales);
        const v = dec(s.ventas_anuales);
        if (a === null || p === null || v === null || s.deuda_vigente_anual === null) return false;
        if (a.isZero() || v.isZero()) return false;
        if (p.div(a).gt('0.65') && s.garantia_ofrecida !== 'hipotecaria') return false;
        if (s.meses_operacion < 24) return false;
        if (s.score_historial === null || s.score_historial < 40) return false;
        if (new Decimal(s.monto_solicitado).div(v).gt('0.30')) return false;
        if (new Decimal(s.monto_solicitado).gt(250_000)) return false;
        return true;
      }),
      10,
    ],
  ];

  for (const [nombre, encontrados, minimo] of buckets) {
    afirmar(C, nombre, encontrados >= minimo, `${encontrados} casos (minimo ${minimo})`);
  }

  // =========================================================================
  const B = 'D. Base de datos';
  let bdDisponible = true;
  try {
    await pool.query('SELECT 1');
  } catch {
    bdDisponible = false;
  }

  if (!bdDisponible) {
    afirmar(B, 'Las solicitudes estan sembradas', null, 'base de datos no disponible');
    afirmar(B, 'Los dictamenes historicos estan sembrados', null, 'base de datos no disponible');
    afirmar(
      B,
      'Toda solicitud sembrada conserva su identificador',
      null,
      'base de datos no disponible',
    );
  } else {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM solicitudes');
    afirmar(
      B,
      'Las solicitudes estan sembradas',
      rows[0]!.n >= S.length,
      `${rows[0]!.n} en base de datos, ${S.length} en el dataset`,
    );

    const { rows: d2 } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dictamenes WHERE clave_idempotencia LIKE 'historico:%'`,
    );
    afirmar(
      B,
      'Los dictamenes historicos estan sembrados',
      d2[0]!.n === dataset.dictamenes_historicos.length,
      `${d2[0]!.n} de ${dataset.dictamenes_historicos.length}`,
    );

    const { rows: d3 } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM solicitudes WHERE id_solicitud = ANY($1::uuid[])`,
      [S.map((s) => s.id_solicitud)],
    );
    afirmar(
      B,
      'Toda solicitud sembrada conserva su identificador',
      d3[0]!.n === S.length,
      `${d3[0]!.n} de ${S.length} encontradas por su UUID determinista`,
    );
  }

  // =========================================================================
  const ancho = Math.max(...comprobaciones.map((c) => c.nombre.length));
  let bloque = '';
  console.log('\nVerificacion del conjunto de datos sinteticos (M5)');
  for (const c of comprobaciones) {
    if (c.bloque !== bloque) {
      bloque = c.bloque;
      console.log(`\n  ${bloque}`);
    }
    const marca = c.ok === null ? 'OMIT ' : c.ok ? 'OK   ' : 'FALLA';
    console.log(`    ${marca} ${c.nombre.padEnd(ancho)}  ${c.detalle}`);
  }

  const fallos = comprobaciones.filter((c) => c.ok === false).length;
  const omitidas = comprobaciones.filter((c) => c.ok === null).length;
  const correctas = comprobaciones.filter((c) => c.ok === true).length;

  console.log(`\n  ${correctas}/${correctas + fallos} comprobaciones correctas`);
  if (omitidas > 0) {
    console.log(
      `  ${omitidas} omitidas porque la base de datos no responde. ` +
        `Levantala con pnpm db:up y vuelve a ejecutar.`,
    );
  }
  console.log('');

  await cerrarPool();
  if (fallos > 0) process.exit(1);
}

await main();
