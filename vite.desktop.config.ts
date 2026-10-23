import { defineConfig } from 'vite';

export default defineConfig({
  root: 'desktop',
  base: './',
  build: {
    outDir: '../.voxshop/desktop-runtime/bootstrap',
    emptyOutDir: true,
  },
});
