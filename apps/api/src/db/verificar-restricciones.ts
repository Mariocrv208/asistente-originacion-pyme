/**
 * Verificacion del criterio de cierre de M2.
 *
 * El enunciado exige que G3 exista "a nivel de base de datos, no solo
 * validacion en aplicacion". La unica forma honesta de demostrarlo es intentar
 * escrituras invalidas por SQL directo, saltandose por completo la capa de
 * aplicacion, y comprobar que PostgreSQL las rechaza.
 *
 * Todo corre dentro de una transaccion que termina en ROLLBACK: la
 * verificacion no deja rastro en la base de datos.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, cerrarPool } from './pool.js';

interface Resultado {
  nombre: string;
  ok: boolean;
  detalle: string;
}

const resultados: Resultado[] = [];
let contador = 0;

/** La sentencia debe fallar. Si pasa, el guardarrail no existe de verdad. */
async function debeFallar(
  cliente: PoolClient,
  nombre: string,
  ejecutar: () => Promise<unknown>,
  restriccionEsperada?: string,
): Promise<void> {
  const punto = `p${(contador += 1)}`;
  await cliente.query(`SAVEPOINT ${punto}`);
  try {
    await ejecutar();
    await cliente.query(`ROLLBACK TO SAVEPOINT ${punto}`);
    resultados.push({ nombre, ok: false, detalle: 'la escritura PASO y deberia haber fallado' });
  } catch (error) {
    await cliente.query(`ROLLBACK TO SAVEPOINT ${punto}`);
    const err = error as { constraint?: string; message?: string };
    const motivo = err.constraint ?? (err.message ?? '').split('\n')[0] ?? 'sin detalle';
    const ok = restriccionEsperada ? motivo.includes(restriccionEsperada) : true;
    resultados.push({
      nombre,
      ok,
      detalle: ok
        ? `rechazada por ${motivo}`
        : `rechazada por ${motivo}, se esperaba ${restriccionEsperada}`,
    });
  }
}

/** La sentencia debe pasar. Un guardarrail que bloquea lo legitimo tampoco sirve. */
async function debePasar(cliente: PoolClient, nombre: string, ejecutar: () => Promise<unknown>) {
  const punto = `p${(contador += 1)}`;
  await cliente.query(`SAVEPOINT ${punto}`);
  try {
    await ejecutar();
    await cliente.query(`RELEASE SAVEPOINT ${punto}`);
    resultados.push({ nombre, ok: true, detalle: 'aceptada' });
  } catch (error) {
    await cliente.query(`ROLLBACK TO SAVEPOINT ${punto}`);
    resultados.push({
      nombre,
      ok: false,
      detalle: `rechazada y deberia haber pasado: ${(error as Error).message.split('\n')[0]}`,
    });
  }
}

const SOLICITUD = `
  INSERT INTO solicitudes (nombre_empresa, sector, meses_operacion, monto_solicitado,
    plazo_meses, destino_fondos, ventas_anuales, utilidad_neta, activos_totales,
    pasivos_totales, deuda_vigente_anual, score_historial, garantia_ofrecida, fecha_solicitud)
  VALUES ($1,'comercio',36,$2,24,'capital de trabajo',$3,120000,800000,$4,50000,75,'fiduciaria',CURRENT_DATE)
  RETURNING id_solicitud`;

function dictamen(campos: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    // En produccion la genera el servidor a partir de la solicitud y la
    // ejecucion; aqui basta con que sea unica por insercion, para que sea el
    // guardarrail bajo prueba —y no la clave— quien rechace la escritura.
    clave_idempotencia: `verificacion-${randomUUID()}`,
    decision: 'APROBADO',
    monto_recomendado: null,
    plazo_recomendado_meses: 24,
    monto_solicitado_snapshot: 0, // lo sobrescribe el trigger de G3
    tope_politica: 0, //             idem
    ind_antiguedad_meses: 36,
    motivos: ['verificacion automatizada'],
    nivel_riesgo: 'BAJO',
    requiere_autorizacion_humana: false,
    confianza: 0.9,
    ...campos,
  };
  const claves = Object.keys(base);
  const marcadores = claves.map((_, i) => `$${i + 1}`).join(', ');
  return {
    sql: `INSERT INTO dictamenes (${claves.join(', ')}) VALUES (${marcadores}) RETURNING id`,
    valores: claves.map((k) => base[k]),
  };
}

async function main() {
  const c = await pool.connect();
  await c.query('BEGIN');

  try {
    // Politica de apoyo para poder citar (la clave foranea la exige).
    await c.query(
      `INSERT INTO politicas (id, version_corpus, seccion, categoria, texto, severidad)
       VALUES ('POL-99.9','verificacion','99.9 Verificacion','capacidad_pago',
               'Politica temporal usada por la verificacion de restricciones.','informativa')`,
    );

    // A: solicita 200 000 con ventas de 1 000 000 -> tope de politica = 300 000
    const a = (await c.query(SOLICITUD, ['Verificacion A', 200000, 1000000, 300000])).rows[0]
      .id_solicitud;
    // B: solicita 400 000 con ventas de   500 000 -> tope de politica = 150 000
    const b = (await c.query(SOLICITUD, ['Verificacion B', 400000, 500000, 300000])).rows[0]
      .id_solicitud;
    // C: sin ventas declaradas                    -> tope de politica = 0
    const cId = (await c.query(SOLICITUD, ['Verificacion C', 200000, null, 300000])).rows[0]
      .id_solicitud;
    // D: solicita 400 000 con ventas de 2 000 000 -> tope de politica = 500 000
    const d = (await c.query(SOLICITUD, ['Verificacion D', 400000, 2000000, 300000])).rows[0]
      .id_solicitud;

    const insertar = (campos: Record<string, unknown>) => {
      const { sql, valores } = dictamen(campos);
      return c.query(sql, valores);
    };

    const textoCita = 'Politica temporal usada por la verificacion de restricciones.';
    const conCita = async (campos: Record<string, unknown>) => {
      const { rows } = await insertar(campos);
      await c.query(
        `INSERT INTO dictamen_citas (id_dictamen, id_politica, seccion, texto_literal, orden)
         VALUES ($1,'POL-99.9','99.9 Verificacion',$2,0)`,
        [rows[0].id, textoCita],
      );
      return rows[0].id as string;
    };

    // ---- G3 ---------------------------------------------------------------
    await debeFallar(
      c,
      'G3 - monto recomendado superior al solicitado',
      () => conCita({ id_solicitud: a, monto_recomendado: 250000 }),
      'g3_no_supera_solicitado',
    );

    await debeFallar(
      c,
      'G3 - monto recomendado superior al tope de politica',
      () => conCita({ id_solicitud: b, monto_recomendado: 200000 }),
      'g3_no_supera_tope_politica',
    );

    await debeFallar(
      c,
      'G3 - sin ventas declaradas no hay monto aprobable',
      () => conCita({ id_solicitud: cId, monto_recomendado: 1000 }),
      'g3_no_supera_tope_politica',
    );

    await debeFallar(
      c,
      'G3 - tope inflado por la aplicacion no surte efecto',
      () => conCita({ id_solicitud: a, monto_recomendado: 250000, tope_politica: 99999999 }),
      'g3_no_supera_solicitado',
    );

    await debePasar(c, 'G3 - monto dentro del solicitado y del tope', () =>
      conCita({ id_solicitud: a, monto_recomendado: 150000 }),
    );

    // ---- Coherencia de la decision ----------------------------------------
    await debeFallar(
      c,
      'Coherencia - un rechazo no recomienda monto',
      () => conCita({ id_solicitud: a, decision: 'RECHAZADO', monto_recomendado: 100000 }),
      'rechazo_sin_monto',
    );

    await debeFallar(
      c,
      'Coherencia - un aprobado sin monto',
      () => conCita({ id_solicitud: a, decision: 'APROBADO', monto_recomendado: null }),
      'aprobado_con_monto',
    );

    // ---- G4 ---------------------------------------------------------------
    await debeFallar(
      c,
      'G4 - marca de autorizacion incoherente con el monto',
      () =>
        conCita({
          id_solicitud: d,
          monto_recomendado: 300000, // supera 250 000: exige autorizacion
          requiere_autorizacion_humana: false,
        }),
      'g4_marca_coherente',
    );

    await debeFallar(
      c,
      'G4 - riesgo ALTO sin marca de autorizacion',
      () =>
        conCita({
          id_solicitud: a,
          monto_recomendado: 150000,
          nivel_riesgo: 'ALTO',
          requiere_autorizacion_humana: false,
        }),
      'g4_marca_coherente',
    );

    await debeFallar(
      c,
      'G4 - nace EN_FIRME sin confirmacion del analista',
      () => conCita({ id_solicitud: a, monto_recomendado: 150000, estado: 'EN_FIRME' }),
      'g4_en_firme_exige_confirmacion',
    );

    await debePasar(c, 'G4 - escalamiento marcado para autorizacion', () =>
      conCita({
        id_solicitud: d,
        decision: 'ESCALADO_A_COMITE',
        monto_recomendado: null,
        requiere_autorizacion_humana: true,
      }),
    );

    // ---- Cita obligatoria (restriccion diferida) --------------------------
    await debeFallar(c, 'G1 - dictamen sin ninguna cita de politica', async () => {
      await insertar({ id_solicitud: a, monto_recomendado: 150000 });
      // Fuerza la comprobacion de las restricciones diferidas sin cerrar la
      // transaccion: es lo que ocurriria en el COMMIT real.
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    await c.query('SET CONSTRAINTS ALL DEFERRED');

    await debeFallar(
      c,
      'G1 - cita a una politica inexistente',
      async () => {
        const { rows } = await insertar({ id_solicitud: a, monto_recomendado: 150000 });
        await c.query(
          `INSERT INTO dictamen_citas (id_dictamen, id_politica, seccion, texto_literal, orden)
           VALUES ($1,'POL-00.0','inventada','texto inventado',0)`,
          [rows[0].id],
        );
      },
      'dictamen_citas_id_politica_fkey',
    );

    // ---- Maquina de estados ------------------------------------------------
    const firme = await conCita({ id_solicitud: a, monto_recomendado: 150000 });

    await debePasar(c, 'Estados - la confirmacion del analista deja el dictamen en firme', () =>
      c.query(
        `UPDATE dictamenes SET estado='EN_FIRME', confirmado_por='analista.prueba',
                confirmado_en=now() WHERE id=$1`,
        [firme],
      ),
    );

    await debeFallar(c, 'Estados - un dictamen en firme no vuelve a pendiente', () =>
      c.query(`UPDATE dictamenes SET estado='PENDIENTE_AUTORIZACION' WHERE id=$1`, [firme]),
    );

    await debeFallar(c, 'Estados - el contenido de un dictamen en firme es inmutable', () =>
      c.query(`UPDATE dictamenes SET decision='RECHAZADO' WHERE id=$1`, [firme]),
    );

    await debeFallar(c, 'Estados - las citas de un dictamen en firme son inmutables', () =>
      c.query(`DELETE FROM dictamen_citas WHERE id_dictamen=$1`, [firme]),
    );

    await debeFallar(
      c,
      'Estados - anular exige motivo',
      () => c.query(`UPDATE dictamenes SET estado='ANULADO' WHERE id=$1`, [firme]),
      'anulacion_con_motivo',
    );

    // ---- Idempotencia ------------------------------------------------------
    await debeFallar(
      c,
      'Idempotencia - clave repetida',
      async () => {
        const clave = 'clave-fija-de-prueba';
        await conCita({ id_solicitud: a, monto_recomendado: 150000, clave_idempotencia: clave });
        await conCita({ id_solicitud: b, monto_recomendado: 100000, clave_idempotencia: clave });
      },
      'dictamenes_clave_idempotencia_key',
    );

    // ---- Invalidacion de indicadores ---------------------------------------
    await debePasar(c, 'Indicadores - cambiar una entrada borra el precalculo', async () => {
      await c.query(
        `INSERT INTO indicadores_solicitud (id_solicitud, razon_endeudamiento, margen_neto,
           cobertura_servicio_deuda, relacion_monto_ventas, antiguedad_meses,
           tasa_anual_aplicada, huella_entradas, version_calculo)
         VALUES ($1, 0.375, 0.12, 1.8, 0.2, 36, 0.18, 'huella-de-prueba', 'v1')`,
        [a],
      );
      await c.query(`UPDATE solicitudes SET ventas_anuales = 1200000 WHERE id_solicitud=$1`, [a]);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM indicadores_solicitud WHERE id_solicitud=$1`,
        [a],
      );
      if (rows[0].n !== 0) throw new Error('el trigger no invalido los indicadores');
    });

    await debePasar(c, 'Indicadores - un cambio ajeno al calculo NO invalida', async () => {
      await c.query(
        `INSERT INTO indicadores_solicitud (id_solicitud, antiguedad_meses,
           tasa_anual_aplicada, huella_entradas, version_calculo)
         VALUES ($1, 36, 0.18, 'huella-de-prueba', 'v1')`,
        [b],
      );
      await c.query(`UPDATE solicitudes SET nombre_empresa='Otro nombre' WHERE id_solicitud=$1`, [
        b,
      ]);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM indicadores_solicitud WHERE id_solicitud=$1`,
        [b],
      );
      if (rows[0].n !== 1) throw new Error('el trigger invalido de mas');
    });

    // ---- Datos inconsistentes: DEBEN poder guardarse ------------------------
    await debePasar(c, 'Datos - se admiten pasivos mayores que activos (5.2.1)', () =>
      // Pasivos de 9 000 000 contra activos de 800 000.
      c.query(SOLICITUD, ['Inconsistente', 100000, 500000, 9000000]),
    );

    await debePasar(c, 'Datos - se admiten campos financieros ausentes (5.2.1)', () =>
      c.query(
        `INSERT INTO solicitudes (nombre_empresa, sector, meses_operacion, monto_solicitado,
           plazo_meses, destino_fondos, garantia_ofrecida, fecha_solicitud)
         VALUES ('Incompleta','servicios',10,50000,12,'sin detalle','ninguna',CURRENT_DATE)`,
      ),
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }

  // ---- Informe -------------------------------------------------------------
  const ancho = Math.max(...resultados.map((r) => r.nombre.length));
  console.log('\nVerificacion de restricciones de base de datos (M2)\n');
  for (const r of resultados) {
    console.log(`  ${r.ok ? 'OK   ' : 'FALLA'} ${r.nombre.padEnd(ancho)}  ${r.detalle}`);
  }
  const fallos = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallos}/${resultados.length} comprobaciones correctas\n`);
  await cerrarPool();
  if (fallos > 0) process.exit(1);
}

await main();
