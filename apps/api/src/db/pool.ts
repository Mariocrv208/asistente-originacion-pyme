import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Pool de conexiones compartido.
 *
 * Nota que importa para la pregunta 2.6 del cuestionario: por defecto el driver
 * devuelve NUMERIC como string de JavaScript. Eso es exactamente lo que
 * queremos. Si lo convirtieramos a number, todo monto pasaria por punto
 * flotante binario antes de llegar a decimal.js y el error ya estaria hecho.
 * El OID 1700 es NUMERIC; se deja el parser en identidad de forma explicita
 * para que la decision quede escrita y no dependa de un comportamiento por
 * defecto que alguien pueda cambiar sin darse cuenta.
 */
pg.types.setTypeParser(1700, (valor: string) => valor);

// INT8 (bigint) tambien llega como string por defecto. Los conteos de la vista
// de metricas caben de sobra en un number seguro, asi que ahi si conviene.
pg.types.setTypeParser(20, (valor: string) => Number(valor));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'aop-api',
});

pool.on('error', (error) => {
  // Un cliente inactivo del pool fallo. No debe tumbar el proceso.
  console.error('[db] error en cliente inactivo del pool:', error.message);
});

/** Comprueba la conexion y devuelve la latencia observada. */
export async function comprobarBaseDatos(): Promise<{
  ok: boolean;
  latenciaMs: number;
  detalle?: string;
}> {
  const inicio = performance.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latenciaMs: Math.round(performance.now() - inicio) };
  } catch (error) {
    return {
      ok: false,
      latenciaMs: Math.round(performance.now() - inicio),
      detalle: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Devuelve las extensiones instaladas, para verificar la inicializacion del contenedor. */
export async function extensionesInstaladas(): Promise<string[]> {
  const { rows } = await pool.query<{ extname: string }>(
    'SELECT extname FROM pg_extension ORDER BY extname',
  );
  return rows.map((r) => r.extname);
}

export async function cerrarPool(): Promise<void> {
  await pool.end();
}
