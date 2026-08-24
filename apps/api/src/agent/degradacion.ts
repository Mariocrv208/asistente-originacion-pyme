import type { Dictamen } from '@aop/shared';
import { obtenerIndicadores } from '../domain/indicadores/repositorio.js';
import type { FragmentoPolitica } from '../domain/politicas/recuperacion.js';

/**
 * Camino explicito de fallo de la salida estructurada (punto 5.3.4).
 *
 * El enunciado es tajante: "Reintentar a ciegas no es una respuesta aceptable,
 * y debe estar documentado por que tu manejo es mejor que eso".
 *
 * POR QUE EL REINTENTO A CIEGAS NO SIRVE
 *
 * Se comprobo en una ejecucion real antes de escribir esto. El modelo produjo
 * un dictamen con la forma equivocada, la validacion lo rechazo, y el ciclo le
 * dejo intentarlo otra vez sin decirle nada nuevo: repitio el mismo error tres
 * veces y agoto las ocho iteraciones sin registrar nada. El reintento a ciegas
 * no converge porque no cambia ninguna de las condiciones que produjeron el
 * fallo; solo gasta tokens y latencia hasta que el tope corta.
 *
 * QUE SE HACE EN SU LUGAR
 *
 * 1. REPARACION DIRIGIDA. El error de validacion vuelve al modelo como
 *    contenido concreto —que campo, que se esperaba, que llego—, no como un
 *    "invalido, reintenta". Eso si cambia las condiciones.
 *
 * 2. PRESUPUESTO ACOTADO. Dos intentos de reparacion. Si un modelo no acierta
 *    la forma con el error delante dos veces seguidas, no va a acertarla a la
 *    tercera; lo que hay es un problema de capacidad, no de suerte.
 *
 * 3. DEGRADACION A ESCALAMIENTO, CONSTRUIDA POR EL SERVIDOR. Agotado el
 *    presupuesto, el dictamen lo arma el codigo, no el modelo: escalamiento a
 *    comite, indicadores del calculo, citas de las politicas que el agente
 *    llego a recuperar, y motivos que dicen exactamente que fallo. Con
 *    confianza baja, porque es una salida degradada y el analista tiene que
 *    saberlo.
 *
 * El resultado es que una solicitud SIEMPRE acaba con un dictamen trazable en
 * la bandeja del analista. Un fallo del modelo se convierte en trabajo humano,
 * que es el comportamiento correcto en un sistema que no sustituye al analista;
 * nunca en un expediente que desaparece.
 */

export interface MotivoDegradacion {
  intentos: number;
  ultimoError: string;
}

export async function construirDictamenDegradado(
  idSolicitud: string,
  politicasVistas: readonly FragmentoPolitica[],
  motivo: MotivoDegradacion,
): Promise<Dictamen | null> {
  const calculo = await obtenerIndicadores(idSolicitud);
  if (!calculo) return null;

  const i = calculo.indicadores;

  // Se citan las politicas que el agente recupero durante la ejecucion. Son
  // texto literal del corpus, asi que pasan G1. Si no llego a recuperar
  // ninguna, no hay nada que citar y la degradacion no es posible: el fallo se
  // reporta tal cual, sin fabricar una cita.
  const citas = politicasVistas.slice(0, 3).map((f) => ({
    id_politica: f.id_politica,
    seccion: f.seccion,
    texto_literal: f.texto_literal,
  }));
  if (citas.length === 0) return null;

  const hallazgos = i.hallazgos.map((h) => h.mensaje);

  return {
    id_solicitud: idSolicitud,
    decision: 'ESCALADO_A_COMITE',
    monto_recomendado: null,
    plazo_recomendado_meses: null,
    indicadores: {
      razon_endeudamiento: i.razon_endeudamiento,
      margen_neto: i.margen_neto,
      cobertura_servicio_deuda: i.cobertura_servicio_deuda,
      relacion_monto_ventas: i.relacion_monto_ventas,
      antiguedad_meses: i.antiguedad_meses,
    },
    politicas_citadas: citas,
    motivos: [
      'ESCALAMIENTO AUTOMATICO POR FALLO DEL ASISTENTE. El modelo no produjo una ' +
        `salida estructurada valida tras ${motivo.intentos} intentos de reparacion dirigida.`,
      `Ultimo error de validacion: ${motivo.ultimoError.slice(0, 400)}`,
      'Los indicadores y las citas de este dictamen los calculo y verifico el sistema, ' +
        'no el modelo. La solicitud requiere analisis humano completo.',
      ...hallazgos,
    ],
    // Conservador por definicion: no se sabe que habria decidido el analisis.
    nivel_riesgo: 'ALTO',
    requiere_autorizacion_humana: true,
    // Baja a proposito. La interfaz debe mostrar que esta salida es degradada.
    confianza: 0.1,
  };
}
