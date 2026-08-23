import { z } from 'zod';
import { indicadoresSchema } from './indicadores.js';
import { citaPoliticaSchema } from './politicas.js';

/**
 * Salida estructurada del agente (punto 5.3.4).
 *
 * Este esquema es la frontera entre lo que el modelo PROPONE y lo que el
 * sistema acepta. Nada llega a la base de datos sin pasar por aqui.
 *
 * Dos decisiones sobre la forma:
 *
 *  - Los montos son cadenas decimales, no numeros. Un `number` en JSON pasa por
 *    punto flotante binario, y ese es exactamente el error que el punto 5.3.1
 *    prohibe. Se acepta tambien un entero sin decimales porque los modelos
 *    tienden a escribir 150000 en vez de "150000.00".
 *  - `indicadores` viene en el objeto aunque el modelo no deba calcularlo. Es
 *    deliberado: obligar al modelo a copiarlos permite que G2 compare lo que
 *    dice con lo que calculo el codigo. Si no estuvieran, no habria nada que
 *    contrastar y G2 no podria existir.
 */

export const decisionSchema = z.enum(['APROBADO', 'RECHAZADO', 'ESCALADO_A_COMITE']);
export const nivelRiesgoSchema = z.enum(['BAJO', 'MEDIO', 'ALTO']);

/** Monto en texto decimal. Se admite entero para no pelear con el modelo. */
const montoSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'el monto debe ser un decimal en texto, por ejemplo "150000.00"');

export const dictamenSchema = z.object({
  id_solicitud: z.string().uuid(),
  decision: decisionSchema,
  monto_recomendado: montoSchema.nullable(),
  plazo_recomendado_meses: z.number().int().min(1).max(360).nullable(),
  indicadores: indicadoresSchema,
  /** El enunciado exige al menos un elemento. */
  politicas_citadas: z.array(citaPoliticaSchema).min(1, 'toda decision necesita al menos una cita'),
  motivos: z.array(z.string().min(1)).min(1),
  nivel_riesgo: nivelRiesgoSchema,
  requiere_autorizacion_humana: z.boolean(),
  confianza: z.number().min(0).max(1),
});

export type Decision = z.infer<typeof decisionSchema>;
export type NivelRiesgo = z.infer<typeof nivelRiesgoSchema>;
export type Dictamen = z.infer<typeof dictamenSchema>;

/**
 * Esquema JSON que se le envia al proveedor.
 *
 * Se escribe a mano en vez de derivarlo de Zod porque los modelos gratuitos son
 * quisquillosos con los esquemas: rechazan `anyOf` complejos y a veces ignoran
 * `additionalProperties`. Mantenerlo explicito permite simplificarlo para el
 * modelo sin relajar la validacion real, que sigue siendo la de Zod.
 */
export const ESQUEMA_JSON_DICTAMEN = {
  name: 'dictamen',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id_solicitud',
      'decision',
      'monto_recomendado',
      'plazo_recomendado_meses',
      'indicadores',
      'politicas_citadas',
      'motivos',
      'nivel_riesgo',
      'requiere_autorizacion_humana',
      'confianza',
    ],
    properties: {
      id_solicitud: { type: 'string' },
      decision: { type: 'string', enum: ['APROBADO', 'RECHAZADO', 'ESCALADO_A_COMITE'] },
      monto_recomendado: {
        type: ['string', 'null'],
        description:
          'Monto en quetzales como texto decimal, por ejemplo "150000.00". Null si no aplica.',
      },
      plazo_recomendado_meses: { type: ['integer', 'null'] },
      indicadores: {
        type: 'object',
        additionalProperties: false,
        required: [
          'razon_endeudamiento',
          'margen_neto',
          'cobertura_servicio_deuda',
          'relacion_monto_ventas',
          'antiguedad_meses',
        ],
        properties: {
          razon_endeudamiento: { type: ['string', 'null'] },
          margen_neto: { type: ['string', 'null'] },
          cobertura_servicio_deuda: { type: ['string', 'null'] },
          relacion_monto_ventas: { type: ['string', 'null'] },
          antiguedad_meses: { type: 'integer' },
        },
      },
      politicas_citadas: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id_politica', 'seccion', 'texto_literal'],
          properties: {
            id_politica: { type: 'string' },
            seccion: { type: 'string' },
            texto_literal: {
              type: 'string',
              description: 'Fragmento COPIADO LITERALMENTE del corpus. No parafrasear.',
            },
          },
        },
      },
      motivos: { type: 'array', minItems: 1, items: { type: 'string' } },
      nivel_riesgo: { type: 'string', enum: ['BAJO', 'MEDIO', 'ALTO'] },
      requiere_autorizacion_humana: { type: 'boolean' },
      confianza: { type: 'number' },
    },
  },
} as const;
