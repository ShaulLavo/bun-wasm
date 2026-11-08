import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [tanstackStart({ target: 'bun', customViteReactPlugin: true, tsr: { srcDirectory: 'src' } }), react()] });
