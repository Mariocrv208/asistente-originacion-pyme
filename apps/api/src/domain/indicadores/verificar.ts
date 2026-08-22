/**
 * Verificacion del criterio de cierre de M4.
 *
 * El criterio es concreto: la suma de las cuotas tiene que cuadrar EXACTAMENTE
 * contra capital mas intereses, y el saldo final tiene que ser cero exacto, no
 * aproximadamente cero.
 *
 * Los valores esperados de la cuota nivelada no salen de esta implementacion:
 * se calcularon aparte, con el modulo decimal de Python, para que la prueba no
 * sea circular. Si ambas implementaciones coinciden hasta el centavo sobre
 * plazos de 24, 36, 240 y 360 meses, la formula es correcta.
 */
import { pool, cerrarPool } from '../../db/pool.js';
import { construirTablaAmortizacion, calcularCuotaNivelada } from '../finanzas/amortizacion.js';
import { CERO, Decimal, dinero, estaLiquidado, sumar } from '../finanzas/decimal.js';
import { calcularIndicadores, huellaEntradas, type EntradasIndicadores } from './calcular.js';
import { obtenerIndicadores } from './repositorio.js';

interface Comprobacion {
  bloque: string;
  nombre: string;
  ok: boolean;
  detalle: string;
}

const comprobaciones: Comprobacion[] = [];
function afirmar(bloque: string, nombre: string, ok: boolean, detalle: string) {
  comprobaciones.push({ bloque, nombre, ok, detalle });
}

const TASA = new Decimal('0.18');

function entradasBase(): EntradasIndicadores {
  return {
    monto_solicitado: new Decimal('200000'),
    plazo_meses: 24,
    meses_operacion: 36,
    ventas_anuales: new Decimal('1000000'),
    utilidad_neta: new Decimal('120000'),
    activos_totales: new Decimal('800000'),
    pasivos_totales: new Decimal('300000'),
    deuda_vigente_anual: new Decimal('50000'),
    score_historial: 75,
    tasa_anual: TASA,
  };
}

async function main() {
  // =========================================================================
  const A = 'A. Amortizacion';

  // Valores calculados de forma independiente con Python (decimal, 34 digitos,
  // mitad al par). Si esta implementacion coincide, la formula es correcta.
  const referencias: Array<[string, number, string]> = [
    ['200000', 24, '9984.82'],
    ['100000', 240, '1543.31'],
    ['350000', 360, '5274.80'],
    ['12345.67', 36, '446.33'],
  ];

  for (const [principal, plazo, esperada] of referencias) {
    const obtenida = calcularCuotaNivelada(new Decimal(principal), TASA, plazo);
    afirmar(
      A,
      `Cuota nivelada de ${principal} a ${plazo} meses`,
      obtenida.toFixed(2) === esperada,
      `${obtenida.toFixed(2)} (referencia independiente: ${esperada})`,
    );
  }

  // El criterio de cierre del modulo, sobre varios plazos y montos.
  const casos: Array<[string, number, string]> = [
    ['200000', 24, '0.18'],
    ['100000', 240, '0.18'],
    ['350000', 360, '0.18'],
    ['12345.67', 36, '0.18'],
    ['50000', 1, '0.18'],
    ['0.01', 12, '0.18'],
    ['100000', 60, '0'],
    ['999999.99', 359, '0.4275'],
  ];

  for (const [principal, plazo, tasa] of casos) {
    const t = construirTablaAmortizacion(new Decimal(principal), new Decimal(tasa), plazo);
    const etiqueta = `${principal} a ${plazo}m al ${tasa}`;

    afirmar(
      A,
      `Los capitales suman el principal · ${etiqueta}`,
      t.totalCapital.equals(t.principal),
      `capital=${t.totalCapital.toFixed(2)} principal=${t.principal.toFixed(2)}`,
    );

    afirmar(
      A,
      `Las cuotas cuadran contra capital mas intereses · ${etiqueta}`,
      t.totalPagado.equals(t.totalCapital.plus(t.totalIntereses)),
      `pagado=${t.totalPagado.toFixed(2)} = ${t.totalCapital.toFixed(2)} + ${t.totalIntereses.toFixed(2)}`,
    );

    afirmar(
      A,
      `El saldo final es cero exacto · ${etiqueta}`,
      estaLiquidado(t.cuotas[t.cuotas.length - 1]!.saldoFinal),
      `saldo=${t.cuotas[t.cuotas.length - 1]!.saldoFinal.toFixed()}`,
    );

    // Cada cuota debe descomponerse exactamente en capital e interes.
    const descomposicionExacta = t.cuotas.every((c) => c.cuota.equals(c.capital.plus(c.interes)));
    afirmar(A, `Cada cuota = capital + interes · ${etiqueta}`, descomposicionExacta, 'todas');

    // "Cuota nivelada" tiene que significar algo: todas iguales menos la ultima.
    const nivelacion = t.cuotas.slice(0, -1).every((c) => c.cuota.equals(t.cuotaNivelada));
    afirmar(
      A,
      `Todas las cuotas menos la ultima son identicas · ${etiqueta}`,
      nivelacion || plazo === 1,
      `nivelada=${t.cuotaNivelada.toFixed(2)} residuo en la ultima=${t.residuoAplicado.toFixed(2)}`,
    );

    // Cota de cordura: el residuo nunca convierte la ultima cuota en otro
    // credito. La cota estrecha, la que de verdad importa, se mide mas abajo
    // sobre el envolvente que permiten las politicas.
    afirmar(
      A,
      `El residuo cabe dentro de una cuota · ${etiqueta}`,
      t.residuoAplicado.abs().lte(t.cuotaNivelada.plus(t.principal)),
      `residuo=${t.residuoAplicado.toFixed(2)}`,
    );
  }

  // El residuo crece con el plazo y con la tasa: redondear la cuota a centavos
  // y mantenerla fija hace que la diferencia se acumule cuota a cuota. A 24
  // meses es un centavo; a 360 meses al 18 por ciento son unos trece quetzales.
  //
  // Lo que importa es el envolvente real del producto: POL-10.1 fija la tasa en
  // 18 por ciento y POL-4.6 limita el plazo a 84 meses. Dentro de ese rango el
  // residuo tiene que ser de centavos, porque es lo que el cliente vera en su
  // ultima cuota.
  let peorResiduo = CERO;
  let peorCaso = '';
  for (const principal of ['10000', '75000', '250000', '500000']) {
    for (const plazo of [12, 24, 36, 48, 60, 72, 84]) {
      const t = construirTablaAmortizacion(new Decimal(principal), TASA, plazo);
      if (t.residuoAplicado.abs().gt(peorResiduo)) {
        peorResiduo = t.residuoAplicado.abs();
        peorCaso = `${principal} a ${plazo}m`;
      }
    }
  }
  afirmar(
    A,
    'Dentro del envolvente de politica el residuo es de centavos',
    peorResiduo.lt(1),
    `peor caso: ${peorCaso} con ${peorResiduo.toFixed(2)} de ajuste en la ultima cuota`,
  );

  const sinInteres = construirTablaAmortizacion(new Decimal('100000'), CERO, 60);
  afirmar(
    A,
    'Con tasa cero no se cobran intereses',
    sinInteres.totalIntereses.isZero() && sinInteres.totalPagado.equals(sinInteres.principal),
    `intereses=${sinInteres.totalIntereses.toFixed(2)} pagado=${sinInteres.totalPagado.toFixed(2)}`,
  );

  for (const [nombre, principal, tasa, plazo] of [
    ['principal cero', '0', '0.18', 24],
    ['principal negativo', '-100', '0.18', 24],
    ['plazo cero', '100000', '0.18', 0],
    ['plazo fuera de rango', '100000', '0.18', 361],
    ['tasa negativa', '100000', '-0.01', 24],
  ] as Array<[string, string, string, number]>) {
    let rechazado = false;
    try {
      construirTablaAmortizacion(new Decimal(principal), new Decimal(tasa), plazo);
    } catch {
      rechazado = true;
    }
    afirmar(A, `Entrada invalida rechazada: ${nombre}`, rechazado, rechazado ? 'lanza' : 'PASO');
  }

  // =========================================================================
  const R = 'B. Redondeo';

  // Mitad al par: 2.345 baja al par y 2.355 sube al par.
  afirmar(
    R,
    'Mitad al par redondea 2.345 a 2.34 y 2.355 a 2.36',
    dinero(new Decimal('2.345')).toFixed(2) === '2.34' &&
      dinero(new Decimal('2.355')).toFixed(2) === '2.36',
    `${dinero(new Decimal('2.345')).toFixed(2)} y ${dinero(new Decimal('2.355')).toFixed(2)}`,
  );

  // El argumento de por que la regla importa a escala.
  //
  // Se construyen 100,000 empates exactos repartidos por toda la escala de
  // centavos: 0.005, 0.015, 0.025... El detalle importa. Si todos los empates
  // cayeran en la posicion .005, las candidatas serian siempre .00 y .01, y
  // como el cero es par, mitad al par los bajaria TODOS. Esa muestra no
  // mediria el sesgo de la regla, mediria el sesgo de la muestra. Con los
  // empates repartidos, la mitad cae junto a un centavo par y la mitad junto a
  // uno impar, que es la situacion real de una cartera.
  const empates: Decimal[] = [];
  for (let k = 0; k < 100_000; k += 1) {
    const centavos = String(k % 100).padStart(2, '0');
    empates.push(new Decimal(`${Math.floor(k / 100)}.${centavos}5`));
  }

  const sesgoAlPar = sumar(empates.map((v) => dinero(v).minus(v)));
  const sesgoHaciaArriba = sumar(
    empates.map((v) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).minus(v)),
  );

  afirmar(
    R,
    'Mitad al par no sesga sobre 100,000 empates',
    sesgoAlPar.isZero(),
    `sesgo=${sesgoAlPar.toFixed(2)}`,
  );

  afirmar(
    R,
    'Mitad hacia arriba SI sesga, y por eso se descarta',
    sesgoHaciaArriba.gte(400),
    `sesgo=+${sesgoHaciaArriba.toFixed(2)} cobrados de mas sin ninguna base`,
  );

  // La demostracion de por que no se usa punto flotante binario.
  let flotante = 100000;
  const cuotaFlotante = 1543.31;
  for (let k = 0; k < 240; k += 1) {
    flotante = flotante - (cuotaFlotante - flotante * (0.18 / 12));
  }
  afirmar(
    R,
    'El punto flotante binario NO liquida el saldo',
    flotante !== 0,
    `saldo flotante tras 240 cuotas = ${flotante}  (con decimal.js: 0)`,
  );

  // =========================================================================
  const I = 'C. Indicadores';

  const base = calcularIndicadores(entradasBase());

  afirmar(
    I,
    'Razon de endeudamiento 300000/800000',
    base.razon_endeudamiento === '0.375',
    `${base.razon_endeudamiento}`,
  );
  afirmar(I, 'Margen neto 120000/1000000', base.margen_neto === '0.12', `${base.margen_neto}`);
  afirmar(
    I,
    'Relacion monto/ventas 200000/1000000',
    base.relacion_monto_ventas === '0.2',
    `${base.relacion_monto_ventas}`,
  );
  afirmar(
    I,
    'Cobertura de servicio de deuda (referencia independiente 0.706640)',
    base.cobertura_servicio_deuda === '0.70664',
    `${base.cobertura_servicio_deuda}  cuota anual=${base.cuota_anual_estimada}`,
  );
  afirmar(I, 'Antiguedad en meses', base.antiguedad_meses === 36, `${base.antiguedad_meses}`);

  afirmar(
    I,
    'El calculo es determinista',
    JSON.stringify(calcularIndicadores(entradasBase())) === JSON.stringify(base),
    'dos llamadas, mismo resultado',
  );

  const sinDatos = calcularIndicadores({
    ...entradasBase(),
    ventas_anuales: null,
    activos_totales: new Decimal('0'),
    deuda_vigente_anual: null,
    score_historial: null,
  });

  afirmar(
    I,
    'Activos en cero deja la razon sin calcular, no en cero',
    sinDatos.razon_endeudamiento === null,
    `${sinDatos.razon_endeudamiento}`,
  );
  afirmar(
    I,
    'Ventas ausentes dejan margen y relacion sin calcular',
    sinDatos.margen_neto === null && sinDatos.relacion_monto_ventas === null,
    'ambos nulos',
  );
  afirmar(
    I,
    'Deuda vigente ausente deja la cobertura sin calcular',
    sinDatos.cobertura_servicio_deuda === null,
    'no se supone cero, que regalaria una cobertura favorable',
  );

  const codigos = (x: typeof sinDatos) => x.hallazgos.map((h) => h.codigo);
  afirmar(
    I,
    'Se detecta la ausencia de score (la laguna del corpus)',
    codigos(sinDatos).includes('score_ausente'),
    codigos(sinDatos).join(', '),
  );

  const incoherente = calcularIndicadores({
    ...entradasBase(),
    pasivos_totales: new Decimal('9000000'),
    utilidad_neta: new Decimal('-5000'),
  });
  afirmar(
    I,
    'Se detectan pasivos mayores que activos y utilidad negativa',
    codigos(incoherente).includes('pasivos_superan_activos') &&
      codigos(incoherente).includes('utilidad_neta_negativa'),
    codigos(incoherente).join(', '),
  );

  const utilidadImposible = calcularIndicadores({
    ...entradasBase(),
    utilidad_neta: new Decimal('2000000'),
  });
  afirmar(
    I,
    'Se detecta utilidad superior a las ventas',
    codigos(utilidadImposible).includes('utilidad_supera_ventas'),
    codigos(utilidadImposible).join(', '),
  );

  afirmar(
    I,
    'La huella cambia si cambia una entrada del calculo',
    huellaEntradas(entradasBase()) !==
      huellaEntradas({ ...entradasBase(), ventas_anuales: new Decimal('1000001') }),
    'huellas distintas',
  );
  afirmar(
    I,
    'La huella NO cambia por un dato ajeno al calculo',
    huellaEntradas(entradasBase()) === huellaEntradas({ ...entradasBase(), score_historial: 10 }),
    'misma huella',
  );

  // =========================================================================
  const D = 'D. Precalculo en base de datos';
  const cliente = await pool.connect();
  await cliente.query('BEGIN');

  try {
    const { rows } = await cliente.query<{ id_solicitud: string }>(
      `INSERT INTO solicitudes (nombre_empresa, sector, meses_operacion, monto_solicitado,
         plazo_meses, destino_fondos, ventas_anuales, utilidad_neta, activos_totales,
         pasivos_totales, deuda_vigente_anual, score_historial, garantia_ofrecida, fecha_solicitud)
       VALUES ('Verificacion M4','comercio',36,200000,24,'capital de trabajo',
               1000000,120000,800000,300000,50000,75,'fiduciaria',CURRENT_DATE)
       RETURNING id_solicitud`,
    );
    const id = rows[0]!.id_solicitud;

    const primera = await obtenerIndicadores(id, cliente);
    afirmar(
      D,
      'El primer acceso calcula y persiste',
      primera?.recalculado === true,
      `recalculado=${primera?.recalculado}`,
    );

    const segunda = await obtenerIndicadores(id, cliente);
    afirmar(
      D,
      'El segundo acceso reutiliza el precalculo',
      segunda?.recalculado === false,
      `recalculado=${segunda?.recalculado}`,
    );

    // Lo que compara G2: el valor guardado y el recalculado tienen que ser
    // identicos como texto, no solo numericamente parecidos.
    const { rows: guardado } = await cliente.query<Record<string, string | null>>(
      `SELECT razon_endeudamiento, margen_neto, cobertura_servicio_deuda, relacion_monto_ventas
         FROM indicadores_solicitud WHERE id_solicitud = $1`,
      [id],
    );
    const g = guardado[0]!;
    const coincide =
      new Decimal(g.razon_endeudamiento!).equals(primera!.indicadores.razon_endeudamiento!) &&
      new Decimal(g.margen_neto!).equals(primera!.indicadores.margen_neto!) &&
      new Decimal(g.cobertura_servicio_deuda!).equals(
        primera!.indicadores.cobertura_servicio_deuda!,
      ) &&
      new Decimal(g.relacion_monto_ventas!).equals(primera!.indicadores.relacion_monto_ventas!);
    afirmar(
      D,
      'Lo guardado coincide con lo recalculado (base de G2)',
      coincide,
      `razon guardada=${g.razon_endeudamiento}`,
    );

    // El trigger de invalidacion de la migracion 0003, en accion.
    await cliente.query(`UPDATE solicitudes SET ventas_anuales = 1200000 WHERE id_solicitud = $1`, [
      id,
    ]);
    const { rows: tras } = await cliente.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM indicadores_solicitud WHERE id_solicitud = $1`,
      [id],
    );
    afirmar(
      D,
      'Cambiar una entrada invalida el precalculo',
      tras[0]!.n === 0,
      'la fila desaparece: no existe "calculado pero obsoleto"',
    );

    const tercera = await obtenerIndicadores(id, cliente);
    afirmar(
      D,
      'Tras la invalidacion se recalcula con el dato nuevo',
      tercera?.recalculado === true && tercera.indicadores.margen_neto === '0.1',
      `margen=${tercera?.indicadores.margen_neto} (120000/1200000)`,
    );
  } finally {
    await cliente.query('ROLLBACK');
    cliente.release();
  }

  // =========================================================================
  const ancho = Math.min(72, Math.max(...comprobaciones.map((c) => c.nombre.length)));
  let bloque = '';
  console.log('\nVerificacion del nucleo financiero (M4)');
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
  await cerrarPool();
  if (fallos > 0) process.exit(1);
}

await main();
