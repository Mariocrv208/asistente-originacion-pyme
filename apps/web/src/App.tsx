import { useEffect, useState } from 'react';
import { saludSchema, type Salud } from '@aop/shared';

type Estado =
  { fase: 'cargando' } | { fase: 'listo'; salud: Salud } | { fase: 'error'; mensaje: string };

/**
 * Pantalla de verificacion del andamiaje (M1).
 *
 * Su unico proposito es demostrar el criterio de cierre del modulo: que el
 * frontend habla con la API y que la API habla con PostgreSQL. Se sustituye por
 * completo a partir de M13.
 */
export function App() {
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });

  useEffect(() => {
    const controlador = new AbortController();

    void (async () => {
      try {
        const respuesta = await fetch('/api/salud', { signal: controlador.signal });
        if (!respuesta.ok) throw new Error(`La API respondio ${respuesta.status}`);
        // La respuesta se valida contra el mismo esquema que usa el servidor.
        setEstado({ fase: 'listo', salud: saludSchema.parse(await respuesta.json()) });
      } catch (error) {
        if (controlador.signal.aborted) return;
        setEstado({
          fase: 'error',
          mensaje: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => controlador.abort();
  }, []);

  return (
    <main
      style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: '48px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <header>
        <h1 style={{ fontSize: 22, margin: 0, letterSpacing: '-0.01em' }}>
          Asistente de Originación Crediticia PyME
        </h1>
        <p style={{ color: 'var(--texto-tenue)', margin: '6px 0 0' }}>
          Módulo M1 · verificación del andamiaje
        </p>
      </header>

      <section
        style={{
          background: 'var(--superficie)',
          border: '1px solid var(--borde)',
          borderRadius: 10,
          padding: 18,
        }}
      >
        {estado.fase === 'cargando' && (
          <p style={{ margin: 0, color: 'var(--texto-tenue)' }}>Consultando la API…</p>
        )}

        {estado.fase === 'error' && (
          <>
            <Fila etiqueta="Frontend" valor="activo" tono="ok" />
            <Fila etiqueta="API" valor={estado.mensaje} tono="error" />
            <p style={{ color: 'var(--texto-tenue)', marginBottom: 0 }}>
              Levanta la API con <code>pnpm dev:api</code> y la base de datos con{' '}
              <code>pnpm db:up</code>.
            </p>
          </>
        )}

        {estado.fase === 'listo' && (
          <>
            <Fila etiqueta="Frontend" valor="activo" tono="ok" />
            <Fila
              etiqueta="API"
              valor={`v${estado.salud.version} · ${estado.salud.entorno}`}
              tono="ok"
            />
            <Fila
              etiqueta="PostgreSQL"
              valor={
                estado.salud.dependencias.baseDatos.estado === 'ok'
                  ? `conectada · ${estado.salud.dependencias.baseDatos.latenciaMs} ms`
                  : (estado.salud.dependencias.baseDatos.detalle ?? 'sin conexión')
              }
              tono={estado.salud.dependencias.baseDatos.estado === 'ok' ? 'ok' : 'error'}
            />
          </>
        )}
      </section>
    </main>
  );
}

function Fila({
  etiqueta,
  valor,
  tono,
}: {
  etiqueta: string;
  valor: string;
  tono: 'ok' | 'error' | 'pendiente';
}) {
  const color =
    tono === 'ok' ? 'var(--ok)' : tono === 'error' ? 'var(--error)' : 'var(--pendiente)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--borde)',
      }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }}
      />
      <span style={{ minWidth: 96, color: 'var(--texto-tenue)' }}>{etiqueta}</span>
      <span style={{ color, wordBreak: 'break-word' }}>{valor}</span>
    </div>
  );
}
