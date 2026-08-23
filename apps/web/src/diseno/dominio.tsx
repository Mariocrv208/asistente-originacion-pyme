import { Etiqueta } from './primitivas.js';

/**
 * Representación visual del vocabulario del dominio.
 *
 * Vive aparte de las primitivas porque no es diseño genérico: es la traducción
 * de las decisiones de crédito a color y palabra, y tiene que ser idéntica en
 * la bandeja, en el detalle, en el panel del dictamen y en las métricas. Un
 * ESCALADO_A_COMITE que fuera ámbar en una pantalla y gris en otra obligaría al
 * analista a releer en vez de reconocer.
 */

const DECISION = {
  APROBADO: {
    texto: 'Aprobado',
    color: 'var(--color-aprobado)',
    fondo: 'var(--color-aprobado-fondo)',
  },
  RECHAZADO: {
    texto: 'Rechazado',
    color: 'var(--color-rechazado)',
    fondo: 'var(--color-rechazado-fondo)',
  },
  ESCALADO_A_COMITE: {
    texto: 'Escalado a comité',
    color: 'var(--color-escalado)',
    fondo: 'var(--color-escalado-fondo)',
  },
} as const;

const ESTADO = {
  PENDIENTE_AUTORIZACION: {
    texto: 'Pendiente de confirmación',
    color: 'var(--color-pendiente)',
    ayuda: 'Es una recomendación. No surte efecto hasta que un analista la confirme.',
  },
  EN_FIRME: {
    texto: 'En firme',
    color: 'var(--color-firme)',
    ayuda: 'Confirmado por un analista. El contenido ya no es modificable.',
  },
  ANULADO: { texto: 'Anulado', color: 'var(--color-anulado)', ayuda: 'Dictamen sin efecto.' },
  SIN_DICTAMEN: {
    texto: 'Sin analizar',
    color: 'var(--color-texto-tenue)',
    ayuda: 'Todavía no se ha ejecutado el asistente sobre esta solicitud.',
  },
} as const;

const RIESGO = {
  BAJO: { color: 'var(--color-riesgo-bajo)' },
  MEDIO: { color: 'var(--color-riesgo-medio)' },
  ALTO: { color: 'var(--color-riesgo-alto)' },
} as const;

export function EtiquetaDecision({ decision }: { decision: keyof typeof DECISION | null }) {
  if (decision === null || !(decision in DECISION)) {
    return <Etiqueta color="var(--color-texto-tenue)">Sin dictamen</Etiqueta>;
  }
  const d = DECISION[decision];
  return (
    <Etiqueta color={d.color} fondo={d.fondo}>
      {d.texto}
    </Etiqueta>
  );
}

export function EtiquetaEstado({ estado }: { estado: keyof typeof ESTADO | null }) {
  const e = ESTADO[estado ?? 'SIN_DICTAMEN'] ?? ESTADO.SIN_DICTAMEN;
  return (
    <Etiqueta color={e.color} titulo={e.ayuda}>
      {e.texto}
    </Etiqueta>
  );
}

export function EtiquetaRiesgo({ nivel }: { nivel: keyof typeof RIESGO | null }) {
  if (nivel === null) return null;
  return <Etiqueta color={RIESGO[nivel].color}>Riesgo {nivel.toLowerCase()}</Etiqueta>;
}

/**
 * Indicador de confianza.
 *
 * El enunciado pide comunicar el nivel de confianza. Se muestra como barra y
 * como número: la barra se lee de un vistazo en una lista, el número importa
 * cuando el analista tiene que justificar por qué revisó un expediente.
 *
 * Por debajo de 0.3 se marca en rojo, porque es el rango donde vive la salida
 * degradada que construye el servidor cuando el modelo falla.
 */
export function Confianza({ valor }: { valor: number }) {
  const pct = Math.round(valor * 100);
  const color =
    valor < 0.3
      ? 'var(--color-rechazado)'
      : valor < 0.7
        ? 'var(--color-escalado)'
        : 'var(--color-aprobado)';

  return (
    <div
      className="flex items-center gap-2"
      title={`Confianza declarada por el asistente: ${pct}%`}
    >
      <div
        className="h-1 w-14 overflow-hidden rounded-full bg-[var(--color-superficie-elevada)]"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Confianza"
      >
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="cifra text-[11px]" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

const QUETZAL = new Intl.NumberFormat('es-GT', {
  style: 'currency',
  currency: 'GTQ',
  minimumFractionDigits: 2,
});

/**
 * Los importes llegan como cadena decimal desde la API y se formatean para
 * mostrarlos. La conversión a number ocurre SOLO aquí, en el último paso antes
 * de pintar, y nunca antes: en todo el trayecto anterior el valor es exacto.
 */
export function moneda(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return '—';
  return QUETZAL.format(Number(valor));
}

/** Razones financieras: cuatro decimales, que es como se comparan contra las políticas. */
export function razon(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return 'no calculable';
  return Number(valor).toFixed(4);
}

export function fecha(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return '—';
  return new Date(valor).toLocaleDateString('es-GT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function fechaHora(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return '—';
  return new Date(valor).toLocaleString('es-GT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
