/**
 * Generador pseudoaleatorio determinista.
 *
 * Math.random() no sirve aqui. El enunciado pide un conjunto de datos que se
 * pueda regenerar, y el criterio de cierre de este modulo es que la generacion
 * sea reproducible byte a byte: si los datos cambian entre ejecuciones, los
 * diez casos de evaluacion de M18 dejan de referirse a las mismas solicitudes
 * y el banco de pruebas se vuelve inutil.
 *
 * mulberry32: 32 bits de estado, periodo de 2^32, distribucion uniforme
 * suficiente para datos sinteticos. No es criptografico y no pretende serlo.
 */
export class Aleatorio {
  private estado: number;

  constructor(semilla: number) {
    this.estado = semilla >>> 0;
  }

  /** Flotante uniforme en [0, 1). */
  siguiente(): number {
    this.estado = (this.estado + 0x6d2b79f5) >>> 0;
    let t = this.estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Entero uniforme en [min, max], ambos inclusive. */
  entero(min: number, max: number): number {
    return min + Math.floor(this.siguiente() * (max - min + 1));
  }

  /** Flotante uniforme en [min, max). */
  entre(min: number, max: number): number {
    return min + this.siguiente() * (max - min);
  }

  /**
   * Flotante log-uniforme en [min, max).
   *
   * Las ventas de una cartera PyME no se reparten de forma uniforme: hay
   * muchos negocios pequenos y pocos grandes. Muestrear en escala logaritmica
   * produce esa forma sin necesidad de una distribucion elaborada.
   */
  logUniforme(min: number, max: number): number {
    return Math.exp(this.entre(Math.log(min), Math.log(max)));
  }

  elegir<T>(opciones: readonly T[]): T {
    return opciones[this.entero(0, opciones.length - 1)]!;
  }

  /** Elige segun pesos relativos. Los pesos no necesitan sumar uno. */
  elegirPonderado<T>(opciones: ReadonlyArray<readonly [T, number]>): T {
    const total = opciones.reduce((s, [, peso]) => s + peso, 0);
    let acumulado = this.siguiente() * total;
    for (const [valor, peso] of opciones) {
      acumulado -= peso;
      if (acumulado <= 0) return valor;
    }
    return opciones[opciones.length - 1]![0];
  }

  /** true con la probabilidad indicada. */
  probabilidad(p: number): boolean {
    return this.siguiente() < p;
  }

  /** Baraja una copia del arreglo (Fisher-Yates). */
  barajar<T>(items: readonly T[]): T[] {
    const copia = [...items];
    for (let i = copia.length - 1; i > 0; i -= 1) {
      const j = this.entero(0, i);
      [copia[i], copia[j]] = [copia[j]!, copia[i]!];
    }
    return copia;
  }
}
