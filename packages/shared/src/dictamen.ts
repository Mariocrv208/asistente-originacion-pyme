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

/**
 * Monto en texto decimal.
 *
 * La representacion canonica es la cadena, porque un number de JSON pasa por
 * punto flotante binario. Aun asi se ACEPTA un numero en la frontera y se
 * convierte a texto, por una razon medida: los modelos escriben 150000 con
 * mucha insistencia, y rechazarlo quemaba iteraciones enteras en discutir el
 * formato en vez de en analizar el credito.
 *
 * Es seguro a esta magnitud: los montos tienen como mucho nueve digitos
 * significativos y JSON.parse mas String() los reconstruye exactamente por
 * debajo de los quince que garantiza el formato. No seria seguro con importes
 * mayores, y por eso la cadena sigue siendo lo canonico y lo unico que se
 * escribe en la base de datos.
 */
const montoSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v.trim()))
  .pipe(
    z.string().regex(/^\d+(\.\d{1,2})?$/, 'el monto debe ser un decimal, por ejemplo "150000.00"'),
  );

/** El plazo llega a veces como "24" en vez de 24. */
const plazoSchema = z.coerce.number().int().min(1).max(360);

export const dictamenSchema = z.object({
  id_solicitud: z.string().uuid(),
  decision: decisionSchema,
  monto_recomendado: montoSchema.nullable(),
  plazo_recomendado_meses: plazoSchema.nullable(),
  indicadores: indicadoresSchema,
  /** El enunciado exige al menos un elemento. */
  politicas_citadas: z.array(citaPoliticaSchema).min(1, 'toda decision necesita al menos una cita'),
  motivos: z.array(z.string().min(1)).min(1),
  nivel_riesgo: nivelRiesgoSchema,
  requiere_autorizacion_humana: z.boolean(),
  confianza: z.coerce.number().min(0).max(1),
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
