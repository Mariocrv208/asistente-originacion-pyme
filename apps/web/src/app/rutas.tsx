import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Shell } from './Shell.js';
import { Analisis } from '../paginas/Analisis.js';
import { Bandeja } from '../paginas/Bandeja.js';
import { Evaluacion } from '../paginas/Evaluacion.js';
import { Metricas } from '../paginas/Metricas.js';

export const rutas = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/solicitudes" replace /> },
      { path: 'solicitudes', element: <Bandeja /> },
      { path: 'solicitudes/:id', element: <Analisis /> },
      { path: 'analisis', element: <Analisis /> },
      { path: 'metricas', element: <Metricas /> },
      { path: 'evaluacion', element: <Evaluacion /> },
    ],
  },
]);
