import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Allow external connections
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    // The container is reached as "localhost" from the host and as "web" from
    // sibling compose services; both have to be allowed or Vite 7 refuses.
    allowedHosts: true,
  },
  build: { outDir: 'dist', sourcemap: true },
});
