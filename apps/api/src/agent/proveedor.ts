import { env, modelosLlm, validarClaveLlm } from '../config/env.js';

/**
 * Cliente del proveedor de LLM.
 *
 * POR QUE fetch Y NO UN SDK
 *
 * El enunciado permite llamar directamente al SDK del proveedor y pide
 * justificarlo. Aqui se va un paso mas alla: la API de OpenRouter es HTTP con
 * cuerpo JSON, y un SDK encima solo anadiria una capa entre la decision y su
 * explicacion. Lo que se evalua es el control sobre el ciclo del agente, el
 * contrato de las herramientas y el contenido exacto del contexto; con fetch,
 * lo que se envia al modelo es literalmente lo que se lee en el codigo.
 *
 * Ademas, en M12 hace falta cancelacion real propagada hasta el proveedor a
 * mitad de un streaming. Con fetch es un AbortSignal; con un SDK, depende de
 * lo que el SDK exponga.
 */

export interface MensajeSistema {
  role: 'system';
  content: string;
}
export interface MensajeUsuario {
  role: 'user';
  content: string;
}
export interface MensajeAsistente {
  role: 'assistant';
  content: string | null;
  tool_calls?: LlamadaHerramienta[];
}
export interface MensajeHerramienta {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type Mensaje = MensajeSistema | MensajeUsuario | MensajeAsistente | MensajeHerramienta;

export interface LlamadaHerramienta {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface DefinicionHerramienta {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Uso {
  tokensEntrada: number;
  tokensSalida: number;
  costoUsd: number;
}

export interface RespuestaProveedor {
  modelo: string;
  mensaje: MensajeAsistente;
  motivoFin: string;
  uso: Uso;
  latenciaMs: number;
  /** Modelos que se intentaron antes de que uno respondiera. */
  intentados: string[];
}

export interface OpcionesLlamada {
  mensajes: Mensaje[];
  herramientas?: DefinicionHerramienta[];
  /** Esquema JSON para forzar salida estructurada. */
  esquemaRespuesta?: { name: string; strict: boolean; schema: Record<string, unknown> };
  temperatura?: number;
  maxTokens?: number;
  senal?: AbortSignal;
}

export class ErrorProveedor extends Error {
  constructor(
    message: string,
    readonly estado: number | null,
    readonly intentados: string[],
    readonly reintentable: boolean,
  ) {
    super(message);
    this.name = 'ErrorProveedor';
  }
}

/** 429 y 5xx son transitorios; el resto no se reintenta. */
const esReintentable = (estado: number) => estado === 429 || estado >= 500;

/** Espera con retroceso exponencial, respetando la cancelacion. */
function esperar(ms: number, senal?: AbortSignal): Promise<void> {
  return new Promise((resolver, rechazar) => {
    if (senal?.aborted) return rechazar(new Error('cancelado'));
    const t = setTimeout(resolver, ms);
    senal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        rechazar(new Error('cancelado'));
      },
      { once: true },
    );
  });
}

/**
 * Una llamada al proveedor, con cascada de modelos.
 *
 * La cascada no es un lujo: los modelos gratuitos devuelven 429 con frecuencia,
 * y sin reserva una ejecucion entera se cae por una limitacion transitoria de
 * un proveedor upstream. Se registran TODOS los modelos intentados, porque
 * comparar metricas entre ejecuciones que corrieron sobre modelos distintos sin
 * saberlo produce conclusiones falsas.
 */
export async function llamar(opciones: OpcionesLlamada): Promise<RespuestaProveedor> {
  const clave = validarClaveLlm();
  const intentados: string[] = [];
  let ultimoError: ErrorProveedor | null = null;

  for (const modelo of modelosLlm) {
    for (let intento = 0; intento < 3; intento += 1) {
      intentados.push(modelo);
      const inicio = performance.now();

      // Tiempo limite por llamada, combinado con la cancelacion del cliente.
      const porTiempo = AbortSignal.timeout(env.AGENT_TIMEOUT_MS);
      const senal = opciones.senal ? AbortSignal.any([opciones.senal, porTiempo]) : porTiempo;

      try {
        const respuesta = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          signal: senal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${clave}`,
            'HTTP-Referer': env.OPENROUTER_APP_URL,
            'X-Title': env.OPENROUTER_APP_TITLE,
          },
          body: JSON.stringify({
            model: modelo,
            messages: opciones.mensajes,
            ...(opciones.herramientas ? { tools: opciones.herramientas, tool_choice: 'auto' } : {}),
            ...(opciones.esquemaRespuesta
              ? { response_format: { type: 'json_schema', json_schema: opciones.esquemaRespuesta } }
              : {}),
            temperature: opciones.temperatura ?? 0,
            max_tokens: opciones.maxTokens ?? 1500,
            usage: { include: true },
          }),
        });

        const latenciaMs = Math.round(performance.now() - inicio);

        if (!respuesta.ok) {
          const cuerpo = (await respuesta.text()).slice(0, 300);
          const error = new ErrorProveedor(
            `${modelo} respondio ${respuesta.status}: ${cuerpo}`,
            respuesta.status,
            [...intentados],
            esReintentable(respuesta.status),
          );
          ultimoError = error;

          if (!error.reintentable) break; // Modelo inservible: pasa al siguiente.
          if (intento < 2) {
            await esperar(400 * 2 ** intento, opciones.senal);
            continue;
          }
          break; // Agotados los reintentos de este modelo.
        }

        const json = (await respuesta.json()) as {
          choices?: Array<{ message?: MensajeAsistente; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };

        const eleccion = json.choices?.[0];
        if (!eleccion?.message) {
          ultimoError = new ErrorProveedor(
            `${modelo} devolvio una respuesta sin mensaje`,
            null,
            [...intentados],
            true,
          );
          break;
        }

        return {
          modelo,
          mensaje: eleccion.message,
          motivoFin: eleccion.finish_reason ?? 'desconocido',
          latenciaMs,
          intentados: [...intentados],
          uso: {
            tokensEntrada: json.usage?.prompt_tokens ?? 0,
            tokensSalida: json.usage?.completion_tokens ?? 0,
            // Con modelos gratuitos es cero, pero el mecanismo existe: si el
            // catalogo rota y un modelo pasa a pago, el tope de costo del
            // ciclo tiene con que contar.
            costoUsd: json.usage?.cost ?? 0,
          },
        };
      } catch (error) {
        if (opciones.senal?.aborted) {
          throw new ErrorProveedor(
            'Ejecucion cancelada por el cliente',
            null,
            [...intentados],
            false,
          );
        }
        const mensaje = error instanceof Error ? error.message : String(error);
        ultimoError = new ErrorProveedor(`${modelo}: ${mensaje}`, null, [...intentados], true);
        if (intento < 2) {
          await esperar(400 * 2 ** intento, opciones.senal);
          continue;
        }
        break;
      }
    }
  }

  throw ultimoError ?? new ErrorProveedor('Ningun modelo respondio', null, intentados, false);
}
