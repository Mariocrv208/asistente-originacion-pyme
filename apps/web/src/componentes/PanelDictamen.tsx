import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Confianza,
  EtiquetaDecision,
  EtiquetaEstado,
  EtiquetaRiesgo,
  fechaHora,
  moneda,
} from '../diseno/dominio.js';
import { Boton, Panel, Vacio } from '../diseno/primitivas.js';
import { api, type DictamenApi } from '../lib/api.js';
import type { PropuestaDictamen } from '../estado/analisis.js';

/**
 * Panel de dictamen en vivo.
 *
 * Renderiza el objeto estructurado conforme el agente lo construye (punto
 * 5.3.8) y, sobre todo, distingue en todo momento entre lo que es una
 * PROPUESTA REVERSIBLE y lo que ya es un EFECTO CONFIRMADO en el servidor.
 *
 * Esa distinción no es decorativa. Mientras el agente trabaja, lo que se ve es
 * lo que el modelo está intentando registrar: puede cambiar, puede ser tumbado
 * por un guardarraíl, puede no llegar a existir. El panel lo marca con una
 * franja de actividad y la palabra «propuesta». En cuanto el servidor confirma
 * la escritura, el panel deja de pintar su copia local y muestra el dictamen
 * persistido, con su identificador y su estado real.
 */

interface Props {
  propuesta: PropuestaDictamen | null;
  dictamen: DictamenApi | null;
  enCurso: boolean;
  degradado: boolean;
}

export function PanelDictamen({ propuesta, dictamen, enCurso, degradado }: Props) {
  if (dictamen !== null) {
    return <DictamenConfirmado dictamen={dictamen} degradado={degradado} />;
  }
  if (propuesta !== null) {
    return <DictamenPropuesto propuesta={propuesta} enCurso={enCurso} />;
  }
  return (
    <Panel titulo="Dictamen">
      <Vacio
        titulo={enCurso ? 'El asistente todavía está analizando' : 'Sin dictamen'}
        descripcion={
          enCurso
            ? 'El dictamen aparecerá aquí en cuanto el asistente lo proponga.'
            : 'Lanza un análisis para que el asistente proponga un dictamen.'
        }
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function DictamenPropuesto({
  propuesta,
  enCurso,
}: {
  propuesta: PropuestaDictamen;
  enCurso: boolean;
}) {
  return (
    <Panel
      titulo="Dictamen propuesto"
      descripcion="Todavía no está registrado. Puede cambiar o ser rechazado por un guardarraíl."
      accion={
        enCurso ? (
          <span className="rounded-[var(--radius-pastilla)] border border-[var(--color-acento)]/30 px-2 py-0.5 text-[11px] text-[var(--color-acento)]">
            En construcción
          </span>
        ) : undefined
      }
    >
      {enCurso && <div className="pulso-actividad h-0.5" />}
      <div className="aparece flex flex-col gap-4 p-4">
        <Cabecera
          decision={propuesta.decision ?? null}
          riesgo={propuesta.nivel_riesgo ?? null}
          confianza={propuesta.confianza}
          monto={propuesta.monto_recomendado ?? null}
          plazo={propuesta.plazo_recomendado_meses ?? null}
        />
        <Motivos motivos={propuesta.motivos ?? []} />
        <Citas citas={propuesta.politicas_citadas ?? []} verificadas={false} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function DictamenConfirmado({
  dictamen,
  degradado,
}: {
  dictamen: DictamenApi;
  degradado: boolean;
}) {
  return (
    <Panel
      titulo="Dictamen registrado"
      descripcion={`Emitido el ${fechaHora(dictamen.creado_en)}`}
      accion={<EtiquetaEstado estado={dictamen.estado} />}
    >
      <div className="flex flex-col gap-4 p-4">
        {degradado && (
          <p className="rounded-lg border border-[var(--color-escalado)]/30 bg-[var(--color-escalado-fondo)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-escalado)]">
            Salida degradada. El asistente no logró producir un dictamen válido, así que el sistema
            escaló la solicitud a comité con los indicadores que calculó en código. Requiere
            análisis humano completo.
          </p>
        )}

        <Cabecera
          decision={dictamen.decision}
          riesgo={dictamen.nivel_riesgo}
          confianza={Number(dictamen.confianza)}
          monto={dictamen.monto_recomendado}
          plazo={dictamen.plazo_recomendado_meses}
        />

        <Motivos motivos={dictamen.motivos} />
        <Citas citas={dictamen.citas} verificadas />

        <Confirmacion dictamen={dictamen} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Cabecera({
  decision,
  riesgo,
  confianza,
  monto,
  plazo,
}: {
  decision: string | null;
  riesgo: string | null;
  confianza: number | undefined;
  monto: string | null;
  plazo: number | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <EtiquetaDecision decision={decision as never} />
        <EtiquetaRiesgo nivel={riesgo as never} />
        {confianza !== undefined && <Confianza valor={confianza} />}
      </div>

      {monto !== null && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="cifra text-xl font-semibold tracking-tight">{moneda(monto)}</p>
          {plazo !== null && (
            <p className="text-xs text-[var(--color-texto-tenue)]">a {plazo} meses</p>
          )}
        </div>
      )}
    </div>
  );
}

function Motivos({ motivos }: { motivos: string[] }) {
  if (motivos.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] tracking-wide text-[var(--color-texto-tenue)]">Motivos</p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {motivos.map((m, i) => (
          <li key={i} className="flex gap-2 text-[12px] leading-relaxed">
            <span
              aria-hidden
              className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-texto-tenue)]"
            />
            <span>{m}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Políticas citadas, con identificador y sección (punto 5.3.8).
 *
 * El texto se muestra completo y sin recortar: es la cita literal que sustenta
 * la decisión, y recortarla con puntos suspensivos convertiría en decorativo lo
 * único que hace verificable el dictamen.
 */
function Citas({
  citas,
  verificadas,
}: {
  citas: Array<{ id_politica: string; seccion: string; texto_literal: string }>;
  verificadas: boolean;
}) {
  if (citas.length === 0) {
    return (
      <p className="text-[11px] text-[var(--color-texto-tenue)]">
        Todavía no hay políticas citadas.
      </p>
    );
  }

  return (
    <div>
      <p className="text-[11px] tracking-wide text-[var(--color-texto-tenue)]">
        Políticas citadas
        {verificadas && (
          <span className="ml-1.5 text-[var(--color-aprobado)]">
            · verificadas literalmente contra el corpus
          </span>
        )}
      </p>
      <ul className="mt-1.5 flex flex-col gap-2">
        {citas.map((c) => (
          <li
            key={c.id_politica}
            className="rounded-lg border border-[var(--color-borde-suave)] bg-[var(--color-superficie-alta)] p-2.5"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="mono text-[11px] font-medium text-[var(--color-acento)]">
                {c.id_politica}
              </span>
              <span className="text-[11px] text-[var(--color-texto-tenue)]">{c.seccion}</span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-texto-suave)]">
              {c.texto_literal}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Confirmación explícita del analista (guardarraíl G4).
 *
 * Es el momento en que una recomendación se convierte en un hecho. La interfaz
 * lo dice con esas palabras, y pide el nombre: sin identificar a quién confirma,
 * la trazabilidad que promete el sistema tendría un agujero justo en el paso más
 * importante.
 */
function Confirmacion({ dictamen }: { dictamen: DictamenApi }) {
  const [analista, setAnalista] = useState('');
  const cliente = useQueryClient();

  const confirmar = useMutation({
    mutationFn: () => api.confirmar(dictamen.id, analista),
    onSuccess: () => {
      void cliente.invalidateQueries({ queryKey: ['solicitud'] });
      void cliente.invalidateQueries({ queryKey: ['bandeja'] });
      void cliente.invalidateQueries({ queryKey: ['metricas'] });
    },
  });

  if (dictamen.estado === 'EN_FIRME') {
    return (
      <div className="rounded-lg border border-[var(--color-firme)]/25 bg-[var(--color-superficie-alta)] px-3 py-2.5">
        <p className="text-[12px] text-[var(--color-firme)]">
          Confirmado por {dictamen.confirmado_por} · {fechaHora(dictamen.confirmado_en)}
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--color-texto-tenue)]">
          El contenido de este dictamen ya no es modificable.
        </p>
      </div>
    );
  }

  if (dictamen.estado === 'ANULADO') return null;

  return (
    <div className="rounded-lg border border-[var(--color-pendiente)]/30 bg-[var(--color-superficie-alta)] p-3">
      <p className="text-[12px] font-medium text-[var(--color-pendiente)]">
        Esta recomendación no surte efecto hasta que la confirmes
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-texto-tenue)]">
        {dictamen.requiere_autorizacion_humana
          ? 'Por monto o nivel de riesgo, este expediente requiere autorización explícita.'
          : 'Ningún dictamen queda en firme sin la confirmación de un analista.'}
      </p>

      <div className="mt-2.5 flex flex-wrap gap-2">
        <input
          value={analista}
          onChange={(e) => setAnalista(e.target.value)}
          placeholder="Tu usuario de analista"
          aria-label="Usuario del analista que confirma"
          className="min-w-40 flex-1 rounded-lg border border-[var(--color-borde)] bg-[var(--color-superficie-elevada)] px-2.5 py-1.5 text-xs placeholder:text-[var(--color-texto-tenue)]"
        />
        <Boton
          tono="primario"
          tamano="pequeno"
          disabled={analista.trim().length < 2}
          cargando={confirmar.isPending}
          onClick={() => confirmar.mutate()}
        >
          Confirmar dictamen
        </Boton>
      </div>

      {confirmar.isError && (
        <p className="mt-2 text-[11px] text-[var(--color-rechazado)]">
          {(confirmar.error as Error).message}
        </p>
      )}
    </div>
  );
}
