/**
 * Carga del corpus de politicas en la base de datos.
 *
 * Es idempotente: se puede ejecutar tantas veces como haga falta y el
 * resultado es el mismo. Durante el desarrollo el corpus se retoca a menudo, y
 * un cargador que solo sepa insertar obliga a vaciar tablas a mano, con el
 * riesgo de arrastrarse por cascada los dictamenes que ya citaban esas
 * politicas.
 */
import { pool, cerrarPool } from '../../db/pool.js';
import { leerCorpus } from './corpus.js';

interface ResumenCarga {
  version: string;
  categorias: number;
  politicas: number;
  excepciones: number;
  parametrosVinculados: number;
}

export async function cargarCorpus(): Promise<ResumenCarga> {
  const corpus = await leerCorpus();
  const cliente = await pool.connect();

  try {
    // Todo en una transaccion: el trigger diferido que valida modifica_a se
    // comprueba al confirmar, asi que el orden de insercion dentro de la
    // transaccion deja de importar. Una excepcion puede cargarse antes que la
    // regla general que modifica.
    await cliente.query('BEGIN');

    for (const [categoria, descripcion] of Object.entries(corpus.categorias)) {
      await cliente.query(
        `INSERT INTO categorias_politica (categoria, descripcion)
         VALUES ($1, $2)
         ON CONFLICT (categoria) DO UPDATE SET descripcion = EXCLUDED.descripcion`,
        [categoria, descripcion],
      );
    }

    for (const politica of corpus.politicas) {
      await cliente.query(
        `INSERT INTO politicas (id, version_corpus, seccion, categoria, texto, severidad, modifica_a)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           version_corpus = EXCLUDED.version_corpus,
           seccion        = EXCLUDED.seccion,
           categoria      = EXCLUDED.categoria,
           texto          = EXCLUDED.texto,
           severidad      = EXCLUDED.severidad,
           modifica_a     = EXCLUDED.modifica_a`,
        [
          politica.id,
          corpus.version,
          politica.seccion,
          politica.categoria,
          politica.texto,
          politica.severidad,
          politica.modifica_a,
        ],
      );
    }

    // Vincula cada umbral numerico con la politica que lo respalda. Es lo que
    // permite responderle a un auditor de donde sale el 250,000 que aplica G4.
    const vinculos: Array<[string, string]> = [
      ['tope_absoluto_monto', 'POL-4.1'],
      ['porcentaje_ventas_max', 'POL-4.1'],
      ['umbral_autorizacion_comite', 'POL-6.2'],
    ];
    let parametrosVinculados = 0;
    for (const [clave, idPolitica] of vinculos) {
      const { rowCount } = await cliente.query(
        `UPDATE parametros_politica SET id_politica = $2
          WHERE clave = $1 AND EXISTS (SELECT 1 FROM politicas WHERE id = $2)`,
        [clave, idPolitica],
      );
      parametrosVinculados += rowCount ?? 0;
    }

    await cliente.query('COMMIT');

    return {
      version: corpus.version,
      categorias: Object.keys(corpus.categorias).length,
      politicas: corpus.politicas.length,
      excepciones: corpus.politicas.filter((p) => p.modifica_a.length > 0).length,
      parametrosVinculados,
    };
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

if (import.meta.filename === process.argv[1]) {
  try {
    const r = await cargarCorpus();
    console.log(
      `Corpus ${r.version} cargado: ${r.politicas} politicas ` +
        `(${r.excepciones} excepciones) en ${r.categorias} categorias. ` +
        `${r.parametrosVinculados} parametros vinculados a su politica.`,
    );
    await cerrarPool();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    await cerrarPool();
    process.exit(1);
  }
}
