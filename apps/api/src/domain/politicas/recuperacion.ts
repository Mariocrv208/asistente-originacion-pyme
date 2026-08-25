import type { Politica } from '@aop/shared';
import { indexar, leerCorpus } from './corpus.js';
import { IndiceLexico, tokenizar } from './indice.js';
import { rerankear } from './reranking.js';

/**
 * Recuperacion de politicas.
 *
 * Es la implementacion interna de la herramienta buscar_politica del punto
 * 5.3.3, cuya firma exige devolver {id_politica, seccion, texto_literal}.
 *
 * Tres etapas:
 *   1. enrutamiento por categoria, como SESGO y nunca como filtro;
 *   2. ordenacion lexica BM25;
 *   3. cierre por excepciones: si entra una regla, entran sus excepciones, y
 *      viceversa.
 *
 * La etapa 3 es la que resuelve el caso dificil del enunciado. Las dos
 * primeras, por si solas, lo fallan.
 */

/** Terminos que apuntan a cada categoria del corpus. */
const LEXICO_CATEGORIAS: Record<string, readonly string[]> = {
  capacidad_pago: [
    'endeudamiento',
    'pasivos',
    'activos',
    'margen',
    'utilidad',
    'cobertura',
    'servicio',
    'deuda',
    'capacidad',
    'pago',
    'razon',
    'neto',
    'ventas',
  ],
  elegibilidad: [
    'elegibilidad',
    'antiguedad',
    'meses',
    'formal',
    'solicitante',
    'tramite',
    'continuos',
    'negocio',
    'territorio',
    'extranjero',
    'acreditar',
  ],
  monto: ['monto', 'tope', 'maximo', 'minimo', 'aprobado', 'porcentaje', 'microcredito'],
  plazo: ['plazo', 'capital', 'trabajo', 'activo', 'fijo', 'adquisicion'],
  garantia: [
    'garantia',
    'hipotecaria',
    'prendaria',
    'fiduciaria',
    'avaluo',
    'score',
    'historial',
    'puntos',
    'real',
    'inscrita',
    'cubrir',
  ],
  sector: [
    'sector',
    'actividad',
    'restringido',
    'restringidos',
    'agropecuario',
    'construccion',
    'estacionalidad',
    'azar',
    'minera',
    'armas',
  ],
  autorizacion: [
    'autorizacion',
    'autoriza',
    'autorizar',
    'autorizada',
    'comite',
    'gerente',
    'agencia',
    'nivel',
    'niveles',
    'delegacion',
    'aprueba',
  ],
  documentacion: [
    'documentacion',
    'expediente',
    'estados',
    'financieros',
    'contador',
    'incompleta',
    'inconsistente',
    'ejercicios',
    'firmados',
  ],
  destino: ['destino', 'fondos', 'refinanciamiento', 'productiva', 'verificacion', 'declarado'],
  excepcion: ['excepcion', 'excepciones', 'admitira', 'salvo'],
  tasa: ['tasa', 'interes', 'referencia', 'saldos', 'trimestralmente'],
};

export type MotivoInclusion = 'coincidencia_lexica' | 'excepcion_de_regla' | 'regla_de_excepcion';

export interface FragmentoPolitica {
  id_politica: string;
  seccion: string;
  texto_literal: string;
  categoria: string;
  severidad: Politica['severidad'];
  /** Politicas que esta modifica parcialmente. */
  modifica_a: string[];
  puntaje: number;
  motivo: MotivoInclusion;
  /** Cuando entra por cierre, la politica que la arrastro. */
  relacionada_con?: string;
}

export interface OpcionesBusqueda {
  topK?: number;
  /**
   * Categorias sugeridas. Es un SESGO, no un filtro. Ver la nota de
   * enrutarCategorias sobre por que filtrar de verdad seria un error.
   */
  categorias?: readonly string[];
  /** Permite desactivar el cierre por excepciones para poder medirlo (M19). */
  expandirExcepciones?: boolean;
  /** Permite desactivar el reordenamiento conceptual para poder medirlo (M19). */
  rerankear?: boolean;
}

const TOP_K_POR_DEFECTO = 6;
/** Cuanto suma pertenecer a una categoria enrutada. Empuja, no decide. */
const BONIFICACION_CATEGORIA = 1.5;
/** Fraccion del mejor puntaje por debajo de la cual un resultado se descarta. */
const UMBRAL_RELATIVO = 0.3;

/**
 * Lematizacion por truncamiento: las seis primeras letras.
 *
 * Es tosco y funciona bien en espanol, donde la flexion vive al final de la
 * palabra: "destino" y "destinarse" comparten "destin", "autorizacion" y
 * "autoriza" comparten "autori". Sin esto, una consulta redactada en lenguaje
 * natural —"a que debe destinarse el credito"— no enruta a ninguna categoria.
 *
 * Se aplica SOLO al enrutador, no al indice BM25. El enrutador es difuso por
 * diseno y su salida es una bonificacion; el indice trabaja sobre terminos
 * exactos porque de el salen los textos que despues tienen que ser citas
 * literales.
 */
function raiz(palabra: string): string {
  return palabra.length > 6 ? palabra.slice(0, 6) : palabra;
}

/**
 * Deduce a que categorias apunta una consulta.
 *
 * IMPORTANTE: el resultado se usa como bonificacion en el ranking, nunca para
 * filtrar. Filtrar por categoria seria un error sistematico, y de los que no se
 * notan hasta que un auditor lo encuentra: las excepciones viven en la
 * categoria "excepcion", no en la de la regla que modifican. Una consulta sobre
 * endeudamiento enrutada duramente a "capacidad_pago" nunca recuperaria
 * POL-7.3, que es justo la politica que permite superar el limite. El sistema
 * citaria la regla general y aplicaria un rechazo que la excepcion desmiente.
 */
export function enrutarCategorias(consulta: string): string[] {
  const terminos = new Set(tokenizar(consulta).map(raiz));
  const puntajes: Array<[string, number]> = [];

  for (const [categoria, palabras] of Object.entries(LEXICO_CATEGORIAS)) {
    const aciertos = palabras.filter((p) => terminos.has(raiz(p))).length;
    if (aciertos > 0) puntajes.push([categoria, aciertos]);
  }

  return puntajes
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .map(([categoria]) => categoria);
}

export class RecuperadorPoliticas {
  private constructor(
    private readonly indice: IndiceLexico,
    private readonly porId: ReadonlyMap<string, Politica>,
    /** Indice inverso: politica general -> excepciones que la modifican. */
    private readonly excepcionesDe: ReadonlyMap<string, string[]>,
    readonly versionCorpus: string,
  ) {}

  static async cargar(): Promise<RecuperadorPoliticas> {
    const corpus = await leerCorpus();
    const porId = indexar(corpus);

    const excepcionesDe = new Map<string, string[]>();
    for (const politica of corpus.politicas) {
      for (const general of politica.modifica_a) {
        const lista = excepcionesDe.get(general) ?? [];
        lista.push(politica.id);
        excepcionesDe.set(general, lista);
      }
    }

    return new RecuperadorPoliticas(
      new IndiceLexico(corpus.politicas),
      porId,
      excepcionesDe,
      corpus.version,
    );
  }

  get tamanoCorpus(): number {
    return this.indice.tamano;
  }

  obtener(id: string): Politica | undefined {
    return this.porId.get(id);
  }

  /** Corpus completo, para la estrategia de comparacion de M19. */
  todas(): Politica[] {
    return [...this.porId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  buscar(consulta: string, opciones: OpcionesBusqueda = {}): FragmentoPolitica[] {
    const topK = opciones.topK ?? TOP_K_POR_DEFECTO;
    const expandir = opciones.expandirExcepciones ?? true;
    const conRerank = opciones.rerankear ?? true;
    const categorias = new Set(opciones.categorias ?? enrutarCategorias(consulta));

    const conBonificacion = this.indice.puntuar(consulta).map((p) => ({
      ...p,
      puntaje: p.puntaje + (categorias.has(p.politica.categoria) ? BONIFICACION_CATEGORIA : 0),
    }));

    // El reordenamiento conceptual (M19, punto extra 5.4) es una segunda etapa
    // sobre lo que BM25 ya recupero: puede promover un fragmento que el lexico
    // puntuo en 0, pero nunca inventa candidatos que BM25 no haya visto.
    const puntuadas = conRerank
      ? rerankear(conBonificacion, consulta)
      : [...conBonificacion].sort((a, b) =>
          b.puntaje === a.puntaje
            ? a.politica.id.localeCompare(b.politica.id)
            : b.puntaje - a.puntaje,
        );

    // Umbral relativo al mejor resultado. Sin el, el top-k se rellena con
    // politicas que apenas comparten una palabra vacia con la consulta, y esas
    // politicas acaban ocupando contexto del modelo sin aportar nada.
    const mejor = puntuadas[0]?.puntaje ?? 0;
    const minimo = mejor * UMBRAL_RELATIVO;

    const seleccionadas = puntuadas
      .filter((p) => p.puntaje > 0 && p.puntaje >= minimo)
      .slice(0, topK)
      .map<FragmentoPolitica>((p) => this.aFragmento(p.politica, p.puntaje, 'coincidencia_lexica'));

    return expandir ? this.cerrarPorExcepciones(seleccionadas) : seleccionadas;
  }

  /**
   * Cierre por excepciones.
   *
   * Si el ranking trajo una regla general, se anaden sus excepciones. Si trajo
   * una excepcion, se anade la regla general que modifica. En ambos sentidos,
   * porque el fallo es simetrico: recuperar POL-2.3 sin POL-7.3 hace rechazar
   * a un solicitante que la excepcion ampara, y recuperar POL-7.3 sin POL-2.3
   * deja al modelo aplicando una excepcion sin conocer la regla que relaja.
   *
   * Las politicas anadidas por cierre van al final y marcadas con su motivo:
   * el agente y la interfaz deben poder distinguir lo que se busco de lo que
   * vino arrastrado.
   */
  private cerrarPorExcepciones(fragmentos: FragmentoPolitica[]): FragmentoPolitica[] {
    const presentes = new Set(fragmentos.map((f) => f.id_politica));
    const anadidos: FragmentoPolitica[] = [];

    const anadir = (id: string, motivo: MotivoInclusion, origen: string) => {
      if (presentes.has(id)) return;
      const politica = this.porId.get(id);
      if (!politica) return;
      presentes.add(id);
      anadidos.push({ ...this.aFragmento(politica, 0, motivo), relacionada_con: origen });
    };

    for (const fragmento of fragmentos) {
      // Regla general -> sus excepciones.
      for (const idExcepcion of this.excepcionesDe.get(fragmento.id_politica) ?? []) {
        anadir(idExcepcion, 'excepcion_de_regla', fragmento.id_politica);
      }
      // Excepcion -> la regla general que modifica.
      for (const idGeneral of fragmento.modifica_a) {
        anadir(idGeneral, 'regla_de_excepcion', fragmento.id_politica);
      }
    }

    return [...fragmentos, ...anadidos];
  }

  private aFragmento(
    politica: Politica,
    puntaje: number,
    motivo: MotivoInclusion,
  ): FragmentoPolitica {
    return {
      id_politica: politica.id,
      seccion: politica.seccion,
      texto_literal: politica.texto,
      categoria: politica.categoria,
      severidad: politica.severidad,
      modifica_a: [...politica.modifica_a],
      puntaje: Number(puntaje.toFixed(4)),
      motivo,
    };
  }
}

/**
 * Agrupa un resultado en reglas generales con sus excepciones colgando.
 *
 * PRECEDENCIA: la excepcion no sustituye a la regla, la relaja bajo condiciones
 * que hay que comprobar. Por eso esta funcion no descarta nada ni decide cual
 * gana: devuelve el par y deja que el agente verifique si las condiciones de la
 * excepcion se cumplen para ESTA solicitud. Resolver la precedencia aqui, sin
 * mirar los datos del solicitante, seria inventarse el resultado.
 */
export interface GrupoPrecedencia {
  general: FragmentoPolitica;
  excepciones: FragmentoPolitica[];
}

export function agruparPorPrecedencia(fragmentos: readonly FragmentoPolitica[]): {
  grupos: GrupoPrecedencia[];
  sueltas: FragmentoPolitica[];
} {
  const porId = new Map(fragmentos.map((f) => [f.id_politica, f]));
  const esExcepcionDe = new Map<string, FragmentoPolitica[]>();

  for (const fragmento of fragmentos) {
    for (const general of fragmento.modifica_a) {
      if (!porId.has(general)) continue;
      const lista = esExcepcionDe.get(general) ?? [];
      lista.push(fragmento);
      esExcepcionDe.set(general, lista);
    }
  }

  const agrupadas = new Set<string>();
  const grupos: GrupoPrecedencia[] = [];

  for (const [idGeneral, excepciones] of esExcepcionDe) {
    const general = porId.get(idGeneral)!;
    grupos.push({ general, excepciones });
    agrupadas.add(idGeneral);
    for (const e of excepciones) agrupadas.add(e.id_politica);
  }

  return {
    grupos: grupos.sort((a, b) => a.general.id_politica.localeCompare(b.general.id_politica)),
    sueltas: fragmentos.filter((f) => !agrupadas.has(f.id_politica)),
  };
}
