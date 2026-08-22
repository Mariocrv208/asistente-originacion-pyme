import { z } from 'zod';

/**
 * Enumerados del punto 5.2.1.
 *
 * Viven aqui y no en cada aplicacion porque son el vocabulario compartido: el
 * backend valida contra ellos y el frontend construye sus filtros y etiquetas
 * a partir de la misma lista. Duplicarlos garantizaria que un dia se separen.
 */
export const sectorSchema = z.enum([
  'comercio',
  'manufactura',
  'servicios',
  'agropecuario',
  'transporte',
  'construccion',
  'otros',
]);

export const garantiaSchema = z.enum(['ninguna', 'fiduciaria', 'prendaria', 'hipotecaria']);

export type Sector = z.infer<typeof sectorSchema>;
export type Garantia = z.infer<typeof garantiaSchema>;

/** Etiquetas legibles para la interfaz. */
export const ETIQUETA_SECTOR: Record<Sector, string> = {
  comercio: 'Comercio',
  manufactura: 'Manufactura',
  servicios: 'Servicios',
  agropecuario: 'Agropecuario',
  transporte: 'Transporte',
  construccion: 'Construcción',
  otros: 'Otros',
};

export const ETIQUETA_GARANTIA: Record<Garantia, string> = {
  ninguna: 'Sin garantía',
  fiduciaria: 'Fiduciaria',
  prendaria: 'Prendaria',
  hipotecaria: 'Hipotecaria',
};

const decimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/);

/**
 * Solicitud tal y como sale de la base de datos.
 *
 * Los campos financieros son NULL-ables a proposito: el punto 5.2.1 exige que
 * al menos cinco solicitudes lleguen incompletas, y son entrada legitima del
 * sistema, no datos corruptos.
 */
export const solicitudSchema = z.object({
  id_solicitud: z.string().uuid(),
  nombre_empresa: z.string(),
  sector: sectorSchema,
  meses_operacion: z.number().int().nonnegative(),
  monto_solicitado: decimalSchema,
  plazo_meses: z.number().int().positive(),
  /** Entrada NO confiable del solicitante (guardarrail G5). */
  destino_fondos: z.string(),
  ventas_anuales: decimalSchema.nullable(),
  utilidad_neta: decimalSchema.nullable(),
  activos_totales: decimalSchema.nullable(),
  pasivos_totales: decimalSchema.nullable(),
  deuda_vigente_anual: decimalSchema.nullable(),
  score_historial: z.number().int().min(0).max(100).nullable(),
  garantia_ofrecida: garantiaSchema,
  fecha_solicitud: z.string(),
});

export type Solicitud = z.infer<typeof solicitudSchema>;
