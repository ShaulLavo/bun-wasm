export default defineNuxtConfig({
  compatibilityDate: '2025-10-01',
  ssr: true,
  telemetry: false,
  devtools: { enabled: false },
  nitro: { preset: 'node-server' },
});
