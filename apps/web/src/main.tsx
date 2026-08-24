import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { rutas } from './app/rutas.js';
import './estilos/base.css';

/**
 * Estado del servidor con TanStack Query.
 *
 * Los reintentos se limitan a uno: si la API responde 400 porque un filtro es
 * invalido, reintentar tres veces no cambia nada y solo retrasa el mensaje de
 * error que el analista necesita ver.
 */
const cliente = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const contenedor = document.getElementById('root');
if (!contenedor) throw new Error('No se encontro el elemento #root');

createRoot(contenedor).render(
  <StrictMode>
    <QueryClientProvider client={cliente}>
      <RouterProvider router={rutas} />
    </QueryClientProvider>
  </StrictMode>,
);
