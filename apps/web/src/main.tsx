import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './estilos-base.css';

const contenedor = document.getElementById('root');
if (!contenedor) throw new Error('No se encontro el elemento #root');

createRoot(contenedor).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
