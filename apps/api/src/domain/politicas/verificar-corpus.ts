/**
 * Verificacion del criterio de cierre de M3.
 *
 * Dos bloques independientes:
 *
 *   A. Integridad del corpus. Comprueba que cumple lo que el punto 5.2.2 exige
 *      y, sobre todo, que la laguna deliberada SIGUE siendo una laguna: es
 *      facil taparla sin querer al anadir politicas, y si se tapa deja de
 *      poder ejercitarse la ruta de escalamiento.
 *
 *   B. Verificacion de citas. Es el test que el modulo exige: demuestra que el
 *      verificador acepta lo literal y rechaza lo inventado. Sin este bloque,
 *      G1 seria una promesa en el README.
 */
import type { CitaPolitica } from '@aop/shared';
import { pool, cerrarPool } from '../../db/pool.js';
import { verificarCita, verificarCitas, type MotivoRechazo } from './citas.js';
import { indexar, leerCorpus } from './corpus.js';

interface Comprobacion {
  bloque: string;
  nombre: string;
  ok: boolean;
  detalle: string;
}

const comprobaciones: Comprobacion[] = [];

function afirmar(bloque: string, nombre: string, ok: boolean, detalle: string) {
  comprobaciones.push({ bloque, nombre, ok, detalle });
}

/** La cita debe pasar la verificacion. */
function citaValida(
  nombre: string,
  cita: CitaPolitica,
  corpus: Parameters<typeof verificarCita>[1],
) {
  const v = verificarCita(cita, corpus);
  afirmar('B. Citas', nombre, v.verificada, v.verificada ? 'aceptada' : `rechazada: ${v.motivo}`);
}

/** La cita debe ser rechazada, y por el motivo concreto que se espera. */
function citaInvalida(
  nombre: string,
  cita: CitaPolitica,
  corpus: Parameters<typeof verificarCita>[1],
  motivoEsperado: MotivoRechazo,
) {
  const v = verificarCita(cita, corpus);
  const ok = !v.verificada && v.motivo === motivoEsperado;
  afirmar(
    'B. Citas',
    nombre,
    ok,
    v.verificada
      ? 'ACEPTADA cuando deberia haberse rechazado'
      : `rechazada por ${v.motivo}${v.motivo === motivoEsperado ? '' : ` (se esperaba ${motivoEsperado})`}`,
  );
}

async function main() {
  const corpus = await leerCorpus();
  const indice = indexar(corpus);

  // =========================================================================
  // A. Integridad del corpus
  // =========================================================================
  const B = 'A. Corpus';

  afirmar(
    B,
    'Al menos 25 politicas',
    corpus.politicas.length >= 25,
    `${corpus.politicas.length} politicas`,
  );

  const excepciones = corpus.politicas.filter((p) => p.modifica_a.length > 0);
  afirmar(
    B,
    'Al menos 2 excepciones que modifican una regla anterior',
    excepciones.length >= 2,
    excepciones.map((e) => `${e.id}->${e.modifica_a.join(',')}`).join('  '),
  );

  const referenciasRotas = excepciones.flatMap((e) =>
    e.modifica_a.filter((destino) => !indice.has(destino)).map((d) => `${e.id}->${d}`),
  );
  afirmar(
    B,
    'Toda excepcion apunta a una politica existente',
    referenciasRotas.length === 0,
    referenciasRotas.length === 0 ? 'sin referencias rotas' : referenciasRotas.join(', '),
  );

  const categoriasUsadas = new Set(corpus.politicas.map((p) => p.categoria));
  const noDeclaradas = [...categoriasUsadas].filter((c) => !(c in corpus.categorias));
  afirmar(
    B,
    'Toda categoria usada esta declarada',
    noDeclaradas.length === 0,
    noDeclaradas.length === 0
      ? `${categoriasUsadas.size} categorias en uso`
      : `sin declarar: ${noDeclaradas.join(', ')}`,
  );

  afirmar(
    B,
    'La recuperacion tiene categorias suficientes que discriminar',
    categoriasUsadas.size >= 5,
    `${categoriasUsadas.size} categorias distintas`,
  );

  afirmar(
    B,
    'Identificadores unicos',
    indice.size === corpus.politicas.length,
    `${indice.size} identificadores para ${corpus.politicas.length} politicas`,
  );

  // La laguna deliberada. Si alguna politica llegara a regular la ausencia de
  // score, el caso de escalamiento por falta de politica aplicable dejaria de
  // existir y el banco de evaluacion de M18 se quedaria sin uno de sus casos.
  const mencionaScoreAusente = corpus.politicas.filter((p) =>
    /sin (score|historial)|score (desconocido|no disponible|ausente)|sin historial crediticio/i.test(
      p.texto,
    ),
  );
  afirmar(
    B,
    'La laguna deliberada sigue abierta (nadie regula el score ausente)',
    mencionaScoreAusente.length === 0,
    mencionaScoreAusente.length === 0
      ? 'ninguna politica cubre la ausencia de score'
      : `la cubren: ${mencionaScoreAusente.map((p) => p.id).join(', ')}`,
  );

  // =========================================================================
  // B. Verificacion de citas
  // =========================================================================
  const pol23 = indice.get('POL-2.3')!;
  const pol41 = indice.get('POL-4.1')!;

  citaValida(
    'Cita literal completa',
    { id_politica: 'POL-2.3', seccion: pol23.seccion, texto_literal: pol23.texto },
    indice,
  );

  citaValida(
    'Fragmento contiguo de la politica',
    {
      id_politica: 'POL-2.3',
      seccion: pol23.seccion,
      texto_literal: 'no podra exceder 0.65 para solicitantes sin garantia hipotecaria',
    },
    indice,
  );

  citaValida(
    'Tildes anadidas por el modelo',
    {
      id_politica: 'POL-2.3',
      seccion: pol23.seccion,
      texto_literal:
        'La razón de endeudamiento, calculada como pasivos totales entre activos totales',
    },
    indice,
  );

  citaValida(
    'Saltos de linea y espacios alterados',
    {
      id_politica: 'POL-4.1',
      seccion: pol41.seccion,
      texto_literal:
        '  El monto aprobado no podra superar\n   el 30 por ciento\tde las ventas anuales  ',
    },
    indice,
  );

  citaInvalida(
    'Numero alterado: 0.65 pasa a 0.75',
    {
      id_politica: 'POL-2.3',
      seccion: pol23.seccion,
      texto_literal:
        'La razon de endeudamiento no podra exceder 0.75 para solicitantes sin garantia',
    },
    indice,
    'texto_no_literal',
  );

  citaInvalida(
    'Politica completamente inventada',
    {
      id_politica: 'POL-2.3',
      seccion: pol23.seccion,
      texto_literal: 'Se aprobaran automaticamente las solicitudes de clientes recurrentes.',
    },
    indice,
    'texto_no_literal',
  );

  citaInvalida(
    'Identificador que no existe en el corpus',
    {
      id_politica: 'POL-99.1',
      seccion: '99.1 Inventada',
      texto_literal: 'Cualquier texto suficientemente largo para pasar el minimo.',
    },
    indice,
    'politica_inexistente',
  );

  citaInvalida(
    'Texto literal atribuido a la politica equivocada',
    { id_politica: 'POL-4.1', seccion: pol41.seccion, texto_literal: pol23.texto },
    indice,
    'texto_no_literal',
  );

  citaInvalida(
    'Cita demasiado corta para sustentar nada',
    { id_politica: 'POL-2.3', seccion: pol23.seccion, texto_literal: 'la razon' },
    indice,
    'cita_demasiado_corta',
  );

  citaInvalida(
    'Seccion que no corresponde a la politica',
    {
      id_politica: 'POL-2.3',
      seccion: '9.9 Otra seccion cualquiera',
      texto_literal: pol23.texto,
    },
    indice,
    'seccion_no_coincide',
  );

  const sinCitas = verificarCitas([], indice);
  afirmar(
    'B. Citas',
    'Un dictamen sin ninguna cita no se da por verificado',
    !sinCitas.todasVerificadas,
    sinCitas.todasVerificadas ? 'se dio por bueno' : 'rechazado, como exige G1',
  );

  const mezcla = verificarCitas(
    [
      { id_politica: 'POL-2.3', seccion: pol23.seccion, texto_literal: pol23.texto },
      {
        id_politica: 'POL-4.1',
        seccion: pol41.seccion,
        texto_literal: 'texto que nadie escribio jamas',
      },
    ],
    indice,
  );
  afirmar(
    'B. Citas',
    'Una sola cita invalida invalida el conjunto',
    !mezcla.todasVerificadas,
    `${mezcla.veredictos.filter((v) => v.verificada).length} de 2 verificadas`,
  );

  // =========================================================================
  // C. Coherencia entre el JSON, la base de datos y los parametros
  // =========================================================================
  const C = 'C. Base de datos';
  const { rows: enBd } = await pool.query<{ id: string; texto: string; seccion: string }>(
    'SELECT id, texto, seccion FROM politicas',
  );

  afirmar(
    C,
    'La base de datos tiene las mismas politicas que el JSON',
    enBd.length === corpus.politicas.length,
    `${enBd.length} en base de datos, ${corpus.politicas.length} en el archivo`,
  );

  const divergentes = enBd.filter((f) => indice.get(f.id)?.texto !== f.texto);
  afirmar(
    C,
    'El texto cargado es identico al del archivo',
    divergentes.length === 0,
    divergentes.length === 0
      ? 'sin divergencias'
      : `divergen: ${divergentes.map((d) => d.id).join(', ')}`,
  );

  const { rows: parametros } = await pool.query<{
    clave: string;
    valor: string;
    id_politica: string | null;
  }>('SELECT clave, valor, id_politica FROM parametros_politica ORDER BY clave');
  const valor = (clave: string) => parametros.find((p) => p.clave === clave)?.valor;

  // Los umbrales del corpus y los que aplican G3 y G4 tienen que ser el mismo
  // numero. Si se separan, el sistema citaria una politica y aplicaria otra.
  afirmar(
    C,
    'El tope de POL-4.1 coincide con el parametro que aplica G3',
    Number(valor('tope_absoluto_monto')) === 500000 &&
      Number(valor('porcentaje_ventas_max')) === 0.3,
    `tope=${valor('tope_absoluto_monto')}  porcentaje=${valor('porcentaje_ventas_max')}`,
  );

  afirmar(
    C,
    'El umbral de POL-6.2 coincide con el parametro que aplica G4',
    Number(valor('umbral_autorizacion_comite')) === 250000,
    `umbral=${valor('umbral_autorizacion_comite')}`,
  );

  afirmar(
    C,
    'Cada parametro esta vinculado a la politica que lo respalda',
    parametros.every((p) => p.id_politica !== null),
    parametros.map((p) => `${p.clave}->${p.id_politica ?? 'SIN VINCULO'}`).join('  '),
  );

  // =========================================================================
  const ancho = Math.max(...comprobaciones.map((c) => c.nombre.length));
  let bloqueActual = '';
  console.log('\nVerificacion del corpus de politicas (M3)');
  for (const c of comprobaciones) {
    if (c.bloque !== bloqueActual) {
      bloqueActual = c.bloque;
      console.log(`\n  ${bloqueActual}`);
    }
    console.log(`    ${c.ok ? 'OK   ' : 'FALLA'} ${c.nombre.padEnd(ancho)}  ${c.detalle}`);
  }

  const fallos = comprobaciones.filter((c) => !c.ok).length;
  console.log(
    `\n  ${comprobaciones.length - fallos}/${comprobaciones.length} comprobaciones correctas\n`,
  );
  await cerrarPool();
  if (fallos > 0) process.exit(1);
}

await main();
