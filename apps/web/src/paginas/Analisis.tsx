import { Encabezado } from '../app/Shell.js';
import { Vacio } from '../diseno/primitivas.js';

/**
 * Chat con el asistente y panel de dictamen en vivo.
 *
 * Se construye en el siguiente modulo. El marcador existe para que la
 * navegacion sea completa y el shell se pueda verificar de extremo a extremo.
 */
export function Analisis() {
  return (
    <>
      <Encabezado
        titulo="Análisis asistido"
        descripcion="Chat con el asistente y dictamen en construcción"
      />
      <Vacio
        titulo="En construcción"
        descripcion="Aquí irá el chat con streaming, la línea de tiempo de lo que hace el agente y el panel de dictamen en vivo con la confirmación del analista."
      />
    </>
  );
}
