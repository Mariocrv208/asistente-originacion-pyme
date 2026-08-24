import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, cerrarPool } from './pool.js';

const DIRECTORIO = join(import.meta.dirname, 'migrations');

// Un identificador arbitrario pero fijo. Dos procesos que arranquen a la vez
// —la API y el script de evaluacion, por ejemplo— no deben migrar en paralelo.
const CERROJO = 8_274_119;

interface Migracion {
  nombre: string;
  sql: string;
  checksum: string;
}

async function leerMigraciones(): Promise<Migracion[]> {
  const archivos = (await readdir(DIRECTORIO)).filter((n) => n.endsWith('.sql')).sort();

  return Promise.all(
    archivos.map(async (nombre) => {
      const sql = await readFile(join(DIRECTORIO, nombre), 'utf8');
      return {
        nombre,
        sql,
        // Se normalizan los fines de linea: en Windows el checkout puede
        // convertirlos y una migracion ya aplicada parecería haber cambiado.
        checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
      };
    }),
  );
}

async function asegurarRegistro(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      nombre      TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      duracion_ms INTEGER NOT NULL,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function migrar(): Promise<{ aplicadas: string[]; yaEstaban: number }> {
  await asegurarRegistro();

  const cliente = await pool.connect();
  const aplicadas: string[] = [];
  let yaEstaban = 0;

  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [CERROJO]);

    const { rows } = await cliente.query<{ nombre: string; checksum: string }>(
      'SELECT nombre, checksum FROM migraciones_aplicadas',
    );
    const previas = new Map(rows.map((r) => [r.nombre, r.checksum]));

    for (const migracion of await leerMigraciones()) {
      const checksumPrevio = previas.get(migracion.nombre);

      if (checksumPrevio !== undefined) {
        if (checksumPrevio !== migracion.checksum) {
          // Editar una migracion ya aplicada deja la base de datos en un estado
          // que su propio historial no describe. Se corta en seco.
          throw new Error(
            `La migracion ${migracion.nombre} cambio despues de haberse aplicado.\n` +
              'Una migracion aplicada es inmutable: crea una nueva en lugar de editarla.\n' +
              'Si estas en desarrollo y quieres empezar de cero: pnpm db:nuke && pnpm db:up',
          );
        }
        yaEstaban += 1;
        continue;
      }

      const inicio = performance.now();
      // Cada migracion, una transaccion. PostgreSQL soporta DDL transaccional,
      // asi que una migracion que falla a la mitad no deja el esquema roto.
      await cliente.query('BEGIN');
      try {
        await cliente.query(migracion.sql);
        await cliente.query(
          'INSERT INTO migraciones_aplicadas (nombre, checksum, duracion_ms) VALUES ($1, $2, $3)',
          [migracion.nombre, migracion.checksum, Math.round(performance.now() - inicio)],
        );
        await cliente.query('COMMIT');
        aplicadas.push(migracion.nombre);
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new Error(
          `Fallo la migracion ${migracion.nombre}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }

    return { aplicadas, yaEstaban };
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [CERROJO]);
    cliente.release();
  }
}

// Ejecucion directa: pnpm db:migrate
if (import.meta.filename === process.argv[1]) {
  try {
    const { aplicadas, yaEstaban } = await migrar();
    if (aplicadas.length === 0) {
      console.log(`Sin cambios. ${yaEstaban} migraciones ya estaban aplicadas.`);
    } else {
      console.log(`Aplicadas ${aplicadas.length} migraciones:`);
      for (const nombre of aplicadas) console.log(`  + ${nombre}`);
      if (yaEstaban > 0) console.log(`(${yaEstaban} ya estaban aplicadas)`);
    }
    await cerrarPool();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    await cerrarPool();
    process.exit(1);
  }
}
