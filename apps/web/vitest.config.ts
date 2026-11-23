import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests (#62): Testing Library in jsdom. Kept apart from
// vite.config.ts so the production build never loads test tooling, and from
// the node --test suites in test/*.test.js, which test pure modules.
const zstdShim = fileURLToPath(new URL('./test/zstd-shim.cjs', import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/components/**/*.test.{ts,tsx}'],
    setupFiles: ['test/components/setup.ts'],
    // Node <22.15 has no zlib.createZstdDecompress, which undici binds at
    // require time; the shim must land before jsdom loads in the worker.
    execArgv: ['--require', zstdShim],
  },
});
