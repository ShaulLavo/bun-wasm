import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
const plugins = [svelte()];
export default defineConfig({
  plugins,
  build: { rollupOptions: { output: { entryFileNames: 'assets/app.js' } } },
});
