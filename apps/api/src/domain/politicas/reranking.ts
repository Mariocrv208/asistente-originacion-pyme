import type { Politica } from '@aop/shared';
import { tokenizar } from './indice.js';

/**
 * Reordenamiento (punto extra 5.4) sobre los fragmentos que ya recupero BM25.
 *
 * POR QUE UNA SEGUNDA ETAPA Y NO UN MODELO NEURONAL
 *
 * La alternativa obvia para reranking es un cross-encoder o embeddings locales.
 * Se probo (@xenova/transformers) y se descarto: arrastra una dependencia nativa
 * (sharp) que no compila en este entorno sin pasos de instalacion adicionales,
 * y habria que descargar un modelo la primera vez que alguien clone el repo y
 * corra el agente. Es exactamente el mismo argumento que ya esta documentado en
 * indice.ts para no usar embeddings en la recuperacion base: en un dominio
 * regulado, una segunda etapa opaca que ademas puede fallar por una dependencia
 * rota el dia de la defensa vale menos que una determinista y auditable que
 * SIEMPRE se puede explicar fragmento por fragmento.
 *
 * QUE PROBLEMA RESUELVE
 *
 * BM25 solo puede encontrar una politica si la consulta comparte tokens
 * literales con su texto. Esta ya era una limitacion declarada en
 * verificar-recuperacion.ts ("una parafrasis sin vocabulario compartido no
 * recupera la regla"). Esta etapa la ataca con un segundo puntaje,
 * independiente del lexico exacto: clusters de conceptos del dominio,
 * curados a mano igual que LEXICO_CATEGORIAS en recuperacion.ts, pero usados
 * para *reordenar* fragmentos ya recuperados, no para enrutar ni para filtrar.
 *
 * Los clusters son deliberadamente pocos y estan limitados a los casos que
 * este modulo mide y prueba en verificar-reranking.ts. Anadir un cluster sin
 * un caso que lo ejercite seria repetir el error que la bitacora de este
 * proyecto ya registro una vez: afirmar una mejora sin haberla medido.
 */

/**
 * Cada cluster agrupa terminos que un solicitante real usaria para describir
 * una situacion, junto con el vocabulario normativo correspondiente. Que un
 * termino de consulta y un termino de fragmento caigan en el mismo cluster no
 * significa que sean sinonimos: significa que, en este dominio, apuntan al
 * mismo concepto de negocio.
 */
export const CONCEPTOS_SEMANTICOS: Record<string, readonly string[]> = {
  antiguedad_negocio: [
    'meses',
    'operacion',
    'continuos',
    'antiguedad',
    'reciente',
    'recien',
    'constituida',
    'constituido',
    'nueva',
    'nuevo',
    'arranque',
    'iniciando',
    'operando',
  ],
  garantia_respaldo: [
    'garantia',
    'respaldo',
    'respaldar',
    'ofrecer',
    'prenda',
    'prendaria',
    'fiduciaria',
    'hipotecaria',
    'real',
    'aval',
    'avalar',
  ],
  actividad_sector: [
    'sector',
    'actividad',
    'rubro',
    'giro',
    'restringido',
    'restringidos',
    'restringida',
    'prohibido',
    'prohibida',
    'lista',
    'vetado',
    'vetada',
  ],
};

/** Peso del puntaje lexico (BM25 + bonificacion de categoria) en la mezcla final. */
const PESO_BASE = 0.65;
/** Peso del puntaje conceptual. Menor que el lexico a proposito: la coincidencia
 * literal sigue siendo la senal mas fuerte y la unica que despues se verifica
 * contra el corpus para G1; el cluster conceptual solo rescata candidatos que
 * el lexico no puede ver. */
const PESO_CONCEPTUAL = 0.35;

function clustersTocados(tokens: ReadonlySet<string>): Set<string> {
  const tocados = new Set<string>();
  for (const [nombre, terminos] of Object.entries(CONCEPTOS_SEMANTICOS)) {
    if (terminos.some((t) => tokens.has(t))) tocados.add(nombre);
  }
  return tocados;
}

function tokensDePolitica(politica: Politica): Set<string> {
  return new Set(tokenizar(`${politica.seccion} ${politica.categoria} ${politica.texto}`));
}

export interface CandidatoBase {
  politica: Politica;
  puntaje: number;
}

export interface CandidatoReordenado extends CandidatoBase {
  /** Puntaje de entrada (BM25 + bonificacion de categoria), sin tocar. */
  puntajeBase: number;
  /** Cuantos clusters de la consulta comparte el fragmento, normalizado 0..1. */
  puntajeConceptual: number;
}

/**
 * Reordena candidatos ya recuperados por BM25 combinando su puntaje lexico con
 * el puntaje conceptual. Si la consulta no toca ningun cluster conocido, el
 * orden lexico queda intacto: esta etapa nunca inventa relevancia donde no hay
 * ni una senal literal ni una conceptual.
 */
export function rerankear(
  candidatos: readonly CandidatoBase[],
  consulta: string,
): CandidatoReordenado[] {
  const tokensConsulta = new Set(tokenizar(consulta));
  const clustersConsulta = clustersTocados(tokensConsulta);

  if (clustersConsulta.size === 0) {
    return [...candidatos]
      .map((c) => ({ ...c, puntajeBase: c.puntaje, puntajeConceptual: 0 }))
      .sort((a, b) =>
        b.puntaje === a.puntaje ? a.politica.id.localeCompare(b.politica.id) : b.puntaje - a.puntaje,
      );
  }

  const mejorBase = Math.max(0, ...candidatos.map((c) => c.puntaje));

  return candidatos
    .map((c) => {
      const clustersFragmento = clustersTocados(tokensDePolitica(c.politica));
      let coincidencias = 0;
      for (const cluster of clustersConsulta) {
        if (clustersFragmento.has(cluster)) coincidencias += 1;
      }
      const puntajeConceptual = coincidencias / clustersConsulta.size;
      const puntajeBase = c.puntaje;
      const baseNormalizada = mejorBase === 0 ? 0 : puntajeBase / mejorBase;

      return {
        politica: c.politica,
        puntajeBase,
        puntajeConceptual,
        puntaje: baseNormalizada * PESO_BASE + puntajeConceptual * PESO_CONCEPTUAL,
      };
    })
    .sort((a, b) =>
      b.puntaje === a.puntaje ? a.politica.id.localeCompare(b.politica.id) : b.puntaje - a.puntaje,
    );
}
