import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { corpusSchema, type Corpus, type Politica } from '@aop/shared';

/** data/politicas.json, cinco niveles por encima de este archivo. */
export const RUTA_CORPUS = join(import.meta.dirname, '../../../../../data/politicas.json');

/**
 * Lee y valida el corpus del disco.
 *
 * Si el JSON no cumple el esquema, el proceso falla aqui. Un corpus malformado
 * que se cargue a medias es peor que uno que no cargue: G1 verificaria citas
 * contra un corpus incompleto y las daria por buenas o por inventadas sin que
 * el error tuviera nada que ver con el modelo.
 */
export async function leerCorpus(ruta: string = RUTA_CORPUS): Promise<Corpus> {
  const crudo = await readFile(ruta, 'utf8');
  const resultado = corpusSchema.safeParse(JSON.parse(crudo));

  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`El corpus de politicas no cumple el esquema:\n${problemas}`);
  }

  return resultado.data;
}

/** Indexa el corpus por identificador, que es como lo consulta G1. */
export function indexar(corpus: Corpus): ReadonlyMap<string, Politica> {
  return new Map(corpus.politicas.map((p) => [p.id, p]));
}
