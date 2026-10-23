import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const clientPort = Number(process.env.VOXSHOP_CLIENT_PORT ?? 3000);

export default defineConfig({
  server: {
    port: clientPort,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.VOXSHOP_PORT ?? 4269}`, changeOrigin: true },
    },
  },
  plugins: [react()],
});
