import clsx from 'clsx';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

/**
 * Primitivas de interfaz.
 *
 * Son pocas y deliberadamente poco configurables. Un sistema de diseño con
 * treinta variantes por componente deja de ser un sistema: cada pantalla acaba
 * inventando la suya. Aquí cada variante existe porque significa algo distinto
 * en el dominio, no porque quede bien.
 */

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function Panel({
  titulo,
  descripcion,
  accion,
  children,
  className,
  ...resto
}: {
  titulo?: ReactNode;
  descripcion?: ReactNode;
  accion?: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={clsx('panel shadow-[var(--shadow-panel)] overflow-hidden', className)}
      {...resto}
    >
      {(titulo ?? accion) !== undefined && (
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-borde-suave)] px-4 py-3">
          <div className="min-w-0">
            {titulo !== undefined && (
              <h2 className="truncate text-[13px] font-semibold tracking-wide text-[var(--color-texto)]">
                {titulo}
              </h2>
            )}
            {descripcion !== undefined && (
              <p className="mt-0.5 text-xs text-[var(--color-texto-tenue)]">{descripcion}</p>
            )}
          </div>
          {accion}
        </header>
      )}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Botón
// ---------------------------------------------------------------------------

type TonoBoton = 'primario' | 'secundario' | 'fantasma' | 'peligro';

const TONOS: Record<TonoBoton, string> = {
  // El primario se reserva para la acción que hace avanzar el expediente:
  // analizar, confirmar. Si hubiera dos en pantalla, ninguno sería el primario.
  primario:
    'bg-[var(--color-acento)] text-[#04201c] hover:bg-[var(--color-acento-fuerte)] font-semibold',
  secundario:
    'bg-[var(--color-superficie-elevada)] text-[var(--color-texto)] hover:bg-[var(--color-borde)] border border-[var(--color-borde)]',
  fantasma:
    'text-[var(--color-texto-suave)] hover:text-[var(--color-texto)] hover:bg-[var(--color-superficie-alta)]',
  peligro:
    'bg-transparent text-[var(--color-rechazado)] border border-[var(--color-rechazado)]/40 hover:bg-[var(--color-rechazado-fondo)]',
};

export function Boton({
  tono = 'secundario',
  tamano = 'normal',
  cargando = false,
  children,
  className,
  disabled,
  ...resto
}: {
  tono?: TonoBoton;
  tamano?: 'normal' | 'pequeno';
  cargando?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        tamano === 'pequeno' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-[13px]',
        TONOS[tono],
        className,
      )}
      disabled={disabled === true || cargando}
      {...resto}
    >
      {cargando && (
        <span
          aria-hidden
          className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Etiqueta
// ---------------------------------------------------------------------------

export function Etiqueta({
  color,
  fondo,
  children,
  titulo,
  className,
}: {
  color: string;
  fondo?: string;
  children: ReactNode;
  titulo?: string;
  className?: string;
}) {
  return (
    <span
      title={titulo}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-pastilla)]',
        'px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        className,
      )}
      style={{ color, backgroundColor: fondo ?? 'transparent', border: `1px solid ${color}33` }}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Estados de carga y vacío
// ---------------------------------------------------------------------------

/** Bloque de carga con la forma aproximada del contenido que va a aparecer. */
export function Esqueleto({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'pulso-actividad rounded-md bg-[var(--color-superficie-alta)]',
        className ?? 'h-4 w-full',
      )}
    />
  );
}

export function Vacio({
  titulo,
  descripcion,
  accion,
}: {
  titulo: string;
  descripcion?: string;
  accion?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-[var(--color-texto-suave)]">{titulo}</p>
      {descripcion !== undefined && (
        <p className="max-w-sm text-xs text-[var(--color-texto-tenue)]">{descripcion}</p>
      )}
      {accion}
    </div>
  );
}

export function Error({ mensaje, reintentar }: { mensaje: string; reintentar?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="text-sm text-[var(--color-rechazado)]">{mensaje}</p>
      {reintentar !== undefined && (
        <Boton tamano="pequeno" onClick={reintentar}>
          Reintentar
        </Boton>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dato
// ---------------------------------------------------------------------------

/** Par etiqueta/valor. El valor usa cifras tabulares si es numérico. */
export function Dato({
  etiqueta,
  valor,
  numerico = false,
  ayuda,
  tono,
}: {
  etiqueta: string;
  valor: ReactNode;
  numerico?: boolean;
  ayuda?: string;
  tono?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-wide text-[var(--color-texto-tenue)]" title={ayuda}>
        {etiqueta}
      </dt>
      <dd
        className={clsx('mt-0.5 truncate text-[13px]', numerico && 'cifra')}
        style={tono !== undefined ? { color: tono } : undefined}
      >
        {valor}
      </dd>
    </div>
  );
}
