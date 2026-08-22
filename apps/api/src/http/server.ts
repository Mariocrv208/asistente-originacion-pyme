import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { saludSchema, type Salud } from '@aop/shared';
import { env, hayClaveLlm, modelosLlm } from '../config/env.js';
import { comprobarBaseDatos, extensionesInstaladas } from '../db/pool.js';

const VERSION = '0.1.0';
const arrancadoEn = Date.now();

export async function construirServidor(): Promise<FastifyInstance> {
  // La propiedad se omite en lugar de ponerla en undefined: con
  // exactOptionalPropertyTypes activo, un transport indefinido no encaja en
  // ninguna sobrecarga de Fastify y TypeScript acaba resolviendo la de HTTP/2.
  const logger = {
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };

  const app = Fastify({
    logger,
    // El frontend construye el dictamen progresivamente y la traza de una
    // ejecucion puede ser larga; 1 MB es holgado y sigue acotando el abuso.
    bodyLimit: 1_048_576,
  });

  await app.register(sensible);
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });

  app.get('/api/salud', async (): Promise<Salud> => {
    const bd = await comprobarBaseDatos();
    const respuesta: Salud = {
      estado: bd.ok ? 'ok' : 'degradado',
      version: VERSION,
      entorno: env.NODE_ENV,
      tiempoActivoSegundos: Math.round((Date.now() - arrancadoEn) / 1000),
      dependencias: {
        baseDatos: {
          estado: bd.ok ? 'ok' : 'error',
          latenciaMs: bd.latenciaMs,
          ...(bd.detalle ? { detalle: bd.detalle } : {}),
        },
      },
    };
    // Se valida la salida contra el mismo esquema que consume el frontend: si
    // el contrato se rompe, se rompe aqui y no en el navegador.
    return saludSchema.parse(respuesta);
  });

  /**
   * Diagnostico del andamiaje (modulo M1). Confirma que el contenedor se
   * inicializo con las extensiones que necesitan M6 y G1, y si el proveedor de
   * LLM esta configurado. Desaparecera cuando M11 traiga la observabilidad real.
   */
  app.get('/api/diagnostico', async () => {
    const bd = await comprobarBaseDatos();
    return {
      baseDatos: bd,
      extensiones: bd.ok ? await extensionesInstaladas() : [],
      llm: {
        configurado: hayClaveLlm(),
        modelos: modelosLlm,
        nota: hayClaveLlm()
          ? 'Clave presente.'
          : 'Sin OPENROUTER_API_KEY. Se necesita a partir del modulo M7.',
      },
      topesAgente: {
        maxIteraciones: env.AGENT_MAX_ITERATIONS,
        maxUsdPorEjecucion: env.AGENT_MAX_USD_PER_RUN,
        tiempoLimiteMs: env.AGENT_TIMEOUT_MS,
      },
    };
  });

  return app;
}
