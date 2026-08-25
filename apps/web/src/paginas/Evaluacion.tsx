import { useQuery } from '@tanstack/react-query';
import { Encabezado } from '../app/Shell.js';
import { EtiquetaDecision, fechaHora } from '../diseno/dominio.js';
import { Error as ErrorVista, Esqueleto, Etiqueta, Panel, Vacio } from '../diseno/primitivas.js';
import { api, ErrorApi, type CasoEvaluacion, type InformeEvaluacion } from '../lib/api.js';

/**
 * Estado del banco de evaluación (punto 5.3.6).
 *
 * Es de solo lectura, a propósito: el script que produce este informe
 * (`pnpm eval`) necesita Docker, la base de datos y la clave de OpenRouter del
 * entorno del servidor, así que no es algo que esta pantalla deba poder
 * disparar. Lo que sí puede hacer es mostrar, sin abrir una terminal, qué tan
 * completo está el informe, qué casos pasaron y por qué falló el que falló —
 * el mismo criterio de aprobación que documenta `eval/casos.ts`, legible aquí.
 */

const CATEGORIA: Record<string, string> = {
  aprobacion: 'Aprobación',
  rechazo: 'Rechazo',
  escalamiento: 'Escalamiento',
  adversarial: 'Adversarial',
};

const ORDEN_CATEGORIA = ['aprobacion', 'rechazo', 'escalamiento', 'adversarial'];

export function Evaluacion() {
  const consulta = useQuery({
    queryKey: ['evaluacion'],
    queryFn: api.evaluacion,
    retry: (n, error) => !(error instanceof ErrorApi && error.estado === 404) && n < 2,
  });

  const sinInforme = consulta.error instanceof ErrorApi && consulta.error.estado === 404;

  return (
    <>
      <Encabezado
        titulo="Banco de evaluación"
        descripcion="Los 10 casos del punto 5.3.6, tal como quedaron en la última corrida"
      />

      <div className="px-4 py-4 md:px-6">
        {consulta.isPending && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Esqueleto key={i} className="h-24 w-full" />
              ))}
            </div>
            <Esqueleto className="h-40 w-full" />
          </div>
        )}

        {consulta.isError && !sinInforme && (
          <ErrorVista
            mensaje={(consulta.error as Error).message}
            reintentar={() => void consulta.refetch()}
          />
        )}

        {sinInforme && (
          <Vacio
            titulo="Todavía no se ha corrido el banco de evaluación"
            descripcion={
              'Ejecuta "pnpm eval" en la terminal para generar eval-results/ultima.json. ' +
              'La capa gratuita de OpenRouter limita las peticiones diarias, así que puede ' +
              'tomar varias corridas completar los 10 casos.'
            }
          />
        )}

        {consulta.data && <Contenido informe={consulta.data} />}
      </div>
    </>
  );
}

function Contenido({ informe }: { informe: InformeEvaluacion }) {
  const casos = Object.values(informe.casos).sort((a, b) => {
    const ca = ORDEN_CATEGORIA.indexOf(a.categoria);
    const cb = ORDEN_CATEGORIA.indexOf(b.categoria);
    return ca === cb ? a.id.localeCompare(b.id) : ca - cb;
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Indicador
          titulo="Estado del informe"
          valor={informe.estado === 'completo' ? 'Completo' : 'Parcial'}
          lectura={`${informe.casos_con_resultado} de ${informe.casos_totales} casos con resultado`}
          tono={informe.estado === 'completo' ? 'var(--color-aprobado)' : 'var(--color-escalado)'}
        />
        <Indicador
          titulo="Pasan"
          valor={`${informe.resumen.pasan} / ${informe.casos_con_resultado}`}
          lectura="Sobre los casos que ya tienen resultado, no sobre los 10."
          tono="var(--color-aprobado)"
        />
        <Indicador
          titulo="Fallan"
          valor={String(informe.resumen.fallan)}
          lectura="Ver cada tarjeta abajo para el motivo concreto."
          {...(informe.resumen.fallan > 0 ? { tono: 'var(--color-rechazado)' } : {})}
        />
        <Indicador
          titulo="Última actualización"
          valor={fechaHora(informe.actualizado_en)}
          lectura={
            informe.pendientes.length === 0
              ? 'Sin casos pendientes.'
              : `Pendientes: ${informe.pendientes.join(', ')}`
          }
        />
      </div>

      <Panel titulo="Por categoría" descripcion="Distribución exigida: 3 / 3 / 2 / 2">
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          {Object.entries(informe.resumen.por_categoria).map(([cat, texto]) => (
            <div key={cat}>
              <p className="text-[11px] text-[var(--color-texto-tenue)]">
                {CATEGORIA[cat] ?? cat}
              </p>
              <p className="cifra mt-0.5 text-sm">{texto}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        titulo="Tandas ejecutadas"
        descripcion="La capa gratuita reparte los 10 casos en varias corridas"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-120">
            <thead>
              <tr className="border-b border-[var(--color-borde-suave)] text-left text-[11px] text-[var(--color-texto-tenue)]">
                <th className="px-4 py-2 font-medium">Fecha</th>
                <th className="px-4 py-2 font-medium">Modelo</th>
                <th className="px-4 py-2 font-medium">Prompt</th>
                <th className="px-4 py-2 font-medium">Casos</th>
                <th className="px-4 py-2 font-medium">Duración</th>
                <th className="px-4 py-2 font-medium">Cuota</th>
              </tr>
            </thead>
            <tbody>
              {informe.tandas.map((t, i) => (
                <tr
                  key={`${t.id_sesion}-${i}`}
                  className="border-b border-[var(--color-borde-suave)] text-[13px] last:border-0"
                >
                  <td className="px-4 py-2 whitespace-nowrap">{fechaHora(t.ejecutado_en)}</td>
                  <td className="px-4 py-2">{t.modelo_configurado}</td>
                  <td className="cifra px-4 py-2">{t.version_prompt}</td>
                  <td className="px-4 py-2">{t.casos.join(', ')}</td>
                  <td className="cifra px-4 py-2">{(t.duracion_ms / 1000).toFixed(1)}s</td>
                  <td className="px-4 py-2">
                    {t.interrumpida_por_cuota ? (
                      <Etiqueta color="var(--color-escalado)">Se agotó</Etiqueta>
                    ) : (
                      <Etiqueta color="var(--color-aprobado)">Completa</Etiqueta>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="flex flex-col gap-3">
        <h2 className="px-1 text-[13px] font-semibold tracking-wide text-[var(--color-texto)]">
          Los 10 casos
        </h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {casos.map((c) => (
            <TarjetaCaso key={c.id} caso={c} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TarjetaCaso({ caso }: { caso: CasoEvaluacion }) {
  return (
    <Panel
      titulo={
        <span className="flex items-center gap-2">
          <span className="cifra text-[var(--color-texto-tenue)]">{caso.id}</span>
          {caso.titulo}
        </span>
      }
      descripcion={CATEGORIA[caso.categoria] ?? caso.categoria}
      accion={
        <Etiqueta
          color={caso.paso ? 'var(--color-aprobado)' : 'var(--color-rechazado)'}
          fondo={caso.paso ? 'var(--color-aprobado-fondo)' : 'var(--color-rechazado-fondo)'}
        >
          {caso.paso ? 'Pasa' : 'Falla'}
        </Etiqueta>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
          <span className="flex items-center gap-1.5 text-[var(--color-texto-tenue)]">
            Obtenida
            <EtiquetaDecision decision={caso.decisionObtenida} />
          </span>
          <span className="flex items-center gap-1.5 text-[var(--color-texto-tenue)]">
            Esperada
            <EtiquetaDecision decision={caso.decisionEsperada} />
          </span>
          {caso.degradado && (
            <Etiqueta color="var(--color-escalado)" titulo="El servidor armó el dictamen, no el modelo">
              Degradado
            </Etiqueta>
          )}
        </div>

        <dl className="grid grid-cols-3 gap-2 text-[11px] sm:grid-cols-4">
          <div>
            <dt className="text-[var(--color-texto-tenue)]">Modelo</dt>
            <dd className="mt-0.5 truncate" title={caso.modelo}>
              {caso.modelo}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-texto-tenue)]">Iteraciones</dt>
            <dd className="cifra mt-0.5">{caso.iteraciones}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-texto-tenue)]">Latencia</dt>
            <dd className="cifra mt-0.5">{(caso.latenciaMs / 1000).toFixed(1)}s</dd>
          </div>
          <div>
            <dt className="text-[var(--color-texto-tenue)]">Ejecutado</dt>
            <dd className="mt-0.5">{fechaHora(caso.ejecutado_en)}</dd>
          </div>
        </dl>

        {caso.citas.length > 0 && (
          <div className="text-[11px]">
            <p className="text-[var(--color-texto-tenue)]">Citó</p>
            <p className="cifra mt-0.5">{caso.citas.join(', ')}</p>
          </div>
        )}

        <ul className="flex flex-col gap-1 border-t border-[var(--color-borde-suave)] pt-2.5">
          {caso.condiciones.map((cond, i) => (
            <li key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
              <span
                aria-hidden
                className="mt-0.5 size-1.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: cond.ok ? 'var(--color-aprobado)' : 'var(--color-rechazado)',
                }}
              />
              <span>
                <span className="text-[var(--color-texto-suave)]">{cond.nombre}</span>
                {cond.detalle && (
                  <span className="text-[var(--color-texto-tenue)]"> — {cond.detalle}</span>
                )}
              </span>
            </li>
          ))}
        </ul>

        {caso.error !== undefined && (
          <p className="text-[11px] text-[var(--color-rechazado)]">{caso.error}</p>
        )}
      </div>
    </Panel>
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
