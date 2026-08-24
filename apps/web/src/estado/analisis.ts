import { create } from 'zustand';
import { consumirFlujo } from '../lib/sse.js';

/**
 * Estado de una ejecución del agente en el cliente.
 *
 * PROPUESTA REVERSIBLE FRENTE A EFECTO CONFIRMADO (pregunta 3.3)
 *
 * Es la distinción que gobierna todo este archivo. El estado local tiene tres
 * capas y nunca se mezclan:
 *
 *  - `pasos`: lo que el agente ha ido haciendo. Es narración, se puede perder
 *    sin consecuencias.
 *  - `propuesta`: el dictamen que el modelo está intentando registrar. Es
 *    REVERSIBLE. Puede cambiar, puede ser rechazada por un guardarraíl, puede
 *    no llegar a existir. La interfaz la marca como tentativa.
 *  - `idDictamen`: llega solo cuando el servidor confirma la escritura. A
 *    partir de ahí hay un EFECTO CONFIRMADO, y la verdad deja de estar aquí:
 *    está en la base de datos.
 *
 * Por eso, al terminar, la interfaz recarga el expediente desde la API en vez
 * de pintar lo que tiene en memoria. El cliente nunca trata su vista local como
 * autoridad.
 *
 * QUÉ PASA AL RECONECTAR
 *
 * Nada que haya que reconstruir. Si la conexión se cae o el analista cancela,
 * el dictamen o se escribió o no se escribió, y eso se consulta. No se reanuda
 * el flujo: se vuelve a preguntar por el estado real. Reanudar exigiría que el
 * servidor guardara el flujo a medias, y no hay nada que ganar guardándolo,
 * porque el único resultado que importa ya es transaccional.
 */

export type FaseAnalisis = 'inactivo' | 'ejecutando' | 'completado' | 'cancelado' | 'error';

export interface PasoVisible {
  id: number;
  tipo: 'herramienta' | 'modelo';
  nombre: string;
  estado: 'en_curso' | 'ok' | 'fallo';
  resumen?: string;
  detalle?: string;
}

export interface CitaVisible {
  id_politica: string;
  seccion: string;
  texto_literal: string;
}

/** Dictamen tal y como lo propone el modelo. Reversible hasta que se confirma. */
export interface PropuestaDictamen {
  decision?: string;
  monto_recomendado?: string | null;
  plazo_recomendado_meses?: number | null;
  nivel_riesgo?: string;
  requiere_autorizacion_humana?: boolean;
  confianza?: number;
  motivos?: string[];
  politicas_citadas?: CitaVisible[];
}

interface EstadoAnalisis {
  fase: FaseAnalisis;
  idSolicitud: string | null;
  pasos: PasoVisible[];
  politicasConsultadas: CitaVisible[];
  propuesta: PropuestaDictamen | null;
  /** Solo se rellena cuando el servidor confirma la escritura. */
  idDictamen: string | null;
  degradado: boolean;
  resumenFinal: string | null;
  error: string | null;
  metricas: { iteraciones: number; tokens: number; latenciaMs: number; modelo: string } | null;

  iniciar: (idSolicitud: string, peticion?: string) => Promise<void>;
  cancelar: () => void;
  reiniciar: () => void;
}

let controlador: AbortController | null = null;
let siguienteId = 0;

const ETIQUETAS: Record<string, string> = {
  obtener_solicitud: 'Leyendo el expediente',
  calcular_indicadores: 'Calculando indicadores en decimal exacto',
  buscar_politica: 'Consultando el corpus de políticas',
  registrar_dictamen: 'Registrando el dictamen',
  metricas_cartera: 'Consultando métricas de cartera',
};

export const usarAnalisis = create<EstadoAnalisis>((set, get) => ({
  fase: 'inactivo',
  idSolicitud: null,
  pasos: [],
  politicasConsultadas: [],
  propuesta: null,
  idDictamen: null,
  degradado: false,
  resumenFinal: null,
  error: null,
  metricas: null,

  reiniciar: () =>
    set({
      fase: 'inactivo',
      pasos: [],
      politicasConsultadas: [],
      propuesta: null,
      idDictamen: null,
      degradado: false,
      resumenFinal: null,
      error: null,
      metricas: null,
    }),

  cancelar: () => {
    controlador?.abort();
    set({ fase: 'cancelado' });
  },

  iniciar: async (idSolicitud, peticion) => {
    get().reiniciar();
    set({ fase: 'ejecutando', idSolicitud });

    controlador = new AbortController();

    try {
      await consumirFlujo({
        ruta: '/api/analizar',
        cuerpo: { id_solicitud: idSolicitud, ...(peticion ? { peticion } : {}) },
        senal: controlador.signal,
        alEvento: ({ evento, datos }) => {
          if (evento === 'paso') aplicarPaso(set, get, datos as Record<string, unknown>);
          else if (evento === 'fin') aplicarFin(set, datos as Record<string, unknown>);
          else if (evento === 'error') {
            set({ fase: 'error', error: String((datos as { mensaje?: string }).mensaje) });
          }
        },
      });

      if (get().fase === 'ejecutando') set({ fase: 'completado' });
    } catch (error) {
      // Abortar es una acción del analista, no un fallo del sistema.
      if (controlador?.signal.aborted) {
        set({ fase: 'cancelado' });
        return;
      }
      set({ fase: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  },
}));

type Fijar = (parcial: Partial<EstadoAnalisis>) => void;
type Leer = () => EstadoAnalisis;

function aplicarPaso(set: Fijar, get: Leer, evento: Record<string, unknown>) {
  const tipo = evento.tipo as string;
  const nombre = (evento.nombre as string) ?? '';

  if (tipo === 'herramienta_inicio') {
    const resumen = resumirArgumentos(nombre, evento.argumentos);
    const paso: PasoVisible = {
      id: (siguienteId += 1),
      tipo: 'herramienta',
      nombre,
      estado: 'en_curso',
      ...(resumen !== undefined ? { resumen } : {}),
    };
    set({ pasos: [...get().pasos, paso] });

    // La propuesta del modelo viaja en los argumentos de registrar_dictamen.
    // Se muestra en cuanto se intenta, no cuando se consigue: el analista tiene
    // que poder ver qué se está proponiendo aunque un guardarraíl lo tumbe.
    if (nombre === 'registrar_dictamen') {
      const args = evento.argumentos as { dictamen?: PropuestaDictamen } | undefined;
      if (args?.dictamen) set({ propuesta: args.dictamen });
    }
    return;
  }

  if (tipo === 'herramienta_fin') {
    const resultado = evento.detalle as { ok?: boolean; datos?: unknown; error?: string };
    const pasos = [...get().pasos];

    for (let i = pasos.length - 1; i >= 0; i -= 1) {
      if (pasos[i]!.nombre === nombre && pasos[i]!.estado === 'en_curso') {
        pasos[i] = {
          ...pasos[i]!,
          estado: resultado?.ok === true ? 'ok' : 'fallo',
          ...(resultado?.error !== undefined ? { detalle: resultado.error } : {}),
        };
        break;
      }
    }
    set({ pasos });

    // Fuentes consultadas: se acumulan para que el analista vea sobre qué
    // políticas se está razonando, aunque el dictamen final no las cite todas.
    if (nombre === 'buscar_politica' && resultado?.ok === true) {
      const datos = resultado.datos as { fragmentos?: CitaVisible[] };
      const vistas = [...get().politicasConsultadas];
      for (const f of datos.fragmentos ?? []) {
        if (!vistas.some((v) => v.id_politica === f.id_politica)) vistas.push(f);
      }
      set({ politicasConsultadas: vistas });
    }
    return;
  }

  if (tipo === 'modelo_turno') {
    set({
      pasos: [
        ...get().pasos,
        { id: (siguienteId += 1), tipo: 'modelo', nombre, estado: 'ok', resumen: 'Analizando' },
      ],
    });
  }
}

/**
 * Mapea el estado terminal del servidor a la fase de la interfaz.
 *
 * No basta con dar por completada toda ejecucion que llegue al evento `fin`.
 * Una ejecucion FALLIDA tambien lo emite, y anunciarla como terminada le diria
 * al analista que el analisis se hizo cuando no se hizo. El estado lo decide el
 * servidor; la interfaz solo lo traduce.
 */
const FASES: Record<string, FaseAnalisis> = {
  COMPLETADA: 'completado',
  FALLIDA: 'error',
  CANCELADA: 'cancelado',
  TOPE_EXCEDIDO: 'error',
};

function aplicarFin(set: Fijar, datos: Record<string, unknown>) {
  set({
    fase: FASES[String(datos.estado)] ?? 'completado',
    idDictamen: (datos.idDictamen as string | null) ?? null,
    degradado: datos.degradado === true,
    resumenFinal: (datos.respuestaFinal as string | null) ?? null,
    ...(datos.error !== undefined ? { error: String(datos.error) } : {}),
    metricas: {
      iteraciones: Number(datos.iteraciones ?? 0),
      tokens: Number(datos.tokensEntrada ?? 0) + Number(datos.tokensSalida ?? 0),
      latenciaMs: Number(datos.latenciaMs ?? 0),
      modelo: String(datos.modelo ?? ''),
    },
  });
}

/** Traduce los argumentos de una herramienta a una línea legible. */
function resumirArgumentos(nombre: string, argumentos: unknown): string | undefined {
  const a = argumentos as Record<string, unknown> | undefined;
  if (!a) return ETIQUETAS[nombre];
  if (nombre === 'buscar_politica' && typeof a.consulta === 'string') {
    return `Busca: «${a.consulta}»`;
  }
  return ETIQUETAS[nombre];
}
