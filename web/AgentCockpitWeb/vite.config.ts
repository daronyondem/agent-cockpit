import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/v2/',
  plugins: [react()],
  build: {
    outDir: '../../public/v2-built',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 4 * 1024,
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom)[\\/]/,
              priority: 30,
            },
            {
              name: 'stream-frame-reducer',
              test: /src[\\/]stream[\\/]streamFrameReducer\.ts$/,
              priority: 25,
            },
            {
              name: 'markdown-vendor',
              test: /node_modules[\\/](marked|dompurify|highlight\.js)[\\/]/,
              priority: 20,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
