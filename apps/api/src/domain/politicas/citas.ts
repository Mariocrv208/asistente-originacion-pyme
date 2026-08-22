import type { CitaPolitica, Politica } from '@aop/shared';
import { LONGITUD_MINIMA_CITA, normalizar } from './normalizar.js';

/**
 * Verificacion de literalidad de citas. Es el nucleo del guardarrail G1, que
 * se cablea al flujo del agente en M10.
 *
 * El enunciado exige que "el texto_literal de cada cita debe existir realmente
 * en el corpus de politicas, y se valida en codigo". Aqui se decide que
 * significa "existir realmente".
 */

export type MotivoRechazo =
  'politica_inexistente' | 'cita_demasiado_corta' | 'texto_no_literal' | 'seccion_no_coincide';

export interface VeredictoCita {
  verificada: boolean;
  cita: CitaPolitica;
  motivo?: MotivoRechazo;
  detalle?: string;
}

export interface VeredictoCitas {
  todasVerificadas: boolean;
  veredictos: VeredictoCita[];
}

/**
 * Verifica una cita contra el corpus.
 *
 * Se comprueba contra la politica que la cita DECLARA, no contra el corpus
 * entero. La diferencia importa: un texto puede ser literal de POL-2.3 y estar
 * atribuido a POL-4.1, y esa cita sustenta una decision con la politica
 * equivocada. Buscar en todo el corpus dejaria pasar ese error.
 */
export function verificarCita(
  cita: CitaPolitica,
  corpus: ReadonlyMap<string, Politica>,
): VeredictoCita {
  const politica = corpus.get(cita.id_politica);
  if (!politica) {
    return {
      verificada: false,
      cita,
      motivo: 'politica_inexistente',
      detalle: `El corpus no contiene ninguna politica con identificador ${cita.id_politica}`,
    };
  }

  const textoCita = normalizar(cita.texto_literal);

  if (textoCita.length < LONGITUD_MINIMA_CITA) {
    return {
      verificada: false,
      cita,
      motivo: 'cita_demasiado_corta',
      detalle:
        `La cita normalizada tiene ${textoCita.length} caracteres y el minimo ` +
        `es ${LONGITUD_MINIMA_CITA}. Un fragmento tan corto no sustenta una decision.`,
    };
  }

  // Se admite citar un fragmento contiguo, no solo la politica entera: un
  // dictamen suele apoyarse en la clausula concreta, no en el parrafo completo.
  if (!normalizar(politica.texto).includes(textoCita)) {
    return {
      verificada: false,
      cita,
      motivo: 'texto_no_literal',
      detalle: `El texto citado no aparece en ${politica.id}. Es una cita inventada o alterada.`,
    };
  }

  if (normalizar(politica.seccion) !== normalizar(cita.seccion)) {
    return {
      verificada: false,
      cita,
      motivo: 'seccion_no_coincide',
      detalle: `La cita declara la seccion "${cita.seccion}" pero ${politica.id} pertenece a "${politica.seccion}"`,
    };
  }

  return { verificada: true, cita };
}

/** Verifica todas las citas de un dictamen. */
export function verificarCitas(
  citas: readonly CitaPolitica[],
  corpus: ReadonlyMap<string, Politica>,
): VeredictoCitas {
  // Sin ninguna cita no hay nada que verificar, y eso ya es un fallo de G1:
  // el enunciado exige al menos un elemento en politicas_citadas.
  const veredictos = citas.map((cita) => verificarCita(cita, corpus));
  return {
    todasVerificadas: citas.length > 0 && veredictos.every((v) => v.verificada),
    veredictos,
  };
}
