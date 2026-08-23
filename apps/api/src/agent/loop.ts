import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { exigirModelosGratuitos } from '../config/modelos.js';
import { obtenerIndicadores } from '../domain/indicadores/repositorio.js';
import { RecuperadorPoliticas } from '../domain/politicas/recuperacion.js';
import { pool } from '../db/pool.js';
import { construirDictamenDegradado } from './degradacion.js';
import { persistirDictamen } from '../domain/dictamenes/persistir.js';
import type { FragmentoPolitica } from '../domain/politicas/recuperacion.js';
import { despachar, definicionesParaProveedor } from './herramientas.js';
import { Bitacora } from './observabilidad.js';
import { ErrorProveedor, llamar, type Mensaje } from './proveedor.js';
import { envolverEntradaNoConfiable, PROMPT_SISTEMA, VERSION_PROMPT } from './prompts/v1.js';

/**
 * Ciclo de ejecucion del agente, escrito a mano.
 *
 * El enunciado excluye la familia LangChain porque quiere ver el control sobre
 * el ciclo, el contrato de las herramientas y el contenido exacto del contexto.
 * Eso es lo que hay aqui: el bucle cabe en una pantalla y no hay ninguna capa
 * que decida nada por su cuenta.
 *
 * CRITERIO DE PARADA (pregunta 4.3)
 *
 * El bucle termina por una de estas cuatro razones, y no hay una quinta:
 *   1. el modelo responde sin pedir herramientas -> terminado;
 *   2. registrar_dictamen confirma la escritura -> terminado, hay resultado;
 *   3. se agota el tope de iteraciones -> TOPE_EXCEDIDO;
 *   4. se agota el tope de costo o de tiempo -> TOPE_EXCEDIDO.
 *
 * Los topes son la garantia de terminacion. Sin ellos, un modelo que insiste en
 * llamar a la misma herramienta gira indefinidamente, y con modelos gratuitos
 * eso ocurre de verdad.
 */

/** Busquedas tras las cuales se reconduce al modelo hacia la decision. */
const LIMITE_BUSQUEDAS = 4;

export type EstadoEjecucion = 'COMPLETADA' | 'FALLIDA' | 'CANCELADA' | 'TOPE_EXCEDIDO';

export interface ResultadoEjecucion {
  idEjecucion: string;
  idSesion: string;
  estado: EstadoEjecucion;
  /** Identificador del dictamen si se llego a registrar. */
  idDictamen: string | null;
  respuestaFinal: string | null;
  iteraciones: number;
  herramientasInvocadas: string[];
  /** Intentos de reparacion dirigida consumidos. */
  reparaciones: number;
  /** true si el dictamen lo construyo el servidor tras agotar las reparaciones. */
  degradado: boolean;
  tokensEntrada: number;
  tokensSalida: number;
  costoUsd: number;
  latenciaMs: number;
  modelo: string;
  modelosIntentados: string[];
  error?: string;
}

export interface OpcionesEjecucion {
  idSolicitud: string;
  idSesion?: string;
  /** Instruccion del analista. Si falta, se usa la peticion por defecto. */
  peticion?: string;
  senal?: AbortSignal;
  /** Se invoca en cada paso, para el streaming de M12. */
  alPaso?: (evento: EventoPaso) => void;
}

export interface EventoPaso {
  tipo: 'herramienta_inicio' | 'herramienta_fin' | 'modelo_turno' | 'fin';
  nombre?: string;
  detalle?: unknown;
}

/**
 * Bloque estable de contexto.
 *
 * Los indicadores son deterministas y precomputables: el punto 5.3.1 dice
 * expresamente que no hay razon para que el agente los descubra llamando
 * herramientas en cada turno. Se inyectan aqui, al principio y siempre en el
 * mismo orden.
 *
 * El orden importa por el cache de prompt (pregunta 4.9): lo estable va
 * primero y lo variable despues, para que el prefijo comun entre ejecuciones
 * sea lo mas largo posible. Si el bloque cambiara de sitio o de forma en cada
 * ejecucion, el cache no acertaria nunca.
 */
async function construirContexto(idSolicitud: string, peticion?: string): Promise<Mensaje[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id_solicitud, nombre_empresa, sector, meses_operacion, monto_solicitado,
            plazo_meses, destino_fondos, ventas_anuales, utilidad_neta, activos_totales,
            pasivos_totales, deuda_vigente_anual, score_historial, garantia_ofrecida,
            fecha_solicitud
       FROM solicitudes WHERE id_solicitud = $1`,
    [idSolicitud],
  );

  const solicitud = rows[0];
  if (!solicitud) throw new Error(`No existe la solicitud ${idSolicitud}`);

  const calculo = await obtenerIndicadores(idSolicitud);
  const indicadores = calculo?.indicadores;

  // El campo no confiable se saca del objeto y se trata aparte. Nunca viaja
  // mezclado con los datos verificados.
  const { destino_fondos, ...datosVerificados } = solicitud as {
    destino_fondos: string;
  } & Record<string, unknown>;

  const bloqueEstable = [
    'DATOS VERIFICADOS DE LA SOLICITUD',
    JSON.stringify(datosVerificados, null, 2),
    '',
    'INDICADORES CALCULADOS POR EL SISTEMA (decimal exacto, no recalcular)',
    JSON.stringify(
      indicadores === undefined
        ? { error: 'no se pudieron calcular' }
        : {
            razon_endeudamiento: indicadores.razon_endeudamiento,
            margen_neto: indicadores.margen_neto,
            cobertura_servicio_deuda: indicadores.cobertura_servicio_deuda,
            relacion_monto_ventas: indicadores.relacion_monto_ventas,
            antiguedad_meses: indicadores.antiguedad_meses,
            cuota_mensual_estimada: indicadores.cuota_mensual_estimada,
            tasa_anual_aplicada: indicadores.tasa_anual_aplicada,
            hallazgos: indicadores.hallazgos,
          },
      null,
      2,
    ),
  ].join('\n');

  return [
    { role: 'system', content: PROMPT_SISTEMA },
    { role: 'user', content: bloqueEstable },
    { role: 'user', content: envolverEntradaNoConfiable(destino_fondos) },
    {
      role: 'user',
      content:
        peticion ??
        'Analiza esta solicitud contra las politicas vigentes y registra el dictamen correspondiente.',
    },
  ];
}

export async function ejecutarAgente(opciones: OpcionesEjecucion): Promise<ResultadoEjecucion> {
  // Comprueba que los modelos configurados siguen siendo gratuitos y admiten
  // herramientas. Falla antes de gastar nada si el catalogo roto.
  await exigirModelosGratuitos();

  const idSesion = opciones.idSesion ?? randomUUID();
  const recuperador = await RecuperadorPoliticas.cargar();
  const bitacora = await Bitacora.iniciar({
    idSesion,
    idSolicitud: opciones.idSolicitud,
    versionPrompt: VERSION_PROMPT,
    modelo: env.LLM_MODEL,
  });

  const mensajes = await construirContexto(opciones.idSolicitud, opciones.peticion);
  const herramientas = definicionesParaProveedor();
  const contextoHerramientas = { idEjecucion: bitacora.idEjecucion, recuperador };

  const invocadas: string[] = [];
  const inicio = performance.now();

  let iteraciones = 0;
  let tokensEntrada = 0;
  let tokensSalida = 0;
  let costoUsd = 0;
  let modelo = env.LLM_MODEL;
  let intentados: string[] = [];
  let idDictamen: string | null = null;
  let reparaciones = 0;
  let ultimoErrorRegistro = '';
  const politicasVistas: FragmentoPolitica[] = [];
  let degradado = false;
  let busquedas = 0;
  let avisoBusquedas = false;
  let respuestaFinal: string | null = null;
  let estado: EstadoEjecucion = 'COMPLETADA';
  let mensajeError: string | undefined;

  /**
   * Construye y persiste el dictamen degradado. Devuelve true si lo consiguio.
   *
   * Es el camino de fallo comun a las dos formas de fracasar: agotar las
   * reparaciones dirigidas y agotar las iteraciones.
   */
  const degradar = async (motivo: string): Promise<boolean> => {
    const propuesta = await construirDictamenDegradado(opciones.idSolicitud, politicasVistas, {
      intentos: reparaciones,
      ultimoError: ultimoErrorRegistro || motivo,
    });
    if (!propuesta) return false;

    const persistido = await persistirDictamen(propuesta, bitacora.idEjecucion);
    await bitacora.registrar({
      tipo: 'REPARACION',
      nombre: 'degradacion_a_escalamiento',
      argumentos: { motivo },
      resultado: persistido.ok ? persistido.confirmacion : undefined,
      ...(persistido.ok ? {} : { error: persistido.error }),
    });

    if (!persistido.ok) return false;

    idDictamen = persistido.confirmacion.id_dictamen;
    degradado = true;
    estado = 'COMPLETADA';
    respuestaFinal =
      'El asistente no logro producir un dictamen valido por si mismo. La solicitud se escalo ' +
      'automaticamente a comite, con los indicadores calculados por el sistema y las politicas ' +
      'que si llego a recuperar.';
    return true;
  };

  const cerrar = async () => {
    await bitacora.cerrar({
      estado,
      iteraciones,
      tokensEntrada,
      tokensSalida,
      costoUsd,
      latenciaMs: Math.round(performance.now() - inicio),
      modelo,
      modelosIntentados: [...new Set(intentados)],
      ...(mensajeError ? { error: mensajeError } : {}),
    });

    opciones.alPaso?.({ tipo: 'fin', detalle: { estado, idDictamen } });

    return {
      idEjecucion: bitacora.idEjecucion,
      idSesion,
      estado,
      idDictamen,
      respuestaFinal,
      iteraciones,
      herramientasInvocadas: invocadas,
      reparaciones,
      degradado,
      tokensEntrada,
      tokensSalida,
      costoUsd,
      latenciaMs: Math.round(performance.now() - inicio),
      modelo,
      modelosIntentados: [...new Set(intentados)],
      ...(mensajeError ? { error: mensajeError } : {}),
    } satisfies ResultadoEjecucion;
  };

  try {
    while (iteraciones < env.AGENT_MAX_ITERATIONS) {
      if (opciones.senal?.aborted) {
        estado = 'CANCELADA';
        return await cerrar();
      }

      // Tope de costo. Con modelos gratuitos siempre vale cero, pero el corte
      // existe: si el catalogo rota y un modelo pasa a pago, una ejecucion que
      // se atasca no puede vaciar la cuenta.
      if (costoUsd >= env.AGENT_MAX_USD_PER_RUN) {
        estado = 'TOPE_EXCEDIDO';
        mensajeError = `Se alcanzo el tope de costo (${env.AGENT_MAX_USD_PER_RUN} USD).`;
        return await cerrar();
      }

      iteraciones += 1;

      const respuesta = await llamar({
        mensajes,
        herramientas,
        ...(opciones.senal ? { senal: opciones.senal } : {}),
      });

      modelo = respuesta.modelo;
      intentados = [...intentados, ...respuesta.intentados];
      tokensEntrada += respuesta.uso.tokensEntrada;
      tokensSalida += respuesta.uso.tokensSalida;
      costoUsd += respuesta.uso.costoUsd;

      await bitacora.registrar({
        tipo: 'LLM',
        nombre: respuesta.modelo,
        resultado: {
          motivoFin: respuesta.motivoFin,
          herramientas: respuesta.mensaje.tool_calls?.map((t) => t.function.name) ?? [],
        },
        tokensEntrada: respuesta.uso.tokensEntrada,
        tokensSalida: respuesta.uso.tokensSalida,
        latenciaMs: respuesta.latenciaMs,
      });

      opciones.alPaso?.({ tipo: 'modelo_turno', nombre: respuesta.modelo });

      mensajes.push(respuesta.mensaje);
      const llamadas = respuesta.mensaje.tool_calls ?? [];

      // Control de deriva. En una ejecucion real el modelo encadeno seis
      // busquedas seguidas y agoto las iteraciones sin decidir nada. El tope
      // las habria cortado igual, pero cortar no es lo mismo que reconducir:
      // aqui se le dice UNA sola vez que ya tiene material suficiente, que es
      // informacion nueva y no una repeticion de la orden inicial.
      if (busquedas >= LIMITE_BUSQUEDAS && !avisoBusquedas && !idDictamen) {
        avisoBusquedas = true;
        mensajes.push({
          role: 'user',
          content:
            'Ya has consultado el corpus ' +
            busquedas +
            ' veces y tienes ' +
            politicasVistas.length +
            ' politicas recuperadas. Deja de buscar y registra el dictamen ahora con ' +
            'registrar_dictamen, apoyandote en lo que ya tienes. Si nada de lo recuperado ' +
            'cubre el caso, registra ESCALADO_A_COMITE citando la politica mas cercana y ' +
            'explicando en los motivos que no hay politica aplicable.',
        });
      }

      // Criterio de parada 1: el modelo dejo de pedir herramientas.
      if (llamadas.length === 0) {
        respuestaFinal = respuesta.mensaje.content ?? null;
        return await cerrar();
      }

      for (const llamada of llamadas) {
        const nombre = llamada.function.name;
        invocadas.push(nombre);
        opciones.alPaso?.({ tipo: 'herramienta_inicio', nombre });

        const t0 = performance.now();
        const resultado = await despachar(nombre, llamada.function.arguments, contextoHerramientas);
        const latenciaMs = Math.round(performance.now() - t0);

        await bitacora.registrar({
          tipo: 'HERRAMIENTA',
          nombre,
          argumentos: llamada.function.arguments,
          resultado: resultado.ok ? resultado.datos : undefined,
          ...(resultado.ok ? {} : { error: resultado.error }),
          latenciaMs,
        });

        opciones.alPaso?.({ tipo: 'herramienta_fin', nombre, detalle: resultado });

        // El resultado vuelve al modelo como mensaje de herramienta, tanto si
        // fue bien como si no. Un error es informacion, no una interrupcion.
        mensajes.push({
          role: 'tool',
          tool_call_id: llamada.id,
          content: JSON.stringify(resultado.ok ? resultado.datos : { error: resultado.error }),
        });

        // Se guardan las politicas recuperadas: si hay que degradar, son las
        // unicas citas legitimas disponibles, porque son texto literal del
        // corpus y por tanto pasan G1.
        if (nombre === 'buscar_politica') busquedas += 1;

        if (nombre === 'buscar_politica' && resultado.ok) {
          const datos = resultado.datos as { fragmentos?: FragmentoPolitica[] };
          for (const f of datos.fragmentos ?? []) {
            if (!politicasVistas.some((p) => p.id_politica === f.id_politica)) {
              politicasVistas.push(f);
            }
          }
        }

        if (nombre === 'registrar_dictamen') {
          if (resultado.ok) {
            // Criterio de parada 2: el dictamen quedo registrado.
            const datos = resultado.datos as { id_dictamen?: string };
            idDictamen = datos.id_dictamen ?? null;
          } else {
            // Reparacion dirigida: el error concreto ya viajo al modelo en el
            // mensaje de herramienta de arriba. Aqui solo se contabiliza.
            reparaciones += 1;
            ultimoErrorRegistro = resultado.error;
            await bitacora.registrar({
              tipo: 'REPARACION',
              nombre: `intento ${reparaciones} de ${env.AGENT_MAX_REPARACIONES}`,
              error: resultado.error,
            });

            if (reparaciones > env.AGENT_MAX_REPARACIONES) {
              if (await degradar('Presupuesto de reparaciones agotado.')) return await cerrar();

              estado = 'FALLIDA';
              mensajeError =
                'El modelo no produjo una salida valida tras ' +
                reparaciones +
                ' reparaciones y no habia politicas recuperadas con las que degradar.';
              return await cerrar();
            }
          }
        }
      }
    }

    // Criterio de parada 3: se agotaron las iteraciones.
    //
    // Agotarlas sin dictamen no es una situacion distinta de agotar las
    // reparaciones: en las dos, el analista se queda sin nada en la bandeja.
    // Se degrada igual, para que la promesa "toda solicitud acaba con un
    // dictamen trazable" se cumpla siempre y no solo en una de las dos formas
    // de fallar. Este hueco aparecio en una ejecucion real.
    if (!idDictamen) {
      const aplicada = await degradar(
        'Se agotaron las ' +
          env.AGENT_MAX_ITERATIONS +
          ' iteraciones sin registrar dictamen. Herramientas invocadas: ' +
          invocadas.join(', ') +
          '.',
      );
      if (aplicada) return await cerrar();

      estado = 'TOPE_EXCEDIDO';
      mensajeError =
        'Se agotaron las ' +
        env.AGENT_MAX_ITERATIONS +
        ' iteraciones sin registrar dictamen y no habia politicas recuperadas con las que degradar.';
      return await cerrar();
    }

    estado = 'COMPLETADA';
    return await cerrar();
  } catch (error) {
    if (error instanceof ErrorProveedor && opciones.senal?.aborted) {
      estado = 'CANCELADA';
    } else {
      estado = 'FALLIDA';
      mensajeError = error instanceof Error ? error.message : String(error);
    }
    return await cerrar();
  }
}
