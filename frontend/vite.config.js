import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  optimizeDeps: {
    include: ['react', 'react-dom', '@monaco-editor/react', 'monaco-editor']
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html')
    }
  },
  server: {
    port: 4173,
    host: '0.0.0.0',
    strictPort: true
  }
});
