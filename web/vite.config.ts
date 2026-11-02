import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Keep the browser's Host header so the server's same-origin check also passes
    // when the CRM is opened from another computer (npm run dev:lan).
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
});
