/**
 * Cliente de la API.
 *
 * Delgado a propósito: la validación fuerte vive en el servidor y los esquemas
 * compartidos de @aop/shared describen los contratos. Aquí solo se traduce el
 * error HTTP a algo que la interfaz pueda mostrar sin que el analista vea un
 * volcado técnico.
 */

export class ErrorApi extends Error {
  constructor(
    mensaje: string,
    readonly estado: number,
    readonly detalles?: Array<{ campo: string; mensaje: string }>,
  ) {
    super(mensaje);
    this.name = 'ErrorApi';
  }
}

async function pedir<T>(ruta: string, opciones?: RequestInit): Promise<T> {
  const respuesta = await fetch(ruta, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', ...opciones?.headers },
  });

  if (!respuesta.ok) {
    const cuerpo = (await respuesta.json().catch(() => ({}))) as {
      error?: string;
      detalles?: Array<{ campo: string; mensaje: string }>;
    };
    throw new ErrorApi(
      cuerpo.error ?? `La API respondió ${respuesta.status}`,
      respuesta.status,
      cuerpo.detalles,
    );
  }

  return (await respuesta.json()) as T;
}

// ---------------------------------------------------------------------------
// Tipos de respuesta
// ---------------------------------------------------------------------------

export type Decision = 'APROBADO' | 'RECHAZADO' | 'ESCALADO_A_COMITE';
export type EstadoDictamen = 'PENDIENTE_AUTORIZACION' | 'EN_FIRME' | 'ANULADO';
export type NivelRiesgo = 'BAJO' | 'MEDIO' | 'ALTO';

export interface FilaBandeja {
  id_solicitud: string;
  nombre_empresa: string;
  sector: string;
  monto_solicitado: string;
  plazo_meses: number;
  meses_operacion: number;
  score_historial: number | null;
  garantia_ofrecida: string;
  fecha_solicitud: string;
  id_dictamen: string | null;
  decision: Decision | null;
  estado: EstadoDictamen | null;
  monto_recomendado: string | null;
  nivel_riesgo: NivelRiesgo | null;
  requiere_autorizacion_humana: boolean | null;
  confianza: string | null;
}

export interface Bandeja {
  total: number;
  limite: number;
  desplazamiento: number;
  solicitudes: FilaBandeja[];
}

export interface Cita {
  id_politica: string;
  seccion: string;
  texto_literal: string;
}

export interface DictamenApi {
  id: string;
  id_solicitud: string;
  decision: Decision;
  estado: EstadoDictamen;
  monto_recomendado: string | null;
  plazo_recomendado_meses: number | null;
  nivel_riesgo: NivelRiesgo;
  requiere_autorizacion_humana: boolean;
  confianza: string;
  motivos: string[];
  creado_en: string;
  confirmado_por: string | null;
  confirmado_en: string | null;
  id_ejecucion: string | null;
  citas: Cita[];
}

export interface Hallazgo {
  codigo: string;
  mensaje: string;
  bloqueaCalculo: boolean;
}

export interface IndicadoresApi {
  razon_endeudamiento: string | null;
  margen_neto: string | null;
  cobertura_servicio_deuda: string | null;
  relacion_monto_ventas: string | null;
  antiguedad_meses: number;
  cuota_mensual_estimada: string | null;
  tasa_anual_aplicada: string;
  hallazgos: Hallazgo[];
  version_calculo: string;
}

export interface DetalleSolicitud {
  solicitud: Record<string, string | number | null>;
  indicadores: IndicadoresApi | null;
  dictamenes: DictamenApi[];
}

export interface Metricas {
  solicitudes_procesadas_por_estado: Record<string, number>;
  por_decision: Record<string, number>;
  monto_promedio_recomendado: string | null;
  tasa_escalamiento: number | null;
  total_solicitudes: number;
  total_dictamenes: number;
  por_sector: Array<{ sector: string; total: number; escalados: number }>;
}

export interface CasoEvaluacion {
  id: string;
  titulo: string;
  categoria: string;
  idSolicitud: string;
  paso: boolean;
  condiciones: Array<{ nombre: string; ok: boolean; detalle: string }>;
  decisionObtenida: Decision | null;
  decisionEsperada: Decision;
  citas: string[];
  idDictamen: string | null;
  idEjecucion: string;
  degradado: boolean;
  iteraciones: number;
  latenciaMs: number;
  modelo: string;
  error?: string;
  ejecutado_en: string;
}

export interface TandaEvaluacion {
  ejecutado_en: string;
  modelo_configurado: string;
  version_prompt: string;
  id_sesion: string;
  casos: string[];
  duracion_ms: number;
  interrumpida_por_cuota: boolean;
}

export interface InformeEvaluacion {
  actualizado_en: string;
  estado: 'completo' | 'parcial';
  casos_con_resultado: number;
  casos_totales: number;
  pendientes: string[];
  resumen: {
    pasan: number;
    fallan: number;
    por_categoria: Record<string, string>;
  };
  tandas: TandaEvaluacion[];
  casos: Record<string, CasoEvaluacion>;
}

export interface PasoTraza {
  indice: number;
  tipo: 'LLM' | 'HERRAMIENTA' | 'GUARDARRAIL' | 'REPARACION';
  nombre: string;
  argumentos: unknown;
  resultado: unknown;
  error: string | null;
  tokens_entrada: number | null;
  tokens_salida: number | null;
  latencia_ms: number | null;
  creado_en: string;
}

// ---------------------------------------------------------------------------

export const api = {
  bandeja: (parametros: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(parametros)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return pedir<Bandeja>(`/api/solicitudes?${qs.toString()}`);
  },

  solicitud: (id: string) => pedir<DetalleSolicitud>(`/api/solicitudes/${id}`),

  dictamen: (id: string) => pedir<DictamenApi>(`/api/dictamenes/${id}`),

  confirmar: (id: string, analista: string) =>
    pedir<DictamenApi>(`/api/dictamenes/${id}/confirmar`, {
      method: 'POST',
      body: JSON.stringify({ analista }),
    }),

  anular: (id: string, analista: string, motivo: string) =>
    pedir<DictamenApi>(`/api/dictamenes/${id}/anular`, {
      method: 'POST',
      body: JSON.stringify({ analista, motivo }),
    }),

  metricas: () => pedir<Metricas>('/api/metricas'),

  ejecucion: (id: string) =>
    pedir<{ ejecucion: Record<string, unknown>; pasos: PasoTraza[] }>(`/api/ejecuciones/${id}`),

  evaluacion: () => pedir<InformeEvaluacion>('/api/evaluacion'),
};
