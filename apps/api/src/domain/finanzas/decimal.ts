import { Decimal } from 'decimal.js';

/**
 * Configuracion global de la aritmetica decimal del sistema.
 *
 * POR QUE NO PUNTO FLOTANTE BINARIO (pregunta 2.6 del cuestionario)
 *
 * El doble de precision binario del IEEE 754 no puede representar 0.1 ni 0.01.
 * En Guatemala se factura en centavos, asi que cada monto del sistema es un
 * numero que ese formato solo puede aproximar. El error es diminuto por
 * operacion y se acumula al recorrer una tabla de amortizacion:
 *
 *   0.1 + 0.2 === 0.30000000000000004
 *
 * Ejemplo concreto donde se vuelve visible para el cliente: un credito de
 * Q100,000 a 240 meses genera 240 cuotas. Si cada una arrastra un error de
 * medio centavo, el saldo final no llega a cero y el cliente recibe un estado
 * de cuenta con una deuda residual de unos centavos que nadie sabe explicar,
 * o peor, la ultima cuota le cobra de mas. En contabilidad el sintoma es una
 * partida descuadrada que no cierra contra el mayor.
 *
 * REGLA DE REDONDEO: MITAD AL PAR
 *
 * Se elige ROUND_HALF_EVEN, no ROUND_HALF_UP. La diferencia es irrelevante en
 * una operacion y decisiva en cientos de miles: redondear siempre hacia arriba
 * en el empate introduce un sesgo sistematico al alza. Sobre 500,000 creditos
 * recalculados cada noche, ese sesgo se convierte en dinero real que la
 * institucion cobra de mas sin ninguna base. Mitad al par reparte los empates
 * entre arriba y abajo y su valor esperado es cero.
 *
 * PRECISION INTERMEDIA
 *
 * 34 digitos significativos, la misma que decimal128. Los calculos intermedios
 * —la potencia de la formula de anualidad, sobre todo— se hacen con holgura, y
 * el redondeo a dos decimales ocurre solo en los puntos donde el resultado es
 * dinero que alguien va a pagar. Redondear antes de tiempo destruye precision;
 * redondear despues de tiempo produce importes que no existen en centavos.
 */
Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_EVEN,
  // Sin estos limites, decimal.js emite notacion exponencial al convertir a
  // texto, y PostgreSQL rechazaria "1e+5" en una columna NUMERIC.
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export { Decimal };

/** Decimales de un importe monetario. El quetzal se divide en centavos. */
export const DECIMALES_DINERO = 2;

/**
 * Decimales de una razon financiera.
 *
 * Seis, que es la escala de las columnas NUMERIC(14,6) donde se guardan. La
 * escala tiene que coincidir con la de la base de datos: G2 compara el
 * indicador del dictamen contra el recalculo, y si una parte redondea a seis
 * decimales y la otra no, la comparacion falla por una diferencia que no
 * existe.
 */
export const DECIMALES_RAZON = 6;

export const CERO = new Decimal(0);

/** Redondea a centavos con la regla de la casa. */
export function dinero(valor: Decimal.Value): Decimal {
  return new Decimal(valor).toDecimalPlaces(DECIMALES_DINERO, Decimal.ROUND_HALF_EVEN);
}

/** Redondea una razon a la escala con la que se almacena y se compara. */
export function razon(valor: Decimal.Value): Decimal {
  return new Decimal(valor).toDecimalPlaces(DECIMALES_RAZON, Decimal.ROUND_HALF_EVEN);
}

/**
 * Convierte un valor leido de PostgreSQL.
 *
 * El driver devuelve NUMERIC como cadena precisamente para que no pase por
 * Number (ver el parser registrado en db/pool.ts). Aqui esa cadena entra
 * directamente a Decimal, sin tocar el punto flotante binario en ningun
 * momento del recorrido.
 */
export function desdeBd(valor: string | null | undefined): Decimal | null {
  if (valor === null || valor === undefined) return null;
  return new Decimal(valor);
}

/** Prepara un decimal para escribirlo en una columna NUMERIC. */
export function haciaBd(valor: Decimal | null): string | null {
  return valor === null ? null : valor.toFixed();
}

/**
 * Comprueba si un saldo esta liquidado.
 *
 * POR QUE `saldo == 0` ES PELIGROSO
 *
 * Con punto flotante binario la comparacion es directamente una trampa: tras
 * doscientas cuarenta restas el saldo vale algo como 1.4e-11, que no es cero,
 * y el credito queda vivo para siempre. El sintoma tipico es un prestamo
 * pagado que sigue devengando intereses sobre una millonesima de centavo.
 *
 * Con decimal.js el cero exacto SI es alcanzable, y esta implementacion lo
 * garantiza: la ultima cuota amortiza el saldo restante completo, sea cual sea.
 * Pero la comparacion sigue sin poder escribirse como `saldo === 0`, porque un
 * Decimal es un objeto: esa expresion compara referencias y siempre da falso.
 * Y `saldo.equals(0)` daria falso para `-0` o para un valor con escala
 * distinta. De ahi que exista esta funcion y que el resto del codigo no
 * compare saldos a mano.
 */
export function estaLiquidado(saldo: Decimal): boolean {
  return saldo.isZero();
}

/** Suma exacta de una lista de decimales, sin redondeos intermedios. */
export function sumar(valores: readonly Decimal[]): Decimal {
  return valores.reduce<Decimal>((acumulado, v) => acumulado.plus(v), CERO);
}
