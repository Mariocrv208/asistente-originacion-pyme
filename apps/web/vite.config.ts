import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin en desarrollo. Importa mas adelante que por comodidad: el
      // chat de M12 va por SSE, y un proxy evita tener que razonar sobre CORS
      // y credenciales en una respuesta de larga duracion.
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
});
