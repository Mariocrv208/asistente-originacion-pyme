import type { Politica } from '@aop/shared';
import { normalizar } from './normalizar.js';

/**
 * Indice lexico BM25 en memoria sobre el corpus de politicas.
 *
 * POR QUE EN MEMORIA Y NO BUSQUEDA VECTORIAL
 *
 * El corpus tiene 32 politicas. Un recorrido completo sobre 32 documentos
 * cortos se resuelve en microsegundos, con recall perfecto y sin ninguna
 * aproximacion. Montar embeddings y un indice ANN encima de eso seria mas
 * lento —una llamada de red o una inferencia de CPU por consulta—, menos
 * exacto y mucho mas dificil de auditar, a cambio de nada.
 *
 * El enunciado permite explicitamente cargar el corpus completo. La estrategia
 * elegida es intermedia: se carga completo en memoria, se ordena por relevancia
 * y se envia al modelo solo lo pertinente, para no gastar contexto en 32
 * politicas cuando la decision depende de cuatro.
 *
 * Que cambiaria con 500 politicas esta documentado en el README. En resumen:
 * el indice deja de caber comodamente por proceso, la recuperacion pasa a
 * PostgreSQL con busqueda de texto completo y pgvector —el esquema ya tiene la
 * tabla politica_fragmentos y las extensiones instaladas para eso—, y la
 * expansion por excepciones se vuelve todavia mas importante, porque con mas
 * documentos la regla general y su excepcion se separan mas facilmente en el
 * ranking.
 */

/**
 * Palabras vacias del espanol.
 *
 * Se excluyen deliberadamente las negaciones y los cuantificadores que en un
 * corpus normativo cambian el sentido: "no", "sin", "salvo", "mas", "menos".
 * En un buscador generico son ruido; aqui distinguen una regla de su contraria.
 */
const VACIAS = new Set([
  'a',
  'al',
  'ante',
  'con',
  'contra',
  'de',
  'del',
  'desde',
  'e',
  'el',
  'ella',
  'ellos',
  'en',
  'entre',
  'era',
  'es',
  'esa',
  'ese',
  'eso',
  'esta',
  'este',
  'esto',
  'fue',
  'ha',
  'han',
  'hasta',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'me',
  'mi',
  'o',
  'para',
  'pero',
  'por',
  'que',
  'se',
  'ser',
  'si',
  'sobre',
  'son',
  'su',
  'sus',
  'tambien',
  'te',
  'tu',
  'un',
  'una',
  'uno',
  'unos',
  'y',
  'ya',
  'cual',
  'cuales',
  'donde',
  'como',
  'cuando',
]);

/**
 * Tokeniza un texto normalizado.
 *
 * Los numeros se conservan enteros, con sus puntos y comas: "0.65", "250,000"
 * y "1.25" son terminos con significado propio en este corpus y partirlos por
 * el separador decimal los convertiria en ruido.
 */
export function tokenizar(texto: string): string[] {
  return normalizar(texto)
    .split(/[^a-z0-9.,]+/)
    .map((t) => t.replace(/^[.,]+|[.,]+$/g, ''))
    .filter((t) => t.length > 1 && !VACIAS.has(t));
}

interface Documento {
  id: string;
  politica: Politica;
  frecuencias: Map<string, number>;
  longitud: number;
}

const K1 = 1.2;
const B = 0.75;

export interface Puntuacion {
  politica: Politica;
  puntaje: number;
  /** Terminos de la consulta que aparecen en la politica. Sirve para explicar. */
  coincidencias: string[];
}

export class IndiceLexico {
  private readonly documentos: Documento[] = [];
  private readonly documentosPorTermino = new Map<string, number>();
  private longitudMedia = 0;

  constructor(politicas: readonly Politica[]) {
    for (const politica of politicas) {
      // La seccion y la categoria se indexan junto al texto: una consulta por
      // "garantia" debe encontrar las politicas de la seccion de garantias
      // aunque su cuerpo no repita la palabra.
      const tokens = tokenizar(
        `${politica.seccion} ${politica.categoria} ${politica.seccion} ${politica.texto}`,
      );

      const frecuencias = new Map<string, number>();
      for (const token of tokens) {
        frecuencias.set(token, (frecuencias.get(token) ?? 0) + 1);
      }
      for (const termino of frecuencias.keys()) {
        this.documentosPorTermino.set(termino, (this.documentosPorTermino.get(termino) ?? 0) + 1);
      }

      this.documentos.push({
        id: politica.id,
        politica,
        frecuencias,
        longitud: tokens.length,
      });
    }

    const total = this.documentos.reduce((s, d) => s + d.longitud, 0);
    this.longitudMedia = this.documentos.length === 0 ? 0 : total / this.documentos.length;
  }

  get tamano(): number {
    return this.documentos.length;
  }

  /** IDF con suavizado, como en la formulacion habitual de BM25. */
  private idf(termino: string): number {
    const n = this.documentosPorTermino.get(termino) ?? 0;
    const N = this.documentos.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  /**
   * Puntua todas las politicas contra la consulta.
   *
   * Devuelve el corpus entero ordenado, no un top-k. El recorte lo decide la
   * capa de recuperacion, que antes tiene que expandir el resultado con las
   * excepciones relacionadas: recortar aqui dejaria fuera politicas que luego
   * hay que recuperar de todas formas.
   */
  puntuar(consulta: string): Puntuacion[] {
    const terminos = tokenizar(consulta);
    if (terminos.length === 0) {
      return this.documentos.map((d) => ({ politica: d.politica, puntaje: 0, coincidencias: [] }));
    }

    return this.documentos
      .map((doc) => {
        let puntaje = 0;
        const coincidencias: string[] = [];

        for (const termino of terminos) {
          const frecuencia = doc.frecuencias.get(termino);
          if (frecuencia === undefined) continue;
          coincidencias.push(termino);

          const normalizacion =
            frecuencia +
            K1 * (1 - B + (B * doc.longitud) / (this.longitudMedia === 0 ? 1 : this.longitudMedia));
          puntaje += this.idf(termino) * ((frecuencia * (K1 + 1)) / normalizacion);
        }

        return { politica: doc.politica, puntaje, coincidencias };
      })
      .sort((a, b) =>
        // El desempate por identificador mantiene el orden estable: dos
        // ejecuciones con el mismo corpus devuelven exactamente lo mismo, que
        // es condicion para que el banco de evaluacion sea reproducible.
        b.puntaje === a.puntaje
          ? a.politica.id.localeCompare(b.politica.id)
          : b.puntaje - a.puntaje,
      );
  }
}
