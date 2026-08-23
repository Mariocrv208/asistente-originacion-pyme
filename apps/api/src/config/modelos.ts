import { env, modelosLlm, validarClaveLlm } from './env.js';

/**
 * Comprobacion de gratuidad de los modelos configurados.
 *
 * El enunciado exige OpenRouter "con modelos gratuitos, sin costo para el
 * aspirante". Eso no se puede fijar en la clave: en OpenRouter el modelo se
 * elige en cada peticion, asi que la clave por si sola no impide llamar a uno
 * de pago.
 *
 * Y el catalogo rota. Los tres modelos elegidos al planificar el proyecto
 * dejaron de ser gratuitos antes de llegar a usarlos, y la API empezo a
 * devolver 404. La siguiente vez podria no devolver 404: podria cobrar.
 *
 * Por eso esta comprobacion consulta el precio real antes de dejar que el
 * agente llame a nada. Es defensa en profundidad; la barrera principal sigue
 * siendo poner limite de credito 0 a la clave en la cuenta de OpenRouter.
 */

interface ModeloCatalogo {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

export interface VeredictoModelo {
  id: string;
  existe: boolean;
  gratuito: boolean;
  admiteHerramientas: boolean;
  admiteSalidaEstructurada: boolean;
}

let cache: VeredictoModelo[] | null = null;

async function consultarCatalogo(): Promise<Map<string, ModeloCatalogo>> {
  const respuesta = await fetch(`${env.OPENROUTER_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${validarClaveLlm()}` },
  });

  if (!respuesta.ok) {
    throw new Error(
      `No se pudo consultar el catalogo de modelos de OpenRouter (HTTP ${respuesta.status})`,
    );
  }

  const { data } = (await respuesta.json()) as { data: ModeloCatalogo[] };
  return new Map(data.map((m) => [m.id, m]));
}

/** Comprueba los modelos configurados contra el catalogo real. */
export async function verificarModelos(forzar = false): Promise<VeredictoModelo[]> {
  if (cache && !forzar) return cache;

  const catalogo = await consultarCatalogo();

  cache = modelosLlm.map((id) => {
    const m = catalogo.get(id);
    const parametros = m?.supported_parameters ?? [];
    return {
      id,
      existe: m !== undefined,
      gratuito:
        m !== undefined &&
        Number(m.pricing?.prompt ?? 0) === 0 &&
        Number(m.pricing?.completion ?? 0) === 0,
      admiteHerramientas: parametros.includes('tools'),
      admiteSalidaEstructurada: parametros.includes('structured_outputs'),
    };
  });

  return cache;
}

/**
 * Falla si algun modelo configurado no es utilizable.
 *
 * Se invoca antes de la primera llamada al proveedor, no en el arranque del
 * servidor: arrancar la API no deberia depender de que OpenRouter responda, y
 * toda la parte determinista del sistema funciona sin proveedor.
 */
export async function exigirModelosGratuitos(): Promise<VeredictoModelo[]> {
  const veredictos = await verificarModelos();
  const problemas: string[] = [];

  for (const v of veredictos) {
    if (!v.existe) {
      problemas.push(`  - ${v.id}: no existe en el catalogo de OpenRouter`);
    } else if (!v.gratuito) {
      problemas.push(`  - ${v.id}: NO ES GRATUITO. Usarlo consumiria saldo de la cuenta`);
    } else if (!v.admiteHerramientas) {
      problemas.push(`  - ${v.id}: no admite llamada a herramientas, el agente no puede usarlo`);
    }
  }

  if (problemas.length > 0) {
    throw new Error(
      `Los modelos configurados en LLM_MODEL y LLM_FALLBACK_MODELS no son utilizables:\n` +
        `${problemas.join('\n')}\n\n` +
        `El catalogo gratuito de OpenRouter rota. Ejecuta "pnpm llm:modelos" para ver ` +
        `cuales estan disponibles ahora y actualiza el archivo .env.`,
    );
  }

  return veredictos;
}
