/**
 * Verificacion del criterio de cierre de M6.
 *
 * El criterio es un banco de consultas donde la excepcion y su regla general se
 * recuperan juntas. Se comprueba ademas lo contrario: que SIN el cierre por
 * excepciones el sistema falla ese caso. Una funcionalidad que no se puede ver
 * fallar cuando se desactiva no esta demostrada.
 */
import { verificarCitas } from './citas.js';
import { indexar, leerCorpus } from './corpus.js';
import { agruparPorPrecedencia, enrutarCategorias, RecuperadorPoliticas } from './recuperacion.js';

interface Comprobacion {
  bloque: string;
  nombre: string;
  ok: boolean;
  detalle: string;
}

const comprobaciones: Comprobacion[] = [];
const afirmar = (bloque: string, nombre: string, ok: boolean, detalle: string) =>
  comprobaciones.push({ bloque, nombre, ok, detalle });

async function main() {
  const recuperador = await RecuperadorPoliticas.cargar();
  const corpus = indexar(await leerCorpus());
  const ids = (fs: { id_politica: string }[]) => fs.map((f) => f.id_politica);

  // =========================================================================
  const A = 'A. Enrutamiento por categoria';

  const casosEnrutado: Array<[string, string]> = [
    ['la razon de endeudamiento supera el limite permitido', 'capacidad_pago'],
    ['que garantia se exige con score de historial bajo', 'garantia'],
    ['quien autoriza una operacion de trescientos mil quetzales', 'autorizacion'],
    ['plazo maximo para capital de trabajo', 'plazo'],
    ['el expediente tiene estados financieros incompletos', 'documentacion'],
    ['a que debe destinarse el credito', 'destino'],
  ];

  for (const [consulta, esperada] of casosEnrutado) {
    const rutas = enrutarCategorias(consulta);
    afirmar(
      A,
      `"${consulta.slice(0, 42)}..." enruta a ${esperada}`,
      rutas.includes(esperada),
      rutas.length === 0 ? 'sin categoria' : rutas.slice(0, 3).join(', '),
    );
  }

  // =========================================================================
  const B = 'B. Recuperacion basica';

  const casosBusqueda: Array<[string, string]> = [
    ['razon de endeudamiento pasivos entre activos', 'POL-2.3'],
    ['cobertura de servicio de deuda minima', 'POL-2.7'],
    ['meses continuos de operacion formal', 'POL-1.2'],
    ['monto maximo sobre las ventas anuales declaradas', 'POL-4.1'],
    ['score de historial y garantia real', 'POL-3.4'],
    ['operacion superior que requiere autorizacion de comite', 'POL-6.2'],
    ['tasa de interes anual de referencia', 'POL-10.1'],
    ['informacion financiera incompleta o inconsistente', 'POL-8.4'],
  ];

  for (const [consulta, esperada] of casosBusqueda) {
    const resultado = recuperador.buscar(consulta);
    const posicion = ids(resultado).indexOf(esperada);
    afirmar(
      B,
      `"${consulta.slice(0, 40)}..." recupera ${esperada}`,
      posicion >= 0 && posicion < 4,
      posicion < 0
        ? `AUSENTE (${ids(resultado).slice(0, 4).join(', ')})`
        : `posicion ${posicion + 1}`,
    );
  }

  // =========================================================================
  // El criterio de cierre del modulo.
  const C = 'C. La excepcion viaja con su regla general';

  const paresExcepcion: Array<[string, string, string]> = [
    ['la razon de endeudamiento excede 0.65', 'POL-2.3', 'POL-7.3'],
    ['el negocio no acredita 24 meses de operacion', 'POL-1.2', 'POL-7.5'],
    ['la cobertura de servicio de deuda es inferior a 1.25', 'POL-2.7', 'POL-7.7'],
  ];

  for (const [consulta, general, excepcion] of paresExcepcion) {
    const obtenidos = ids(recuperador.buscar(consulta));
    const ambas = obtenidos.includes(general) && obtenidos.includes(excepcion);
    afirmar(
      C,
      `${general} llega acompanada de ${excepcion}`,
      ambas,
      ambas
        ? 'ambas presentes'
        : `faltan: ${[general, excepcion].filter((i) => !obtenidos.includes(i)).join(', ')}`,
    );
  }

  // El sentido inverso: partir de la excepcion y arrastrar la regla general.
  const desdeExcepcion = ids(
    recuperador.buscar('se admitira endeudamiento hasta 0.75 con 60 meses y score 80'),
  );
  afirmar(
    C,
    'Partiendo de la excepcion POL-7.3 llega la regla POL-2.3',
    desdeExcepcion.includes('POL-7.3') && desdeExcepcion.includes('POL-2.3'),
    desdeExcepcion.slice(0, 5).join(', '),
  );

  // Donde el cierre demuestra su valor.
  //
  // Con consultas que casi citan la politica ("la razon de endeudamiento
  // excede 0.65"), BM25 ya trae la excepcion por su cuenta y el cierre no
  // aporta nada. El caso realista es otro: el agente formula la consulta desde
  // la SITUACION del solicitante, no copiando el texto de la norma. En cuanto
  // la consulta es una parafrasis, la excepcion se cae del ranking y solo la
  // recupera el cierre.
  const PARAFRASIS = 'el flujo no alcanza para pagar la cuota';

  const parafraseoSin = ids(recuperador.buscar(PARAFRASIS, { expandirExcepciones: false }));
  const parafraseoCon = ids(recuperador.buscar(PARAFRASIS));

  afirmar(
    C,
    'Ante una parafrasis, el ranking lexico pierde la excepcion',
    parafraseoSin.includes('POL-2.7') && !parafraseoSin.includes('POL-7.7'),
    `sin cierre: ${parafraseoSin.slice(0, 4).join(', ')}`,
  );

  afirmar(
    C,
    'El cierre la recupera',
    parafraseoCon.includes('POL-2.7') && parafraseoCon.includes('POL-7.7'),
    `con cierre: ${parafraseoCon.join(', ')}`,
  );

  // Limitacion conocida de BM25 puro, declarada en vez de escondida: sin
  // vocabulario compartido, no hay nada que recuperar. El punto extra M19
  // (mas abajo, bloque F) ataca exactamente esta limitacion con una segunda
  // etapa de reordenamiento; aqui se deja constancia del punto de partida SIN
  // esa etapa, para que la mejora del bloque F sea una comparacion real y no
  // una afirmacion sin numero de referencia.
  const sinVocabulario = ids(
    recuperador.buscar('empresa recien constituida quiere credito', { rerankear: false }),
  );
  afirmar(
    C,
    'Sin reranking, una parafrasis sin vocabulario compartido no recupera la regla',
    !sinVocabulario.includes('POL-1.2'),
    'BM25 puro no relaciona "recien constituida" con "24 meses continuos de operacion".',
  );

  // El enrutamiento no debe ser un filtro: la excepcion vive en otra categoria.
  const conCategoriaDura = recuperador.buscar('razon de endeudamiento excede el limite', {
    categorias: ['capacidad_pago'],
  });
  afirmar(
    C,
    'Aun sesgando a capacidad_pago, la excepcion entra por cierre',
    ids(conCategoriaDura).includes('POL-7.3'),
    `categoria de POL-7.3: ${corpus.get('POL-7.3')?.categoria}`,
  );

  // =========================================================================
  const D = 'D. Precedencia';

  // Se usa la parafrasis: es el caso donde el cierre realmente anade algo.
  const fragmentos = recuperador.buscar(PARAFRASIS);
  const { grupos } = agruparPorPrecedencia(fragmentos);
  const grupo = grupos.find((g) => g.general.id_politica === 'POL-2.7');

  afirmar(
    D,
    'POL-2.7 se agrupa con POL-7.7 como excepcion suya',
    grupo !== undefined && ids(grupo.excepciones).includes('POL-7.7'),
    grupo === undefined
      ? 'sin grupo'
      : `${grupo.general.id_politica} -> ${ids(grupo.excepciones).join(', ')}`,
  );

  afirmar(
    D,
    'La excepcion NO elimina a la regla general del resultado',
    ids(fragmentos).includes('POL-2.7'),
    'la excepcion relaja bajo condiciones, no sustituye: decidir cual gana exige mirar los datos del solicitante',
  );

  const marcadas = fragmentos.filter((f) => f.motivo !== 'coincidencia_lexica');
  afirmar(
    D,
    'Lo que entra por cierre viene marcado con su motivo',
    marcadas.length > 0 && marcadas.every((f) => f.relacionada_con !== undefined),
    marcadas.map((f) => `${f.id_politica}(${f.motivo} via ${f.relacionada_con})`).join(', '),
  );

  // =========================================================================
  const E = 'E. Garantias del resultado';

  const a = recuperador.buscar('cobertura de servicio de deuda y garantia hipotecaria');
  const b = recuperador.buscar('cobertura de servicio de deuda y garantia hipotecaria');
  afirmar(
    E,
    'Dos busquedas identicas devuelven exactamente lo mismo',
    JSON.stringify(a) === JSON.stringify(b),
    `${a.length} fragmentos, orden estable`,
  );

  // Todo lo que devuelve la recuperacion tiene que pasar G1. Si el recuperador
  // alterara el texto —recortandolo, normalizandolo, resumiendolo— las citas
  // que construya el agente sobre el dejarian de ser literales.
  const todas = [
    ...recuperador.buscar('endeudamiento'),
    ...recuperador.buscar('garantia score historial'),
    ...recuperador.buscar('autorizacion comite monto'),
  ];
  const veredicto = verificarCitas(
    todas.map((f) => ({
      id_politica: f.id_politica,
      seccion: f.seccion,
      texto_literal: f.texto_literal,
    })),
    corpus,
  );
  afirmar(
    E,
    'Todo fragmento devuelto pasa la verificacion de G1',
    veredicto.todasVerificadas,
    `${todas.length} fragmentos verificados literalmente contra el corpus`,
  );

  // Sin ningun termino del corpus. Ojo: "sin" y "no" SI son terminos del
  // corpus y se conservan a proposito, porque en un texto normativo la
  // negacion cambia el sentido de la regla.
  const vacia = recuperador.buscar('xyzzy plugh frobnicate');
  afirmar(
    E,
    'Una consulta sin coincidencias devuelve vacio, no ruido',
    vacia.length === 0,
    `${vacia.length} fragmentos`,
  );

  afirmar(
    E,
    'El corpus completo sigue disponible para la estrategia de comparacion',
    recuperador.todas().length === recuperador.tamanoCorpus,
    `${recuperador.tamanoCorpus} politicas en el indice`,
  );

  // =========================================================================
  // Punto extra 5.4: reordenamiento (reranking) sobre los fragmentos
  // recuperados, con evidencia medida de que mejora la precision de las citas.
  //
  // Los tres casos son parafrasis que un solicitante real escribiria, sin
  // vocabulario compartido con el texto de la politica que deberian activar.
  // Cada uno se mide dos veces, con la MISMA consulta: sin reordenamiento
  // (linea base BM25 pura) y con el (rerankear por defecto). La comparacion,
  // no la afirmacion, es la evidencia que pide el enunciado.
  const F = 'F. Reordenamiento conceptual (M19, punto extra 5.4)';

  const casosRerank: Array<[string, string, string]> = [
    [
      'empresa recien constituida quiere credito',
      'POL-1.2',
      'antiguedad del negocio (24 meses continuos)',
    ],
    [
      'el negocio no tiene nada que ofrecer como respaldo del prestamo',
      'POL-3.9',
      'operaciones sin garantia alguna',
    ],
    [
      'el rubro al que se dedica el negocio esta prohibido',
      'POL-5.1',
      'sectores restringidos',
    ],
  ];

  for (const [consulta, esperada, descripcion] of casosRerank) {
    const sinRerank = ids(recuperador.buscar(consulta, { rerankear: false }));
    const conRerank = ids(recuperador.buscar(consulta, { rerankear: true }));
    const ausenteSinRerank = !sinRerank.includes(esperada);
    const presenteConRerank = conRerank.includes(esperada);

    afirmar(
      F,
      `SIN rerank, "${consulta.slice(0, 38)}..." no recupera ${esperada} (${descripcion})`,
      ausenteSinRerank,
      `BM25 puro: ${sinRerank.join(', ') || '(vacio)'}`,
    );
    afirmar(
      F,
      `CON rerank, la misma consulta SI recupera ${esperada}`,
      presenteConRerank,
      `posicion ${conRerank.indexOf(esperada) + 1} de ${conRerank.length}: ${conRerank.join(', ')}`,
    );
  }

  // El reordenamiento no debe alterar el texto de los fragmentos: sigue
  // teniendo que pasar G1 igual que la recuperacion base.
  const todosConRerank = casosRerank.flatMap(([consulta]) => recuperador.buscar(consulta));
  const veredictoRerank = verificarCitas(
    todosConRerank.map((f) => ({
      id_politica: f.id_politica,
      seccion: f.seccion,
      texto_literal: f.texto_literal,
    })),
    corpus,
  );
  afirmar(
    F,
    'Los fragmentos reordenados siguen pasando la verificacion de G1',
    veredictoRerank.todasVerificadas,
    `${todosConRerank.length} fragmentos verificados literalmente contra el corpus`,
  );

  // El reordenamiento no debe degradar lo que BM25 ya resolvia bien: sobre
  // consultas que citan casi literalmente la politica, el resultado con y sin
  // rerank debe coincidir en el primer puesto.
  let establesSinRegresion = 0;
  for (const [consulta, esperada] of casosBusqueda) {
    const con = recuperador.buscar(consulta, { rerankear: true });
    if (con[0]?.id_politica === esperada) establesSinRegresion += 1;
  }
  afirmar(
    F,
    'El reordenamiento no degrada los casos que BM25 ya resolvia en primer puesto',
    establesSinRegresion === casosBusqueda.length,
    `${establesSinRegresion}/${casosBusqueda.length} casos del bloque B mantienen su politica en la posicion 1`,
  );

  // =========================================================================
  const ancho = Math.max(...comprobaciones.map((c) => c.nombre.length));
  let bloque = '';
  console.log('\nVerificacion de la recuperacion de politicas (M6)');
  for (const c of comprobaciones) {
    if (c.bloque !== bloque) {
      bloque = c.bloque;
      console.log(`\n  ${bloque}`);
    }
    console.log(`    ${c.ok ? 'OK   ' : 'FALLA'} ${c.nombre.padEnd(ancho)}  ${c.detalle}`);
  }
  const fallos = comprobaciones.filter((c) => !c.ok).length;
  console.log(
    `\n  ${comprobaciones.length - fallos}/${comprobaciones.length} comprobaciones correctas\n`,
  );
  if (fallos > 0) process.exit(1);
}

await main();
