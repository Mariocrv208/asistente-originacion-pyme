/**
 * Contratos compartidos entre la API y el frontend.
 *
 * Este paquete se publica como codigo fuente TypeScript (ver "exports" en
 * package.json). No se compila: tsx lo transpila en el backend y Vite en el
 * frontend. El despliegue esta fuera del alcance del examen, asi que anadir un
 * paso de build solo introduciria una fuente de desincronizacion entre lo que
 * valida el servidor y lo que espera el cliente.
 *
 * La regla del paquete: aqui solo entran esquemas y tipos. Nada de acceso a
 * base de datos, red ni variables de entorno, porque lo importa el navegador.
 */

export * from './health.js';
export * from './politicas.js';
export * from './indicadores.js';
export * from './solicitudes.js';
export * from './dictamen.js';
