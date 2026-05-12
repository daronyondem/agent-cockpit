import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/mobile/',
  plugins: [react()],
  build: {
    outDir: '../../public/mobile-built',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3334',
        ws: true,
      },
      '/auth': 'http://localhost:3334',
      '/logo-full-no-text.svg': 'http://localhost:3334',
      '/logo-small.svg': 'http://localhost:3334',
    },
  },
});
