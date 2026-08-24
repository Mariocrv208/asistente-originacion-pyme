import { createHash } from 'node:crypto';
import type { Hallazgo, IndicadoresCalculados } from '@aop/shared';
import { cuotaAnualEstimada } from '../finanzas/amortizacion.js';
import type { Decimal } from '../finanzas/decimal.js';
import { dinero, haciaBd, razon } from '../finanzas/decimal.js';

/**
 * Calculo de los cinco indicadores del punto 5.3.1.
 *
 * Esta funcion es la UNICA fuente de verdad de los indicadores. El guardarrail
 * G2 rechaza la persistencia de un dictamen cuyos indicadores no coincidan con
 * lo que devuelve esta funcion, y esa comparacion solo significa algo mientras
 * no exista una segunda implementacion en ningun otro sitio. Por eso no hay
 * columnas generadas en SQL que calculen lo mismo (ver migracion 0003).
 *
 * El LLM nunca entra aqui. Recibe el resultado ya calculado como un bloque
 * estable de contexto; no puede producirlo ni corregirlo.
 */

/**
 * Version del algoritmo.
 *
 * Se guarda con cada calculo. Si manana cambia la formula de cobertura o la
 * regla de redondeo, los indicadores viejos quedan identificables y un auditor
 * puede saber con que version se emitio un dictamen de hace seis meses.
 */
export const VERSION_CALCULO = '1.0.0';

/** Entradas del calculo, ya leidas de la solicitud. */
export interface EntradasIndicadores {
  monto_solicitado: Decimal;
  plazo_meses: number;
  meses_operacion: number;
  ventas_anuales: Decimal | null;
  utilidad_neta: Decimal | null;
  activos_totales: Decimal | null;
  pasivos_totales: Decimal | null;
  deuda_vigente_anual: Decimal | null;
  score_historial: number | null;
  tasa_anual: Decimal;
}

function hallazgo(codigo: Hallazgo['codigo'], mensaje: string, bloqueaCalculo: boolean): Hallazgo {
  return { codigo, mensaje, bloqueaCalculo };
}

/**
 * Detecta datos ausentes o internamente incoherentes.
 *
 * No es validacion de entrada: la solicitud se acepta igual. Es informacion
 * que el dictamen debe poder citar, y es lo que activa POL-8.4, que impide
 * aprobar un expediente con informacion incompleta o inconsistente.
 */
export function detectarHallazgos(e: EntradasIndicadores): Hallazgo[] {
  const h: Hallazgo[] = [];

  if (e.ventas_anuales === null) {
    h.push(hallazgo('ventas_ausentes', 'No se declararon ventas anuales.', true));
  } else if (e.ventas_anuales.isZero()) {
    h.push(hallazgo('ventas_en_cero', 'Las ventas anuales declaradas son cero.', true));
  }

  if (e.utilidad_neta === null) {
    h.push(hallazgo('utilidad_ausente', 'No se declaro utilidad neta.', true));
  }

  if (e.activos_totales === null) {
    h.push(hallazgo('activos_ausentes', 'No se declararon activos totales.', true));
  } else if (e.activos_totales.isZero()) {
    h.push(hallazgo('activos_en_cero', 'Los activos totales declarados son cero.', true));
  }

  if (e.pasivos_totales === null) {
    h.push(hallazgo('pasivos_ausentes', 'No se declararon pasivos totales.', true));
  }

  if (e.deuda_vigente_anual === null) {
    h.push(hallazgo('deuda_vigente_ausente', 'No se declaro el servicio de deuda vigente.', true));
  }

  // La ausencia de score es la situacion que el corpus deliberadamente NO
  // cubre. Se marca aqui para que el agente pueda escalarla en vez de
  // inventarse una regla que no existe.
  if (e.score_historial === null) {
    h.push(
      hallazgo(
        'score_ausente',
        'El solicitante no tiene score de historial. Ninguna politica vigente regula este caso.',
        false,
      ),
    );
  }

  // Incoherencias internas: los datos estan, pero no pueden ser ciertos a la vez.
  if (e.pasivos_totales !== null && e.activos_totales !== null) {
    if (e.pasivos_totales.gt(e.activos_totales)) {
      h.push(
        hallazgo(
          'pasivos_superan_activos',
          `Los pasivos (${e.pasivos_totales.toFixed(2)}) superan a los activos (${e.activos_totales.toFixed(2)}): patrimonio negativo.`,
          false,
        ),
      );
    }
  }

  if (e.utilidad_neta !== null && e.ventas_anuales !== null) {
    if (e.utilidad_neta.gt(e.ventas_anuales)) {
      h.push(
        hallazgo(
          'utilidad_supera_ventas',
          `La utilidad neta (${e.utilidad_neta.toFixed(2)}) supera a las ventas (${e.ventas_anuales.toFixed(2)}), lo cual es imposible.`,
          false,
        ),
      );
    }
    if (e.utilidad_neta.isNegative()) {
      h.push(
        hallazgo(
          'utilidad_neta_negativa',
          `La utilidad neta declarada es negativa (${e.utilidad_neta.toFixed(2)}).`,
          false,
        ),
      );
    }
  }

  if (e.ventas_anuales !== null && e.monto_solicitado.gt(e.ventas_anuales)) {
    h.push(
      hallazgo(
        'monto_supera_ventas',
        `El monto solicitado (${e.monto_solicitado.toFixed(2)}) supera las ventas anuales declaradas.`,
        false,
      ),
    );
  }

  return h;
}

/**
 * Huella de las entradas.
 *
 * Defensa en profundidad sobre la invalidacion por trigger de la migracion
 * 0003. Si una carga masiva escribiera indicadores saltandose el trigger, la
 * huella no cuadraria y la discrepancia seria detectable. Se incluye la
 * version del algoritmo: cambiar la formula invalida el precalculo aunque los
 * datos de entrada sean identicos.
 */
export function huellaEntradas(e: EntradasIndicadores): string {
  const canonico = JSON.stringify([
    VERSION_CALCULO,
    e.monto_solicitado.toFixed(),
    e.plazo_meses,
    e.meses_operacion,
    e.ventas_anuales?.toFixed() ?? null,
    e.utilidad_neta?.toFixed() ?? null,
    e.activos_totales?.toFixed() ?? null,
    e.pasivos_totales?.toFixed() ?? null,
    e.deuda_vigente_anual?.toFixed() ?? null,
    e.tasa_anual.toFixed(),
  ]);
  return createHash('sha256').update(canonico).digest('hex');
}

/** Divide devolviendo null cuando el divisor es nulo o cero. */
function dividir(numerador: Decimal | null, divisor: Decimal | null): Decimal | null {
  if (numerador === null || divisor === null || divisor.isZero()) return null;
  return razon(numerador.div(divisor));
}

export function calcularIndicadores(e: EntradasIndicadores): IndicadoresCalculados {
  // La cuota del credito nuevo alimenta la cobertura de servicio de deuda. Es
  // el unico de los cinco indicadores que no sale de una division directa
  // entre columnas, y la razon por la que ninguna columna generada de SQL
  // podria calcularlos todos.
  const { cuotaMensual, cuotaAnual } = cuotaAnualEstimada(
    e.monto_solicitado,
    e.tasa_anual,
    e.plazo_meses,
  );

  // Denominador de la cobertura: servicio de deuda total tras el credito
  // nuevo. Si no se declaro la deuda vigente, el denominador es desconocido y
  // el indicador queda sin calcular; suponer cero regalaria una cobertura
  // favorable que nadie ha acreditado.
  const servicioTotal =
    e.deuda_vigente_anual === null ? null : dinero(cuotaAnual.plus(e.deuda_vigente_anual));

  return {
    razon_endeudamiento: haciaBd(dividir(e.pasivos_totales, e.activos_totales)),
    margen_neto: haciaBd(dividir(e.utilidad_neta, e.ventas_anuales)),
    cobertura_servicio_deuda: haciaBd(dividir(e.utilidad_neta, servicioTotal)),
    relacion_monto_ventas: haciaBd(dividir(e.monto_solicitado, e.ventas_anuales)),
    antiguedad_meses: e.meses_operacion,

    tasa_anual_aplicada: e.tasa_anual.toFixed(),
    cuota_mensual_estimada: haciaBd(cuotaMensual),
    cuota_anual_estimada: haciaBd(cuotaAnual),
    hallazgos: detectarHallazgos(e),
    huella_entradas: huellaEntradas(e),
    version_calculo: VERSION_CALCULO,
  };
}
