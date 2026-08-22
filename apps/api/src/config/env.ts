import { z } from 'zod';

/**
 * Validacion del entorno al arranque.
 *
 * El proceso falla de inmediato si falta algo, en lugar de descubrirlo a mitad
 * de una ejecucion del agente. La clave de OpenRouter es la excepcion
 * deliberada: es opcional hasta el modulo M7, para que toda la parte
 * determinista del sistema se pueda desarrollar y evaluar sin credenciales.
 */
const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

  DATABASE_URL: z.string().url({ message: 'DATABASE_URL debe ser una URL de conexion valida' }),

  // Requerida a partir de M7. Ver validarClaveLlm().
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_MODEL: z.string().default('deepseek/deepseek-chat-v3-0324:free'),
  LLM_FALLBACK_MODELS: z.string().default(''),
  OPENROUTER_APP_TITLE: z.string().default('Asistente de Originacion PyME'),
  OPENROUTER_APP_URL: z.string().url().default('http://localhost:5173'),

  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(8),
  AGENT_MAX_USD_PER_RUN: z.coerce.number().positive().default(0.05),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

function cargar() {
  const resultado = esquema.safeParse(process.env);
  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    console.error(
      `\nNo se pudo arrancar: la configuracion de entorno es invalida.\n${problemas}\n\n` +
        'Copia .env.example a .env en la raiz del repositorio y completa los valores.\n',
    );
    process.exit(1);
  }
  return resultado.data;
}

export const env = cargar();

/** Lista de modelos en orden de preferencia: principal seguido de los de reserva. */
export const modelosLlm: readonly string[] = [
  env.LLM_MODEL,
  ...env.LLM_FALLBACK_MODELS.split(',')
    .map((m) => m.trim())
    .filter(Boolean),
];

/**
 * Se invoca solo desde las rutas que realmente llaman al proveedor (M7 en
 * adelante). Mantiene el arranque posible sin clave.
 */
export function validarClaveLlm(): string {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error(
      'Falta OPENROUTER_API_KEY. Obten una clave en https://openrouter.ai/keys ' +
        'y anadela al archivo .env de la raiz del repositorio.',
    );
  }
  return env.OPENROUTER_API_KEY;
}

export const hayClaveLlm = (): boolean => Boolean(env.OPENROUTER_API_KEY);
