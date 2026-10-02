import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI calls the API through the same origin (/api), so no CORS headers are needed anywhere:
// in dev and preview the Vite server proxies /api to the API on :3000.
const proxy = {
  '/api': { target: 'http://localhost:3000', rewrite: (p: string) => p.replace(/^\/api/, '') },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 5173, strictPort: true, proxy },
});
