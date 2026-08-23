import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ETIQUETA_SECTOR, sectorSchema, type Sector } from '@aop/shared';
import { Encabezado } from '../app/Shell.js';
import { Confianza, EtiquetaDecision, EtiquetaEstado, fecha, moneda } from '../diseno/dominio.js';
import { Boton, Error as ErrorVista, Esqueleto, Panel, Vacio } from '../diseno/primitivas.js';
import { api, type FilaBandeja } from '../lib/api.js';

/**
 * Bandeja de solicitudes.
 *
 * Es la pantalla donde el analista pasa la mayor parte del tiempo, así que la
 * jerarquía la manda el trabajo pendiente: lo que espera confirmación se ve
 * primero y se distingue sin leer.
 *
 * En móvil la tabla se convierte en tarjetas. No es una tabla con scroll
 * horizontal: una fila de nueve columnas en una pantalla de 375 px no se lee,
 * se adivina.
 */

const ESTADOS = [
  { valor: '', etiqueta: 'Todas' },
  { valor: 'PENDIENTE_AUTORIZACION', etiqueta: 'Pendientes' },
  { valor: 'EN_FIRME', etiqueta: 'En firme' },
  { valor: 'SIN_DICTAMEN', etiqueta: 'Sin analizar' },
] as const;

const POR_PAGINA = 25;

export function Bandeja() {
  const [estado, setEstado] = useState<string>('');
  const [sector, setSector] = useState<string>('');
  const [busqueda, setBusqueda] = useState('');
  const [pagina, setPagina] = useState(0);

  const consulta = useQuery({
    queryKey: ['bandeja', estado, sector, busqueda, pagina],
    queryFn: () =>
      api.bandeja({
        estado: estado || undefined,
        sector: sector || undefined,
        busqueda: busqueda || undefined,
        limite: POR_PAGINA,
        desplazamiento: pagina * POR_PAGINA,
      }),
  });

  const cambiarFiltro = (accion: () => void) => {
    accion();
    setPagina(0);
  };

  const total = consulta.data?.total ?? 0;
  const paginas = Math.ceil(total / POR_PAGINA);

  return (
    <>
      <Encabezado
        titulo="Bandeja de solicitudes"
        descripcion={
          consulta.data
            ? `${total} solicitudes${estado !== '' ? ' con el filtro aplicado' : ' en cartera'}`
            : 'Cargando cartera…'
        }
      />

      <div className="flex flex-wrap gap-2 px-4 py-3 md:px-6">
        <div className="flex flex-wrap gap-1">
          {ESTADOS.map((e) => (
            <Boton
              key={e.valor}
              tamano="pequeno"
              tono={estado === e.valor ? 'primario' : 'fantasma'}
              onClick={() => cambiarFiltro(() => setEstado(e.valor))}
            >
              {e.etiqueta}
            </Boton>
          ))}
        </div>

        <select
          value={sector}
          onChange={(e) => cambiarFiltro(() => setSector(e.target.value))}
          aria-label="Filtrar por sector"
          className="rounded-lg border border-[var(--color-borde)] bg-[var(--color-superficie-elevada)] px-2.5 py-1 text-xs"
        >
          <option value="">Todos los sectores</option>
          {sectorSchema.options.map((s: Sector) => (
            <option key={s} value={s}>
              {ETIQUETA_SECTOR[s]}
            </option>
          ))}
        </select>

        <input
          value={busqueda}
          onChange={(e) => cambiarFiltro(() => setBusqueda(e.target.value))}
          placeholder="Buscar empresa…"
          aria-label="Buscar por nombre de empresa"
          className="min-w-40 flex-1 rounded-lg border border-[var(--color-borde)] bg-[var(--color-superficie-elevada)] px-2.5 py-1 text-xs placeholder:text-[var(--color-texto-tenue)]"
        />
      </div>

      <div className="px-4 pb-6 md:px-6">
        <Panel>
          {consulta.isPending && (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 6 }, (_, i) => (
                <Esqueleto key={i} className="h-11 w-full" />
              ))}
            </div>
          )}

          {consulta.isError && (
            <ErrorVista
              mensaje={(consulta.error as Error).message}
              reintentar={() => void consulta.refetch()}
            />
          )}

          {consulta.data && consulta.data.solicitudes.length === 0 && (
            <Vacio
              titulo="No hay solicitudes con esos filtros"
              descripcion="Prueba a quitar el filtro de estado o el de sector."
            />
          )}

          {consulta.data && consulta.data.solicitudes.length > 0 && (
            <>
              {/* Escritorio */}
              <table className="hidden w-full md:table">
                <thead>
                  <tr className="border-b border-[var(--color-borde-suave)] text-left text-[11px] text-[var(--color-texto-tenue)]">
                    <th className="px-4 py-2 font-medium">Empresa</th>
                    <th className="px-4 py-2 font-medium">Solicitado</th>
                    <th className="px-4 py-2 font-medium">Recomendado</th>
                    <th className="px-4 py-2 font-medium">Dictamen</th>
                    <th className="px-4 py-2 font-medium">Estado</th>
                    <th className="px-4 py-2 font-medium">Confianza</th>
                    <th className="px-4 py-2 font-medium">Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {consulta.data.solicitudes.map((s) => (
                    <Fila key={s.id_solicitud} solicitud={s} />
                  ))}
                </tbody>
              </table>

              {/* Móvil */}
              <ul className="divide-y divide-[var(--color-borde-suave)] md:hidden">
                {consulta.data.solicitudes.map((s) => (
                  <Tarjeta key={s.id_solicitud} solicitud={s} />
                ))}
              </ul>
            </>
          )}
        </Panel>

        {paginas > 1 && (
          <div className="mt-3 flex items-center justify-between text-xs text-[var(--color-texto-tenue)]">
            <span className="cifra">
              Página {pagina + 1} de {paginas}
            </span>
            <div className="flex gap-1.5">
              <Boton
                tamano="pequeno"
                disabled={pagina === 0}
                onClick={() => setPagina((p) => p - 1)}
              >
                Anterior
              </Boton>
              <Boton
                tamano="pequeno"
                disabled={pagina + 1 >= paginas}
                onClick={() => setPagina((p) => p + 1)}
              >
                Siguiente
              </Boton>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Fila({ solicitud: s }: { solicitud: FilaBandeja }) {
  return (
    <tr className="border-b border-[var(--color-borde-suave)] transition-colors last:border-0 hover:bg-[var(--color-superficie-alta)]">
      <td className="px-4 py-2.5">
        <Link to={`/solicitudes/${s.id_solicitud}`} className="block min-w-0">
          <p className="truncate text-[13px] font-medium">{s.nombre_empresa}</p>
          <p className="text-[11px] text-[var(--color-texto-tenue)]">
            {ETIQUETA_SECTOR[s.sector as Sector] ?? s.sector} · {s.meses_operacion} meses
          </p>
        </Link>
      </td>
      <td className="cifra px-4 py-2.5 text-[13px]">{moneda(s.monto_solicitado)}</td>
      <td className="cifra px-4 py-2.5 text-[13px]">{moneda(s.monto_recomendado)}</td>
      <td className="px-4 py-2.5">
        <EtiquetaDecision decision={s.decision} />
      </td>
      <td className="px-4 py-2.5">
        <EtiquetaEstado estado={s.estado} />
      </td>
      <td className="px-4 py-2.5">
        {s.confianza !== null ? <Confianza valor={Number(s.confianza)} /> : '—'}
      </td>
      <td className="px-4 py-2.5 text-[12px] text-[var(--color-texto-tenue)]">
        {fecha(s.fecha_solicitud)}
      </td>
    </tr>
  );
}

function Tarjeta({ solicitud: s }: { solicitud: FilaBandeja }) {
  return (
    <li>
      <Link
        to={`/solicitudes/${s.id_solicitud}`}
        className="block px-4 py-3 active:bg-[var(--color-superficie-alta)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">{s.nombre_empresa}</p>
            <p className="text-[11px] text-[var(--color-texto-tenue)]">
              {ETIQUETA_SECTOR[s.sector as Sector] ?? s.sector} · {fecha(s.fecha_solicitud)}
            </p>
          </div>
          <EtiquetaDecision decision={s.decision} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="cifra text-[12px] text-[var(--color-texto-suave)]">
            {moneda(s.monto_solicitado)}
            {s.monto_recomendado !== null && (
              <span className="text-[var(--color-texto-tenue)]">
                {' → '}
                {moneda(s.monto_recomendado)}
              </span>
            )}
          </p>
          <EtiquetaEstado estado={s.estado} />
        </div>
      </Link>
    </li>
  );
}
