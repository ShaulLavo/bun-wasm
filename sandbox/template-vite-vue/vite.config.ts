import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
const plugins = [vue()];
export default defineConfig({
  plugins,
  build: { rollupOptions: { output: { entryFileNames: 'assets/app.js' } } },
});
