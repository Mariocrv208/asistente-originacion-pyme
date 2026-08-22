import { z } from 'zod';

/**
 * Los valores decimales viajan como CADENA, nunca como number.
 *
 * En cuanto un importe se convierte a number de JavaScript pasa por punto
 * flotante binario y el error ya esta hecho, aunque despues se vuelva a meter
 * en un Decimal. Como estos tipos cruzan de la API al navegador por JSON, la
 * cadena es la unica representacion que sobrevive el viaje intacta.
 */
const decimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'debe ser un decimal en texto');

/** Motivos por los que una solicitud presenta datos incompletos o incoherentes. */
export const codigoHallazgoSchema = z.enum([
  'ventas_ausentes',
  'ventas_en_cero',
  'utilidad_ausente',
  'activos_ausentes',
  'activos_en_cero',
  'pasivos_ausentes',
  'deuda_vigente_ausente',
  'score_ausente',
  'pasivos_superan_activos',
  'utilidad_supera_ventas',
  'utilidad_neta_negativa',
  'monto_supera_ventas',
]);

export const hallazgoSchema = z.object({
  codigo: codigoHallazgoSchema,
  mensaje: z.string(),
  /** true si impide calcular al menos un indicador. */
  bloqueaCalculo: z.boolean(),
});

/**
 * Los cinco indicadores del punto 5.3.1.
 *
 * Son NULL-ables porque con ventas o activos ausentes o en cero el cociente no
 * esta definido. "No calculable" es un resultado legitimo que el dictamen debe
 * poder explicar; sustituirlo por cero seria inventar un dato y llevaria al
 * modelo a razonar sobre una cifra que nadie declaro.
 */
export const indicadoresSchema = z.object({
  razon_endeudamiento: decimalSchema.nullable(),
  margen_neto: decimalSchema.nullable(),
  cobertura_servicio_deuda: decimalSchema.nullable(),
  relacion_monto_ventas: decimalSchema.nullable(),
  antiguedad_meses: z.number().int().nonnegative(),
});

/** Lo anterior mas la trazabilidad del calculo. */
export const indicadoresCalculadosSchema = indicadoresSchema.extend({
  tasa_anual_aplicada: decimalSchema,
  cuota_mensual_estimada: decimalSchema.nullable(),
  cuota_anual_estimada: decimalSchema.nullable(),
  hallazgos: z.array(hallazgoSchema),
  /** Huella de las entradas: detecta un precalculo obsoleto. */
  huella_entradas: z.string(),
  version_calculo: z.string(),
});

export type CodigoHallazgo = z.infer<typeof codigoHallazgoSchema>;
export type Hallazgo = z.infer<typeof hallazgoSchema>;
export type Indicadores = z.infer<typeof indicadoresSchema>;
export type IndicadoresCalculados = z.infer<typeof indicadoresCalculadosSchema>;
