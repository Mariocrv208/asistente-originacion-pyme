/**
 * Lista los modelos gratuitos de OpenRouter que sirven para este proyecto.
 *
 * Existe porque el catalogo gratuito ROTA. Los tres modelos elegidos al
 * planificar el proyecto (deepseek-chat-v3, llama-3.3-70b y qwen-2.5-72b en su
 * variante :free) dejaron de serlo antes de llegar a usarlos, y la API empezo a
 * devolver 404. Conviene reejecutar esto antes de la entrega y antes de grabar
 * el video.
 *
 * Filtra por las dos capacidades que el sistema necesita de verdad:
 *   - tools:              sin esto no hay ciclo de agente (M7).
 *   - structured_outputs: sin esto la salida estructurada depende de que el
 *                         modelo acierte a producir JSON valido (M9).
 *
 * Uso:  node scripts/listar-modelos-gratuitos.mjs [ruta-al-.env]
 */
import { readFileSync } from 'node:fs';

const ruta = process.argv[2] ?? '.env';
const env = Object.fromEntries(
  readFileSync(ruta, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/\r$/, '')];
    }),
);

if (!env.OPENROUTER_API_KEY) {
  console.error(`Falta OPENROUTER_API_KEY en ${ruta}`);
  process.exit(1);
}

const respuesta = await fetch(
  `${env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'}/models`,
  { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } },
);

if (!respuesta.ok) {
  console.error(`La API respondio ${respuesta.status}`);
  process.exit(1);
}

const { data } = await respuesta.json();

const gratuito = (m) =>
  Number(m.pricing?.prompt ?? 0) === 0 && Number(m.pricing?.completion ?? 0) === 0;

const candidatos = data
  .filter(gratuito)
  .filter((m) => (m.supported_parameters ?? []).includes('tools'))
  .map((m) => ({
    id: m.id,
    contexto: m.context_length ?? 0,
    estructurada: (m.supported_parameters ?? []).includes('structured_outputs'),
  }))
  .sort((a, b) => Number(b.estructurada) - Number(a.estructurada) || b.contexto - a.contexto);

console.log(
  `\n${data.length} modelos en el catalogo, ${data.filter(gratuito).length} gratuitos, ` +
    `${candidatos.length} con herramientas.\n`,
);
console.log('  APTOS (herramientas + salida estructurada)');
for (const m of candidatos.filter((c) => c.estructurada)) {
  console.log(`    ${m.id.padEnd(50)} ${String(m.contexto).padStart(9)} de contexto`);
}
console.log('\n  SOLO HERRAMIENTAS (la salida estructurada dependeria del modelo)');
for (const m of candidatos.filter((c) => !c.estructurada).slice(0, 8)) {
  console.log(`    ${m.id.padEnd(50)} ${String(m.contexto).padStart(9)} de contexto`);
}
console.log('');
