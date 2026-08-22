import { z } from 'zod';

/** Categorias del corpus. Se declaran en el propio JSON, no en el codigo. */
export const categoriaSchema = z.string().regex(/^[a-z_]+$/);

export const severidadSchema = z.enum(['bloqueante', 'informativa']);

export const politicaSchema = z.object({
  id: z.string().regex(/^POL-\d+\.\d+$/, 'el identificador debe tener la forma POL-<n>.<m>'),
  seccion: z.string().min(1),
  categoria: categoriaSchema,
  texto: z.string().min(1),
  severidad: severidadSchema,
  /** Politicas a las que esta modifica parcialmente. Vacio si es una regla general. */
  modifica_a: z.array(z.string()).default([]),
});

export const corpusSchema = z.object({
  version: z.string().min(1),
  moneda: z.string().min(1),
  notas_corpus: z.record(z.string()).optional(),
  categorias: z.record(z.string()),
  politicas: z.array(politicaSchema).min(1),
});

export type Politica = z.infer<typeof politicaSchema>;
export type Corpus = z.infer<typeof corpusSchema>;
export type Severidad = z.infer<typeof severidadSchema>;

/** Cita que el agente adjunta a un dictamen. Es lo que G1 verifica. */
export const citaPoliticaSchema = z.object({
  id_politica: z.string(),
  seccion: z.string(),
  texto_literal: z.string().min(1),
});

export type CitaPolitica = z.infer<typeof citaPoliticaSchema>;
