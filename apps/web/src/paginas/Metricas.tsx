import { useQuery } from '@tanstack/react-query';
import { ETIQUETA_SECTOR, type Sector } from '@aop/shared';
import { Encabezado } from '../app/Shell.js';
import { moneda } from '../diseno/dominio.js';
import { Error as ErrorVista, Esqueleto, Panel } from '../diseno/primitivas.js';
import { api, type Metricas as MetricasApi } from '../lib/api.js';

/**
 * Vista de métricas (punto 5.3.8).
 *
 * Los tres indicadores exigidos —solicitudes por estado, monto promedio
 * recomendado y tasa de escalamiento— más el desglose por sector.
 *
 * El enunciado avisa de que la interfaz no debe parecer un tablero de
 * inteligencia de negocios. Por eso cada número lleva su lectura al lado: lo
 * que le sirve al analista no es "21 %" sino "una de cada cinco necesita
 * comité". Un número sin interpretación obliga a interpretarlo cada vez.
 */

export function Metricas() {
  const consulta = useQuery({ queryKey: ['metricas'], queryFn: api.metricas });

  return (
    <>
      <Encabezado
        titulo="Métricas de cartera"
        descripcion="Estado del trabajo dictaminado hasta ahora"
      />

      <div className="px-4 py-4 md:px-6">
        {consulta.isPending && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Esqueleto key={i} className="h-28 w-full" />
            ))}
          </div>
        )}

        {consulta.isError && (
          <ErrorVista
            mensaje={(consulta.error as Error).message}
            reintentar={() => void consulta.refetch()}
          />
        )}

        {consulta.data && <Contenido m={consulta.data} />}
      </div>
    </>
  );
}

function Contenido({ m }: { m: MetricasApi }) {
  const pendientes = m.solicitudes_procesadas_por_estado.PENDIENTE_AUTORIZACION ?? 0;
  const enFirme = m.solicitudes_procesadas_por_estado.EN_FIRME ?? 0;
  const sinAnalizar = m.solicitudes_procesadas_por_estado.SIN_DICTAMEN ?? 0;
  const tasa = m.tasa_escalamiento;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Indicador
          titulo="Pendientes de confirmación"
          valor={String(pendientes)}
          lectura={
            pendientes === 0
              ? 'No hay nada esperando al analista.'
              : `${pendientes} recomendaciones esperan la confirmación de un analista para surtir efecto.`
          }
          tono="var(--color-pendiente)"
        />
        <Indicador
          titulo="Monto promedio recomendado"
          valor={moneda(m.monto_promedio_recomendado)}
          lectura="Promedio de los dictámenes que recomendaron un monto. Los rechazos no cuentan."
        />
        <Indicador
          titulo="Tasa de escalamiento"
          valor={tasa === null ? '—' : `${(tasa * 100).toFixed(1)}%`}
          lectura={
            tasa === null
              ? 'Todavía no hay dictámenes.'
              : `Aproximadamente una de cada ${Math.max(1, Math.round(1 / Math.max(tasa, 0.001)))} solicitudes necesita comité.`
          }
          tono="var(--color-escalado)"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel titulo="Estado del expediente" descripcion="Dónde está el trabajo ahora mismo">
          <div className="flex flex-col gap-2.5 p-4">
            <Barra
              etiqueta="En firme"
              valor={enFirme}
              total={m.total_solicitudes}
              color="var(--color-firme)"
            />
            <Barra
              etiqueta="Pendientes de confirmación"
              valor={pendientes}
              total={m.total_solicitudes}
              color="var(--color-pendiente)"
            />
            <Barra
              etiqueta="Anulados"
              valor={m.solicitudes_procesadas_por_estado.ANULADO ?? 0}
              total={m.total_solicitudes}
              color="var(--color-anulado)"
            />
            <Barra
              etiqueta="Sin analizar"
              valor={sinAnalizar}
              total={m.total_solicitudes}
              color="var(--color-texto-tenue)"
            />
          </div>
        </Panel>

        <Panel
          titulo="Sentido del dictamen"
          descripcion={`Sobre ${m.total_dictamenes} dictámenes emitidos`}
        >
          <div className="flex flex-col gap-2.5 p-4">
            <Barra
              etiqueta="Aprobado"
              valor={m.por_decision.APROBADO ?? 0}
              total={m.total_dictamenes}
              color="var(--color-aprobado)"
            />
            <Barra
              etiqueta="Rechazado"
              valor={m.por_decision.RECHAZADO ?? 0}
              total={m.total_dictamenes}
              color="var(--color-rechazado)"
            />
            <Barra
              etiqueta="Escalado a comité"
              valor={m.por_decision.ESCALADO_A_COMITE ?? 0}
              total={m.total_dictamenes}
              color="var(--color-escalado)"
            />
          </div>
        </Panel>
      </div>

      <Panel titulo="Por sector" descripcion="Dictámenes emitidos y cuántos acabaron en comité">
        <div className="overflow-x-auto">
          <table className="w-full min-w-100">
            <thead>
              <tr className="border-b border-[var(--color-borde-suave)] text-left text-[11px] text-[var(--color-texto-tenue)]">
                <th className="px-4 py-2 font-medium">Sector</th>
                <th className="px-4 py-2 font-medium">Dictámenes</th>
                <th className="px-4 py-2 font-medium">Escalados</th>
                <th className="px-4 py-2 font-medium">Tasa</th>
              </tr>
            </thead>
            <tbody>
              {m.por_sector.map((s) => (
                <tr
                  key={s.sector}
                  className="border-b border-[var(--color-borde-suave)] last:border-0"
                >
                  <td className="px-4 py-2 text-[13px]">
                    {ETIQUETA_SECTOR[s.sector as Sector] ?? s.sector}
                  </td>
                  <td className="cifra px-4 py-2 text-[13px]">{s.total}</td>
                  <td className="cifra px-4 py-2 text-[13px]">{s.escalados}</td>
                  <td
                    className="cifra px-4 py-2 text-[13px]"
                    style={{ color: 'var(--color-escalado)' }}
                  >
                    {((s.escalados / s.total) * 100).toFixed(0)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Indicador({
  titulo,
  valor,
  lectura,
  tono,
}: {
  titulo: string;
  valor: string;
  lectura: string;
  tono?: string;
}) {
  return (
    <div className="panel p-4">
      <p className="text-[11px] tracking-wide text-[var(--color-texto-tenue)]">{titulo}</p>
      <p
        className="cifra mt-1 text-2xl font-semibold tracking-tight"
        style={tono !== undefined ? { color: tono } : undefined}
      >
        {valor}
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-texto-suave)]">
        {lectura}
      </p>
    </div>
  );
}

function Barra({
  etiqueta,
  valor,
  total,
  color,
}: {
  etiqueta: string;
  valor: number;
  total: number;
  color: string;
}) {
  const pct = total === 0 ? 0 : (valor / total) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-[var(--color-texto-suave)]">{etiqueta}</span>
        <span className="cifra" style={{ color }}>
          {valor}
          <span className="ml-1.5 text-[11px] text-[var(--color-texto-tenue)]">
            {pct.toFixed(0)}%
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-superficie-elevada)]">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
