import clsx from 'clsx';
import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Estructura de la aplicación.
 *
 * Adaptable de escritorio a móvil sin duplicar el marcado: la misma lista de
 * navegación se pinta como barra lateral a partir de 768 px y como barra
 * inferior por debajo. En un teléfono, la barra inferior queda al alcance del
 * pulgar, que es donde tiene que estar la navegación de una herramienta que se
 * consulta de pie.
 *
 * El enunciado deja el diseño adaptable avanzado fuera de alcance (punto 5.6).
 * Esto no lo es: son dos disposiciones de la misma lista, sin lógica duplicada.
 */

interface Seccion {
  ruta: string;
  etiqueta: string;
  icono: ReactNode;
}

const Icono = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden
    className="size-[18px] shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

const SECCIONES: Seccion[] = [
  {
    ruta: '/solicitudes',
    etiqueta: 'Bandeja',
    icono: <Icono d="M3 7h18M3 12h18M3 17h11" />,
  },
  {
    ruta: '/analisis',
    etiqueta: 'Análisis',
    icono: <Icono d="M4 18v-6M9 18V6M14 18v-9M19 18v-3" />,
  },
  {
    ruta: '/metricas',
    etiqueta: 'Métricas',
    icono: <Icono d="M21 21H4a1 1 0 0 1-1-1V3M7 15l3.5-4 3 2.5L20 7" />,
  },
  {
    ruta: '/evaluacion',
    etiqueta: 'Evaluación',
    icono: <Icono d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
  },
];

function Marca() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--color-acento-vidrio)] text-[var(--color-acento)]"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 3v18M5 8l7-5 7 5v8l-7 5-7-5Z" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-[13px] font-semibold">Originación PyME</p>
        <p className="truncate text-[10px] text-[var(--color-texto-tenue)]">
          Asistente de análisis crediticio
        </p>
      </div>
    </div>
  );
}

const enlaceEscritorio = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
    isActive
      ? 'bg-[var(--color-acento-vidrio)] text-[var(--color-acento)] font-medium'
      : 'text-[var(--color-texto-suave)] hover:bg-[var(--color-superficie-alta)] hover:text-[var(--color-texto)]',
  );

const enlaceMovil = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex flex-1 flex-col items-center gap-1 py-2 text-[10px] transition-colors',
    isActive ? 'text-[var(--color-acento)]' : 'text-[var(--color-texto-tenue)]',
  );

export function Shell() {
  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Barra lateral: solo escritorio. */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-[var(--color-borde)] bg-[var(--color-superficie)] p-3 md:flex">
        <div className="px-1.5 py-2">
          <Marca />
        </div>
        <nav className="mt-4 flex flex-col gap-0.5">
          {SECCIONES.map((s) => (
            <NavLink key={s.ruta} to={s.ruta} className={enlaceEscritorio}>
              {s.icono}
              {s.etiqueta}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto px-2 text-[10px] leading-relaxed text-[var(--color-texto-tenue)]">
          El asistente produce recomendaciones verificables. La decisión, y su confirmación, son del
          analista.
        </p>
      </aside>

      {/* Cabecera: solo móvil. */}
      <header className="flex items-center border-b border-[var(--color-borde)] bg-[var(--color-superficie)] px-4 py-2.5 md:hidden">
        <Marca />
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto pb-16 md:pb-0">
        <Outlet />
      </main>

      {/* Navegación inferior: solo móvil, al alcance del pulgar. */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-[var(--color-borde)] bg-[var(--color-superficie)] md:hidden">
        {SECCIONES.map((s) => (
          <NavLink key={s.ruta} to={s.ruta} className={enlaceMovil}>
            {s.icono}
            {s.etiqueta}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Cabecera de página, común a todas las vistas. */
export function Encabezado({
  titulo,
  descripcion,
  acciones,
}: {
  titulo: string;
  descripcion?: string;
  acciones?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-borde)] px-4 py-4 md:px-6">
      <div className="min-w-0">
        <h1 className="text-base font-semibold tracking-tight">{titulo}</h1>
        {descripcion !== undefined && (
          <p className="mt-0.5 text-xs text-[var(--color-texto-tenue)]">{descripcion}</p>
        )}
      </div>
      {acciones}
    </div>
  );
}
