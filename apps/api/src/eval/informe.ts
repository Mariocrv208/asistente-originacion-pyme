import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CASOS } from './casos.js';

/**
 * Informe acumulativo de la evaluación.
 *
 * POR QUÉ ACUMULA EN VEZ DE SOBRESCRIBIR
 *
 * La capa gratuita de OpenRouter permite 50 peticiones al día y una ejecución
 * del agente consume entre 6 y 12, así que los diez casos NO caben en un día.
 * Hay que correrlos por tandas, y un ejecutor que sobrescribiera el informe en
 * cada tanda dejaría al final cinco archivos sueltos en vez del entregable
 * único que pide el punto 5.3.6.
 *
 * El informe se guarda con los casos indexados por identificador: fusionar es
 * reemplazar la entrada del caso que se acaba de correr y dejar intactas las
 * demás. Cada caso conserva cuándo se ejecutó y con qué modelo, porque en una
 * evaluación repartida en varios días esas dos cosas pueden cambiar y un
 * resultado sin ellas no se puede comparar con otro.
 */

export const DIRECTORIO = join(import.meta.dirname, '../../../../eval-results');
const RUTA = join(DIRECTORIO, 'ultima.json');

export interface CasoEnInforme {
  id: string;
  titulo: string;
  categoria: string;
  idSolicitud: string;
  paso: boolean;
  condiciones: Array<{ nombre: string; ok: boolean; detalle: string }>;
  decisionObtenida: string | null;
  decisionEsperada: string;
  citas: string[];
  idDictamen: string | null;
  idEjecucion: string;
  degradado: boolean;
  iteraciones: number;
  latenciaMs: number;
  modelo: string;
  error?: string;
  /** Cuándo se corrió este caso concreto. */
  ejecutado_en: string;
}

export interface Tanda {
  ejecutado_en: string;
  modelo_configurado: string;
  version_prompt: string;
  id_sesion: string;
  casos: string[];
  duracion_ms: number;
  interrumpida_por_cuota: boolean;
}

export interface Informe {
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
  tandas: Tanda[];
  casos: Record<string, CasoEnInforme>;
}

export async function leerInforme(): Promise<Informe | null> {
  try {
    return JSON.parse(await readFile(RUTA, 'utf8')) as Informe;
  } catch {
    return null;
  }
}

/** Identificadores de los casos que todavía no tienen resultado. */
export async function casosPendientes(): Promise<string[]> {
  const previo = await leerInforme();
  const hechos = new Set(Object.keys(previo?.casos ?? {}));
  return CASOS.filter((c) => !hechos.has(c.id)).map((c) => c.id);
}

/**
 * Fusiona los resultados de una tanda con lo que ya hubiera y reescribe el
 * informe. Un caso que se vuelve a correr reemplaza su entrada anterior: si se
 * repite es porque la primera vez no valió.
 */
export async function fusionar(nuevos: CasoEnInforme[], tanda: Tanda): Promise<Informe> {
  const previo = await leerInforme();

  const casos: Record<string, CasoEnInforme> = { ...(previo?.casos ?? {}) };
  for (const caso of nuevos) casos[caso.id] = caso;

  // Se ordena como el banco, no por cuándo se corrió: el informe se lee por
  // categorías, no por cronología.
  const ordenados: Record<string, CasoEnInforme> = {};
  for (const c of CASOS) if (casos[c.id]) ordenados[c.id] = casos[c.id]!;

  const conResultado = Object.values(ordenados);
  const pendientes = CASOS.filter((c) => !ordenados[c.id]).map((c) => c.id);
  const pasan = conResultado.filter((c) => c.paso).length;

  const informe: Informe = {
    actualizado_en: new Date().toISOString(),
    estado: pendientes.length === 0 ? 'completo' : 'parcial',
    casos_con_resultado: conResultado.length,
    casos_totales: CASOS.length,
    pendientes,
    resumen: {
      pasan,
      fallan: conResultado.length - pasan,
      por_categoria: Object.fromEntries(
        ['aprobacion', 'rechazo', 'escalamiento', 'adversarial'].map((cat) => {
          const total = CASOS.filter((c) => c.categoria === cat).length;
          const de = conResultado.filter((c) => c.categoria === cat);
          return [cat, `${de.filter((c) => c.paso).length}/${de.length} de ${total}`];
        }),
      ),
    },
    tandas: [...(previo?.tandas ?? []), tanda],
    casos: ordenados,
  };

  await mkdir(DIRECTORIO, { recursive: true });
  await writeFile(RUTA, `${JSON.stringify(informe, null, 2)}\n`, 'utf8');
  return informe;
}
