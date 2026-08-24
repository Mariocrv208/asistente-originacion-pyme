/**
 * Normalizacion de texto para la comparacion literal de citas.
 *
 * Esta funcion es la unica autoridad sobre que significa "el mismo texto" en
 * el guardarrail G1. Existe una normalizacion equivalente en SQL
 * (texto_normalizado, migracion 0001), pero sirve solo a la recuperacion
 * lexica: no participa en G1, precisamente para que no haya dos definiciones
 * de literalidad capaces de discrepar.
 *
 * Que se normaliza y por que:
 *
 *   - Acentos. El corpus entregado en el enunciado esta escrito sin tildes
 *     ("razon", "podra") y las politicas anadidas usan ortografia normal. Un
 *     modelo que cite "razon" con tilde cuando el corpus la omite no esta
 *     inventando nada, y G1 no deberia tratarlo como si lo hiciera.
 *   - Mayusculas.
 *   - Espacios en blanco. El texto viaja por JSON, por el contexto del modelo
 *     y por la base de datos; los saltos de linea y la indentacion cambian por
 *     el camino sin que cambie el contenido.
 *   - Comillas y guiones tipograficos. Los modelos tienden a embellecer el
 *     texto que copian, sustituyendo comillas rectas por curvas y guiones por
 *     rayas. Es reescritura de forma, no de contenido.
 *
 * Que NO se normaliza, deliberadamente: numeros, puntuacion de frase y
 * palabras. Un modelo que cite "0.75" donde el corpus dice "0.65" esta
 * inventando una politica, y ese es exactamente el fallo que G1 debe atrapar.
 */

/** Marcas diacriticas combinantes que NFD separa de su letra base. */
const DIACRITICOS = /[\u0300-\u036f]/g;
/** Comillas simples tipograficas. */
const COMILLAS_SIMPLES = /[\u2018\u2019\u201a\u201b]/g;
/** Comillas dobles tipograficas. */
const COMILLAS_DOBLES = /[\u201c\u201d\u201e\u201f]/g;
/** Guiones y rayas tipograficas. */
const GUIONES = /[\u2010-\u2015]/g;
/** Espacio duro, de cifra, fino y fino sin salto. */
const ESPACIOS_ESPECIALES = /[\u00a0\u2007\u2009\u202f]/g;

/** Normaliza un texto para compararlo con el corpus. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(DIACRITICOS, '')
    .replace(COMILLAS_SIMPLES, "'")
    .replace(COMILLAS_DOBLES, '"')
    .replace(GUIONES, '-')
    .replace(ESPACIOS_ESPECIALES, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Longitud minima de una cita para considerarla verificable.
 *
 * Sin este minimo, citar la palabra "el" pasaria la comprobacion de
 * literalidad: aparece en casi cualquier politica. Una cita tan corta no
 * sustenta ninguna decision, que es lo que G1 exige. El umbral es deliberado y
 * el enunciado pide documentar el criterio de aceptacion de las citas.
 */
export const LONGITUD_MINIMA_CITA = 25;
