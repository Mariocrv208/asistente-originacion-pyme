/**
 * Puesta en marcha desde un clon limpio.
 *
 * Existe porque arrancar el proyecto a mano son cinco comandos en un orden
 * concreto, y equivocarse en el orden produce errores que no explican nada:
 * migrar sin base de datos da ECONNREFUSED, sembrar sin corpus da una violación
 * de clave foránea. Quien evalúa esto no debería tener que deducir la secuencia.
 *
 * Uso:  pnpm preparar
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const paso = (n, texto) => console.log(`\n[${n}/5] ${texto}`);
const ok = (texto) => console.log(`      ${texto}`);

function correr(comando, silencioso = false) {
  return execSync(comando, { stdio: silencioso ? 'pipe' : 'inherit', encoding: 'utf8' });
}

function abortar(titulo, detalle) {
  console.error(`\n  ${titulo}\n\n${detalle}\n`);
  process.exit(1);
}

// --- 0. Requisitos ----------------------------------------------------------
try {
  correr('docker info', true);
} catch {
  abortar(
    'Docker no responde.',
    '  Abre Docker Desktop y espera a que el motor quede en verde.\n' +
      '  Sin él no hay PostgreSQL y nada más puede funcionar.',
  );
}

if (!existsSync('.env')) {
  abortar(
    'Falta el archivo .env',
    '  Cópialo desde la plantilla y añade tu clave de OpenRouter:\n\n' +
      '    cp .env.example .env\n\n' +
      '  La clave se obtiene en https://openrouter.ai/keys y solo hace falta\n' +
      '  para ejecutar el agente; el resto del sistema funciona sin ella.',
  );
}

const env = readFileSync('.env', 'utf8');
const clave = (env.split('\n').find((l) => l.startsWith('OPENROUTER_API_KEY=')) ?? '')
  .slice(19)
  .trim();

// --- 1. Base de datos -------------------------------------------------------
paso(1, 'Levantando PostgreSQL…');
correr('docker compose up -d db');

process.stdout.write('      esperando a que el contenedor esté sano');
let sana = false;
for (let i = 0; i < 40; i += 1) {
  try {
    const estado = correr(
      'docker inspect --format "{{.State.Health.Status}}" aop-db',
      true,
    ).trim();
    if (estado === 'healthy') {
      sana = true;
      break;
    }
  } catch {
    /* el contenedor aún no existe */
  }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('');
if (!sana) abortar('El contenedor de PostgreSQL no llegó a estar sano.', '  Revisa: pnpm db:logs');
ok('base de datos lista en el puerto 5440');

// --- 2. Esquema -------------------------------------------------------------
paso(2, 'Aplicando migraciones…');
correr('pnpm db:migrate');

// --- 3. Corpus --------------------------------------------------------------
paso(3, 'Cargando el corpus de políticas…');
correr('pnpm corpus:cargar');

// --- 4. Datos ---------------------------------------------------------------
paso(4, 'Sembrando las solicitudes sintéticas…');
correr('pnpm datos:sembrar');

// --- 5. Comprobación --------------------------------------------------------
paso(5, 'Comprobando que todo quedó en su sitio…');
correr('pnpm db:verificar');

// ---------------------------------------------------------------------------
console.log('\n  Listo. Arranca la aplicación con:\n\n    pnpm dev\n');
console.log('  API en http://localhost:4000 y frontend en http://localhost:5173\n');

if (clave === '') {
  console.log(
    '  AVISO: no hay OPENROUTER_API_KEY en .env, así que el agente no podrá\n' +
      '  ejecutarse. Todo lo demás —bandeja, indicadores, métricas, corpus—\n' +
      '  funciona sin ella.\n',
  );
} else if (clave.length !== 73) {
  console.log(
    `  AVISO: OPENROUTER_API_KEY tiene ${clave.length} caracteres y deberían ser 73.\n` +
      '  Comprueba que no se hayan pegado dos claves seguidas.\n',
  );
}
