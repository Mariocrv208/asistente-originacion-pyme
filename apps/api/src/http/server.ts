import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { saludSchema, type Salud } from '@aop/shared';
import { env, hayClaveLlm, modelosLlm } from '../config/env.js';
import { verificarModelos } from '../config/modelos.js';
import { comprobarBaseDatos, extensionesInstaladas } from '../db/pool.js';
import { rutasAnalizar } from './rutas/analizar.js';
import { rutasDictamenes } from './rutas/dictamenes.js';
import { rutasLectura } from './rutas/lectura.js';

const VERSION = '0.1.0';
const arrancadoEn = Date.now();

/**
 * Estado del proveedor de LLM, incluida la comprobacion de gratuidad.
 *
 * Si el catalogo no responde, se informa en vez de tumbar el diagnostico: la
 * salud de la API no depende de que OpenRouter este disponible.
 */
async function diagnosticoLlm() {
  if (!hayClaveLlm()) {
    return {
      configurado: false,
      modelos: modelosLlm,
      nota: 'Sin OPENROUTER_API_KEY. Se necesita a partir del modulo M7.',
    };
  }

  try {
    const veredictos = await verificarModelos();
    const dePago = veredictos.filter((v) => v.existe && !v.gratuito).map((v) => v.id);
    const inexistentes = veredictos.filter((v) => !v.existe).map((v) => v.id);

    return {
      configurado: true,
      modelos: veredictos,
      nota:
        dePago.length > 0
          ? `ATENCION: ${dePago.join(', ')} NO son gratuitos y consumirian saldo.`
          : inexistentes.length > 0
            ? `${inexistentes.join(', ')} ya no existen en el catalogo. Ejecuta pnpm llm:modelos.`
            : 'Todos los modelos configurados son gratuitos y admiten herramientas.',
    };
  } catch (error) {
    return {
      configurado: true,
      modelos: modelosLlm,
      nota: `No se pudo verificar el catalogo: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

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
      llm: await diagnosticoLlm(),
      topesAgente: {
        maxIteraciones: env.AGENT_MAX_ITERATIONS,
        maxUsdPorEjecucion: env.AGENT_MAX_USD_PER_RUN,
        tiempoLimiteMs: env.AGENT_TIMEOUT_MS,
      },
    };
  });

  // Los errores de validacion de Zod son culpa del cliente, no del servidor.
  // Sin esto Fastify los devolveria como 500 y el frontend no podria
  // distinguir "mandaste mal los parametros" de "el servidor se rompio".
  app.setErrorHandler((error, _peticion, respuesta) => {
    const zod = error as {
      name?: string;
      issues?: Array<{ path: (string | number)[]; message: string }>;
    };
    if (zod.name === 'ZodError' && Array.isArray(zod.issues)) {
      return respuesta.code(400).send({
        error: 'Parametros invalidos',
        detalles: zod.issues!.map((i) => ({
          campo: i.path.join('.') || '(raiz)',
          mensaje: i.message,
        })),
      });
    }
    app.log.error({ error }, 'error no controlado');
    const e = error as { statusCode?: number; message?: string };
    return respuesta
      .code(e.statusCode ?? 500)
      .send({ error: e.message ?? 'Error interno del servidor' });
  });

  await app.register(rutasLectura);
  await app.register(rutasDictamenes);
  await app.register(rutasAnalizar);

  return app;
}
