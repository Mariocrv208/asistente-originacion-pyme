import { Decimal, dinero, estaLiquidado, sumar } from './decimal.js';

/**
 * Cuota nivelada y tabla de amortizacion, sistema frances.
 *
 * Las tres decisiones que nadie documenta y siempre generan incidentes
 * (pregunta 2.6 del cuestionario) estan resueltas aqui y explicadas donde se
 * toman: donde redondear, como repartir el residuo y con que regla redondear.
 */

export interface Cuota {
  numero: number;
  /** Importe total que paga el cliente ese mes. */
  cuota: Decimal;
  interes: Decimal;
  capital: Decimal;
  saldoFinal: Decimal;
}

export interface TablaAmortizacion {
  principal: Decimal;
  tasaAnual: Decimal;
  tasaMensual: Decimal;
  plazoMeses: number;
  /** Cuota teorica redondeada a centavos. La pagan todos los meses menos el ultimo. */
  cuotaNivelada: Decimal;
  cuotas: Cuota[];
  totalCapital: Decimal;
  totalIntereses: Decimal;
  totalPagado: Decimal;
  /** Diferencia entre la ultima cuota y la nivelada. Es el residuo absorbido. */
  residuoAplicado: Decimal;
}

/** Plazo maximo admitido, en linea con el CHECK de la tabla solicitudes. */
const PLAZO_MAXIMO_MESES = 360;

export function calcularCuotaNivelada(
  principal: Decimal,
  tasaAnual: Decimal,
  plazoMeses: number,
): Decimal {
  const tasaMensual = tasaAnual.div(12);

  // Credito sin intereses: la formula de anualidad se indetermina porque el
  // denominador 1 - (1+i)^-n vale cero. Se resuelve como reparto simple.
  if (tasaMensual.isZero()) {
    return dinero(principal.div(plazoMeses));
  }

  // cuota = P * i / (1 - (1 + i)^-n)
  //
  // DONDE REDONDEAR: aqui, una sola vez, al final. La potencia y la division
  // se hacen con los 34 digitos de precision configurados; redondear a
  // centavos dentro de la formula arrastraria el error a las 360 cuotas.
  const factor = Decimal.sub(1, tasaMensual.plus(1).pow(-plazoMeses));
  return dinero(principal.times(tasaMensual).div(factor));
}

/**
 * Construye la tabla completa.
 *
 * El recorrido es ITERATIVO a proposito (pregunta 2.5 del cuestionario). Una
 * implementacion recursiva con una llamada por cuota parece elegante y es una
 * bomba: con 240 o 360 meses cada credito abre esa profundidad de pila, y el
 * proceso nocturno que recalcula 500,000 creditos en paralelo multiplica el
 * consumo por cada hilo. V8 no aplica optimizacion de llamada de cola —se
 * especifico en ES2015 y no se implemento—, asi que en Node la recursion aqui
 * no tiene ninguna red de seguridad: el fallo llega como RangeError por
 * desbordamiento de pila, y llega en produccion, con el plazo mas largo.
 */
export function construirTablaAmortizacion(
  principal: Decimal,
  tasaAnual: Decimal,
  plazoMeses: number,
): TablaAmortizacion {
  if (principal.lte(0)) {
    throw new RangeError(`El principal debe ser positivo, se recibio ${principal.toFixed()}`);
  }
  if (!Number.isInteger(plazoMeses) || plazoMeses < 1 || plazoMeses > PLAZO_MAXIMO_MESES) {
    throw new RangeError(
      `El plazo debe ser un entero entre 1 y ${PLAZO_MAXIMO_MESES}, se recibio ${plazoMeses}`,
    );
  }
  if (tasaAnual.isNegative()) {
    throw new RangeError(`La tasa no puede ser negativa, se recibio ${tasaAnual.toFixed()}`);
  }

  const tasaMensual = tasaAnual.div(12);
  const cuotaNivelada = calcularCuotaNivelada(principal, tasaAnual, plazoMeses);

  const cuotas: Cuota[] = [];
  let saldo = principal;

  for (let numero = 1; numero <= plazoMeses; numero += 1) {
    // El interes se redondea a centavos porque es lo que se cobra y lo que se
    // contabiliza. Es el segundo punto de redondeo, y el ultimo.
    const interes = dinero(saldo.times(tasaMensual));

    let capital: Decimal;
    let cuota: Decimal;

    if (numero < plazoMeses) {
      capital = cuotaNivelada.minus(interes);
      cuota = cuotaNivelada;
    } else {
      // COMO SE REPARTE EL RESIDUO: la ultima cuota amortiza todo el saldo que
      // quede, y su importe se recalcula como capital mas interes.
      //
      // Asi, por construccion:
      //   - la suma de los capitales es exactamente el principal;
      //   - la suma de las cuotas es exactamente capital mas intereses;
      //   - el saldo final es cero exacto, no aproximadamente cero.
      //
      // Se aplica al final y no repartido entre las primeras cuotas porque
      // "cuota nivelada" es una promesa al cliente: todas las cuotas menos una
      // son identicas. Repartir el residuo las volveria todas ligeramente
      // distintas y haria ilegible el plan de pagos por unos centavos.
      capital = saldo;
      cuota = capital.plus(interes);
    }

    saldo = saldo.minus(capital);
    cuotas.push({ numero, cuota, interes, capital, saldoFinal: saldo });
  }

  const ultima = cuotas[cuotas.length - 1]!;

  if (!estaLiquidado(ultima.saldoFinal)) {
    // No deberia ocurrir nunca. Si ocurre, es un fallo del algoritmo y no algo
    // que deba pasar en silencio a un plan de pagos real.
    throw new Error(
      `La tabla no liquida el saldo: queda ${ultima.saldoFinal.toFixed()} tras ${plazoMeses} cuotas`,
    );
  }

  const totalCapital = sumar(cuotas.map((c) => c.capital));
  const totalIntereses = sumar(cuotas.map((c) => c.interes));

  return {
    principal,
    tasaAnual,
    tasaMensual,
    plazoMeses,
    cuotaNivelada,
    cuotas,
    totalCapital,
    totalIntereses,
    totalPagado: sumar(cuotas.map((c) => c.cuota)),
    residuoAplicado: ultima.cuota.minus(cuotaNivelada),
  };
}

/**
 * Cuota anual estimada del credito nuevo.
 *
 * Es el insumo del indicador de cobertura de servicio de deuda del punto
 * 5.3.1. Se toma la cuota nivelada por doce, no el total pagado dividido entre
 * los anos: la cobertura mide si el negocio aguanta el servicio de deuda de un
 * ejercicio corriente, y ese es el importe que efectivamente saldra cada mes.
 */
export function cuotaAnualEstimada(
  principal: Decimal,
  tasaAnual: Decimal,
  plazoMeses: number,
): { cuotaMensual: Decimal; cuotaAnual: Decimal } {
  const cuotaMensual = calcularCuotaNivelada(principal, tasaAnual, plazoMeses);
  return { cuotaMensual, cuotaAnual: dinero(cuotaMensual.times(12)) };
}
