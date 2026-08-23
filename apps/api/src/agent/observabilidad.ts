import { pool } from '../db/pool.js';

/**
 * Registro de ejecuciones del agente (punto 5.3.7).
 *
 * El enunciado pide que cada ejecucion deje constancia consultable de sesion,
 * version de prompt, modelo, secuencia de herramientas con argumentos y
 * resultados, tokens, latencia y costo.
 *
 * El escenario que esto tiene que resolver es el de la pregunta 4.5: seis meses
 * despues, un regulador pregunta por que se rechazo una solicitud concreta. La
 * respuesta no se reconstruye, se consulta: el dictamen apunta a su ejecucion,
 * y la ejecucion tiene la secuencia completa de lo que se miro y en que orden.
 *
 * Los fallos de registro NUNCA tumban la ejecucion. Perder una traza es malo;
 * perder el dictamen porque no se pudo escribir la traza es peor.
 */

export type TipoPaso = 'LLM' | 'HERRAMIENTA' | 'GUARDARRAIL' | 'REPARACION';

export interface Paso {
  tipo: TipoPaso;
  nombre: string;
  argumentos?: unknown;
  resultado?: unknown;
  error?: string;
  tokensEntrada?: number;
  tokensSalida?: number;
  latenciaMs?: number;
}

export class Bitacora {
  private indice = 0;

  private constructor(
    readonly idEjecucion: string,
    readonly idSesion: string,
  ) {}

  static async iniciar(opciones: {
    idSesion: string;
    idSolicitud: string | null;
    versionPrompt: string;
    modelo: string;
  }): Promise<Bitacora> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ejecuciones_agente (id_sesion, id_solicitud, version_prompt, modelo)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [opciones.idSesion, opciones.idSolicitud, opciones.versionPrompt, opciones.modelo],
    );
    return new Bitacora(rows[0]!.id, opciones.idSesion);
  }

  async registrar(paso: Paso): Promise<void> {
    const indice = this.indice;
    this.indice += 1;
    try {
      await pool.query(
        `INSERT INTO pasos_agente (id_ejecucion, indice, tipo, nombre, argumentos, resultado,
           error, tokens_entrada, tokens_salida, latencia_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          this.idEjecucion,
          indice,
          paso.tipo,
          paso.nombre,
          paso.argumentos === undefined ? null : JSON.stringify(paso.argumentos),
          paso.resultado === undefined ? null : JSON.stringify(paso.resultado),
          paso.error ?? null,
          paso.tokensEntrada ?? null,
          paso.tokensSalida ?? null,
          paso.latenciaMs ?? null,
        ],
      );
    } catch (error) {
      console.error('[observabilidad] no se pudo registrar el paso:', (error as Error).message);
    }
  }

  async cerrar(resumen: {
    estado: 'COMPLETADA' | 'FALLIDA' | 'CANCELADA' | 'TOPE_EXCEDIDO';
    iteraciones: number;
    tokensEntrada: number;
    tokensSalida: number;
    costoUsd: number;
    latenciaMs: number;
    modelo: string;
    modelosIntentados: string[];
    error?: string;
  }): Promise<void> {
    try {
      await pool.query(
        `UPDATE ejecuciones_agente
            SET estado = $2, iteraciones = $3, tokens_entrada = $4, tokens_salida = $5,
                costo_estimado_usd = $6, latencia_ms = $7, modelo = $8,
                modelos_intentados = $9, error = $10, finalizado_en = now()
          WHERE id = $1`,
        [
          this.idEjecucion,
          resumen.estado,
          resumen.iteraciones,
          resumen.tokensEntrada,
          resumen.tokensSalida,
          resumen.costoUsd,
          resumen.latenciaMs,
          resumen.modelo,
          resumen.modelosIntentados,
          resumen.error ?? null,
        ],
      );
    } catch (error) {
      console.error('[observabilidad] no se pudo cerrar la ejecucion:', (error as Error).message);
    }
  }
}
