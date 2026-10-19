import path from 'path';
import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
    return {
      server: {
        port: 3000,
        host: '127.0.0.1',
        proxy: { '/api': { target: 'http://127.0.0.1:4269', changeOrigin: true } },
      },
      plugins: [react()],
      define: {
          __APP_VERSION__: JSON.stringify(packageJson.version || '0.0.0')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
