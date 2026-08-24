import { z } from 'zod';

/** Estado de una dependencia externa comprobada por el healthcheck. */
export const dependenciaSaludSchema = z.object({
  estado: z.enum(['ok', 'error']),
  latenciaMs: z.number().nonnegative(),
  detalle: z.string().optional(),
});

export const saludSchema = z.object({
  estado: z.enum(['ok', 'degradado']),
  version: z.string(),
  entorno: z.string(),
  tiempoActivoSegundos: z.number().nonnegative(),
  dependencias: z.object({
    baseDatos: dependenciaSaludSchema,
  }),
});

export type DependenciaSalud = z.infer<typeof dependenciaSaludSchema>;
export type Salud = z.infer<typeof saludSchema>;
