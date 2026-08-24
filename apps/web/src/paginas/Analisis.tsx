import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ETIQUETA_GARANTIA, ETIQUETA_SECTOR, type Garantia, type Sector } from '@aop/shared';
import { Encabezado } from '../app/Shell.js';
import { PanelDictamen } from '../componentes/PanelDictamen.js';
import { moneda, razon } from '../diseno/dominio.js';
import { Boton, Dato, Error as ErrorVista, Esqueleto, Panel, Vacio } from '../diseno/primitivas.js';
import { usarAnalisis, type PasoVisible } from '../estado/analisis.js';
import { api } from '../lib/api.js';

/**
 * Análisis asistido de una solicitud.
 *
 * El enunciado insiste en que la interfaz debe transmitir que hay un sistema
 * trabajando activamente, no parecer un tablero. Eso se resuelve mostrando lo
 * que el agente hace mientras lo hace: qué herramienta invoca, qué políticas
 * consulta, qué propone, y con cuánta confianza.
 *
 * Lo que NO se muestra: el prompt, los mensajes intermedios del modelo, ni nada
 * que parezca razonamiento interno. La frontera se decide en el servidor, que
 * solo emite argumentos de herramienta y resultados.
 */

export function Analisis() {
  const { id } = useParams<{ id: string }>();
  const [pestana, setPestana] = useState<'actividad' | 'dictamen'>('actividad');
  const analisis = usarAnalisis();

  const detalle = useQuery({
    queryKey: ['solicitud', id],
    queryFn: () => api.solicitud(id!),
    enabled: id !== undefined,
  });

  // Al terminar una ejecución se recarga el expediente desde la API. El cliente
  // no trata su vista local como autoridad: el dictamen o se escribió o no, y
  // eso lo sabe el servidor.
  useEffect(() => {
    if (analisis.fase === 'completado' && analisis.idDictamen !== null) {
      void detalle.refetch();
    }
    // Depende solo de fase e idDictamen a proposito: recargar en cada
    // cambio de `detalle` provocaria un ciclo de refetch infinito.
  }, [analisis.fase, analisis.idDictamen]);

  // Cambiar de expediente descarta el estado de la ejecución anterior.
  useEffect(() => {
    analisis.reiniciar();
    // Solo el identificador: `analisis` cambia en cada evento del flujo y
    // reiniciaria el estado a mitad de la ejecucion.
  }, [id]);

  if (id === undefined) {
    return (
      <>
        <Encabezado titulo="Análisis asistido" />
        <Vacio
          titulo="Elige una solicitud"
          descripcion="El análisis se lanza sobre un expediente concreto."
          accion={
            <Link to="/solicitudes">
              <Boton tamano="pequeno" tono="primario">
                Ir a la bandeja
              </Boton>
            </Link>
          }
        />
      </>
    );
  }

  if (detalle.isPending) {
    return (
      <div className="flex flex-col gap-3 p-4 md:p-6">
        <Esqueleto className="h-16 w-full" />
        <Esqueleto className="h-64 w-full" />
      </div>
    );
  }

  if (detalle.isError) {
    return (
      <ErrorVista
        mensaje={(detalle.error as Error).message}
        reintentar={() => void detalle.refetch()}
      />
    );
  }

  const s = detalle.data!.solicitud;
  const ind = detalle.data!.indicadores;
  const ultimo = detalle.data!.dictamenes[0] ?? null;
  const enCurso = analisis.fase === 'ejecutando';

  // Si esta ejecución produjo un dictamen, se muestra ese; si no, el más
  // reciente del expediente.
  const dictamenMostrado =
    analisis.idDictamen !== null
      ? (detalle.data!.dictamenes.find((d) => d.id === analisis.idDictamen) ?? null)
      : ultimo;

  return (
    <>
      <Encabezado
        titulo={String(s.nombre_empresa)}
        descripcion={`${ETIQUETA_SECTOR[s.sector as Sector] ?? s.sector} · ${s.meses_operacion} meses de operación · ${ETIQUETA_GARANTIA[s.garantia_ofrecida as Garantia] ?? s.garantia_ofrecida}`}
        acciones={
          enCurso ? (
            <Boton tono="peligro" tamano="pequeno" onClick={analisis.cancelar}>
              Cancelar análisis
            </Boton>
          ) : (
            <Boton tono="primario" tamano="pequeno" onClick={() => void analisis.iniciar(id)}>
              {analisis.pasos.length > 0 ? 'Analizar de nuevo' : 'Analizar con el asistente'}
            </Boton>
          )
        }
      />

      <div className="grid gap-4 p-4 md:p-6 lg:grid-cols-[1fr_minmax(340px,420px)]">
        <div className="flex flex-col gap-4">
          <Panel titulo="Expediente" descripcion="Datos declarados e indicadores calculados">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-3">
              <Dato
                etiqueta="Monto solicitado"
                valor={moneda(String(s.monto_solicitado))}
                numerico
              />
              <Dato etiqueta="Plazo" valor={`${s.plazo_meses} meses`} numerico />
              <Dato
                etiqueta="Score de historial"
                valor={s.score_historial === null ? 'sin historial' : String(s.score_historial)}
                numerico
                {...(s.score_historial === null ? { tono: 'var(--color-escalado)' } : {})}
              />
              <Dato
                etiqueta="Ventas anuales"
                valor={moneda(s.ventas_anuales as string | null)}
                numerico
              />
              <Dato
                etiqueta="Utilidad neta"
                valor={moneda(s.utilidad_neta as string | null)}
                numerico
              />
              <Dato
                etiqueta="Deuda vigente anual"
                valor={moneda(s.deuda_vigente_anual as string | null)}
                numerico
              />
            </dl>

            {ind !== null && (
              <>
                <div className="border-t border-[var(--color-borde-suave)] px-4 py-2">
                  <p className="text-[11px] text-[var(--color-texto-tenue)]">
                    Indicadores calculados en código, en decimal exacto · versión{' '}
                    {ind.version_calculo}
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 pb-4 sm:grid-cols-3">
                  <Dato
                    etiqueta="Razón de endeudamiento"
                    valor={razon(ind.razon_endeudamiento)}
                    numerico
                  />
                  <Dato etiqueta="Margen neto" valor={razon(ind.margen_neto)} numerico />
                  <Dato
                    etiqueta="Cobertura de deuda"
                    valor={razon(ind.cobertura_servicio_deuda)}
                    numerico
                  />
                  <Dato
                    etiqueta="Monto / ventas"
                    valor={razon(ind.relacion_monto_ventas)}
                    numerico
                  />
                  <Dato
                    etiqueta="Cuota mensual estimada"
                    valor={moneda(ind.cuota_mensual_estimada)}
                    numerico
                  />
                  <Dato
                    etiqueta="Tasa aplicada"
                    valor={`${(Number(ind.tasa_anual_aplicada) * 100).toFixed(2)}%`}
                    numerico
                  />
                </dl>

                {ind.hallazgos.length > 0 && (
                  <div className="border-t border-[var(--color-borde-suave)] p-4">
                    <p className="text-[11px] tracking-wide text-[var(--color-escalado)]">
                      Hallazgos sobre los datos declarados
                    </p>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {ind.hallazgos.map((h) => (
                        <li key={h.codigo} className="text-[12px] text-[var(--color-texto-suave)]">
                          {h.mensaje}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Panel>

          {/* Móvil: pestañas. En una pantalla de 375 px, apilar actividad y
              dictamen obligaría a un scroll larguísimo justo mientras el
              analista quiere ver ambas cosas. */}
          <div className="flex gap-1 lg:hidden">
            <Boton
              tamano="pequeno"
              tono={pestana === 'actividad' ? 'primario' : 'fantasma'}
              onClick={() => setPestana('actividad')}
            >
              Actividad
            </Boton>
            <Boton
              tamano="pequeno"
              tono={pestana === 'dictamen' ? 'primario' : 'fantasma'}
              onClick={() => setPestana('dictamen')}
            >
              Dictamen
            </Boton>
          </div>

          <div className={pestana === 'actividad' ? '' : 'hidden lg:block'}>
            <Actividad />
          </div>
        </div>

        <div className={pestana === 'dictamen' ? '' : 'hidden lg:block'}>
          <PanelDictamen
            propuesta={analisis.propuesta}
            dictamen={dictamenMostrado}
            enCurso={enCurso}
            degradado={analisis.degradado}
          />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Línea de tiempo de lo que el agente va haciendo. */
function Actividad() {
  const { fase, pasos, politicasConsultadas, resumenFinal, error, metricas } = usarAnalisis();

  if (fase === 'inactivo') {
    return (
      <Panel titulo="Actividad del asistente">
        <Vacio
          titulo="Sin análisis en curso"
          descripcion="Al lanzar el análisis verás aquí, paso a paso, qué consulta el asistente y qué propone."
        />
      </Panel>
    );
  }

  return (
    <Panel
      titulo="Actividad del asistente"
      descripcion={
        fase === 'ejecutando'
          ? 'Trabajando…'
          : fase === 'cancelado'
            ? 'Cancelado por el analista'
            : fase === 'error'
              ? 'La ejecución no llegó a producir un dictamen'
              : 'Ejecución terminada'
      }
      accion={
        metricas !== null ? (
          <span className="cifra text-[11px] text-[var(--color-texto-tenue)]">
            {metricas.iteraciones} turnos · {metricas.tokens} tokens ·{' '}
            {(metricas.latenciaMs / 1000).toFixed(1)} s
          </span>
        ) : undefined
      }
    >
      {fase === 'ejecutando' && <div className="pulso-actividad h-0.5" />}

      <ol className="flex flex-col gap-0 p-4">
        {pasos.map((p) => (
          <Paso key={p.id} paso={p} />
        ))}
      </ol>

      {politicasConsultadas.length > 0 && (
        <div className="border-t border-[var(--color-borde-suave)] p-4">
          <p className="text-[11px] tracking-wide text-[var(--color-texto-tenue)]">
            Fuentes consultadas · {politicasConsultadas.length} políticas
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {politicasConsultadas.map((c) => (
              <span
                key={c.id_politica}
                title={c.texto_literal}
                className="mono rounded-[var(--radius-pastilla)] border border-[var(--color-borde)] px-2 py-0.5 text-[11px] text-[var(--color-texto-suave)]"
              >
                {c.id_politica}
              </span>
            ))}
          </div>
        </div>
      )}

      {error !== null && (
        <p className="border-t border-[var(--color-borde-suave)] p-4 text-[12px] text-[var(--color-rechazado)]">
          {error}
        </p>
      )}

      {resumenFinal !== null && (
        <p className="border-t border-[var(--color-borde-suave)] p-4 text-[12px] leading-relaxed text-[var(--color-texto-suave)]">
          {resumenFinal}
        </p>
      )}

      {fase === 'cancelado' && (
        <p className="border-t border-[var(--color-borde-suave)] p-4 text-[11px] leading-relaxed text-[var(--color-texto-tenue)]">
          La generación se cortó en el proveedor. Si el dictamen llegó a registrarse antes de
          cancelar, sigue en el expediente: lo que se escribió es transaccional y no depende de esta
          conexión.
        </p>
      )}
    </Panel>
  );
}

function Paso({ paso }: { paso: PasoVisible }) {
  const color =
    paso.estado === 'fallo'
      ? 'var(--color-rechazado)'
      : paso.estado === 'en_curso'
        ? 'var(--color-acento)'
        : 'var(--color-texto-tenue)';

  return (
    <li className="aparece flex gap-3 py-1.5">
      <div className="flex flex-col items-center">
        <span
          aria-hidden
          className={
            paso.estado === 'en_curso' ? 'size-2 animate-pulse rounded-full' : 'size-2 rounded-full'
          }
          style={{ backgroundColor: color }}
        />
        <span aria-hidden className="w-px flex-1 bg-[var(--color-borde)]" />
      </div>
      <div className="min-w-0 pb-1">
        <p className="text-[12px]" style={{ color: paso.estado === 'fallo' ? color : undefined }}>
          {paso.resumen ?? paso.nombre}
        </p>
        {paso.detalle !== undefined && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-rechazado)]">
            {paso.detalle.split('\n')[0]}
          </p>
        )}
      </div>
    </li>
  );
}
