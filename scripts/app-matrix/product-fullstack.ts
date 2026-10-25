import { productMarker, type FeatureProbe, type ProductApp, type ProductCommand } from "./product-types.ts";

const viteBin = "node_modules/vite/bin/vite.js";
const nuxtBin = "node_modules/nuxt/bin/nuxt.mjs";
const astroBin = "node_modules/astro/astro.js";
const routerBin = "node_modules/@react-router/dev/bin.js";
const vinxiBin = "node_modules/vinxi/bin/cli.mjs";
const markerSelector = "#product-marker";
const requestValue = "fullstack-request-value";
const probes: readonly FeatureProbe[] = [
  { kind: "response", id: "ssr-query", path: `/?value=${requestValue}`, status: 200, text: requestValue },
  { kind: "route", id: "query-dom", path: `/?value=${requestValue}`, selector: "#server-value", text: requestValue },
  { kind: "action", id: "client-interaction", path: "/", button: "#increment", selector: "#count", text: "1" },
];

interface Lifecycle {
  source: string;
  dev: readonly string[];
  build: readonly string[];
  output: readonly string[];
  start: readonly string[];
}

function lifecycle(options: Lifecycle): ProductCommand[] {
  return [
    {
      name: "dev",
      args: ["run"].concat(options.dev),
      check: {
        kind: "page", selector: markerSelector, text: productMarker, probes,
        hmr: { path: options.source, search: productMarker, replacement: `${productMarker} updated` },
      },
    },
    { name: "build", args: ["run"].concat(options.build), check: { kind: "files", paths: options.output, text: "" } },
    {
      name: "start", after: "build", args: ["run"].concat(options.start),
      check: { kind: "page", selector: markerSelector, text: productMarker, probes },
    },
  ];
}

function productionLauncher(entry: string): string {
  return `const port = process.argv[2];
if (!port) throw new Error('Expected a port');
process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
process.env.PORT = port;
process.env.NITRO_HOST = '127.0.0.1';
process.env.NITRO_PORT = port;
await import('${entry}');
`;
}

const reactDependencies = { react: "19.1.1", "react-dom": "19.1.1" };
const tsconfig = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true },
});

export const fullstackApps: ProductApp[] = [
  {
    id: "fullstack-sveltekit", family: "fullstack",
    dependencies: {
      "@sveltejs/kit": "2.43.1", "@sveltejs/adapter-node": "5.3.2",
      "@sveltejs/vite-plugin-svelte": "6.2.1", "@opentelemetry/api": "1.9.0",
      svelte: "5.39.11", vite: "7.1.12", typescript: "5.9.3",
    },
    features: ["ssr-query", "query-dom", "client-interaction"],
    files: {
      "svelte.config.ts": `import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default { preprocess: vitePreprocess(), kit: { adapter: adapter({ out: 'build' }) } };
`,
      "vite.config.ts": `import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
export default defineConfig({ plugins: [sveltekit()] });
`,
      "src/app.html": '<!doctype html><html lang="en"><head><meta charset="utf-8">%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>',
      "src/routes/+page.server.ts": `export function load({ url }: { url: URL }) {
  return { value: url.searchParams.get('value') ?? 'initial' };
}
`,
      "src/routes/+page.svelte": `<script lang="ts">
  let { data } = $props();
  let count = $state(0);
</script>
<h1 id="product-marker">${productMarker}</h1>
<p id="server-value">{data.value}</p>
<button id="increment" onclick={() => count++}>Increment</button>
<output id="count">{count}</output>
`,
      "start.ts": productionLauncher("./build/index.js"),
    },
    commands: lifecycle({
      source: "src/routes/+page.svelte",
      dev: [viteBin, "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
      build: [viteBin, "build"], output: ["build/index.js", "build/handler.js", "build/server/index.js"],
      start: ["start.ts", "{port}"],
    }),
  },
  {
    id: "fullstack-nuxt", family: "fullstack",
    dependencies: { nuxt: "3.19.3", "@nuxt/cli": "3.29.0", vue: "3.5.22", nitropack: "2.12.6", typescript: "5.9.3" },
    features: ["ssr-query", "query-dom", "client-interaction"],
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({
  compatibilityDate: '2025-10-01',
  ssr: true,
  telemetry: false,
  devtools: { enabled: false },
  nitro: { preset: 'node-server' },
});
`,
      "app.vue": `<script setup lang="ts">
const route = useRoute();
const count = ref(0);
const { data } = await useFetch('/api/value', { query: { value: route.query.value ?? 'initial' } });
</script>
<template>
  <main>
    <h1 id="product-marker">${productMarker}</h1>
    <p id="server-value">{{ data?.value }}</p>
    <button id="increment" @click="count++">Increment</button>
    <output id="count">{{ count }}</output>
  </main>
</template>
`,
      "server/api/value.get.ts": `export default defineEventHandler(event => ({ value: String(getQuery(event).value ?? 'initial') }));
`,
      "start.ts": productionLauncher("./.output/server/index.mjs"),
    },
    commands: lifecycle({
      source: "app.vue", dev: [nuxtBin, "dev", "--host", "127.0.0.1", "--port", "{port}"],
      build: [nuxtBin, "build"], output: [".output/server/index.mjs", ".output/nitro.json"],
      start: ["start.ts", "{port}"],
    }),
  },
  {
    id: "fullstack-astro", family: "fullstack",
    dependencies: { astro: "5.14.1", "@astrojs/node": "9.4.4", typescript: "5.9.3" },
    features: ["ssr-query", "query-dom", "client-interaction"],
    files: {
      "astro.config.ts": `import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
export default defineConfig({ output: 'server', adapter: node({ mode: 'standalone' }), devToolbar: { enabled: false } });
`,
      "src/pages/index.astro": `---
const value = Astro.url.searchParams.get('value') ?? 'initial';
---
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Product matrix</title></head><body>
  <h1 id="product-marker">${productMarker}</h1>
  <p id="server-value">{value}</p>
  <button id="increment">Increment</button><output id="count">0</output>
  <script>
    const button = document.querySelector<HTMLButtonElement>('#increment');
    const output = document.querySelector<HTMLOutputElement>('#count');
    if (!button || !output) throw new Error('Counter elements missing');
    let count = 0;
    button.addEventListener('click', () => { output.textContent = String(++count); });
  </script>
</body></html>
`,
      "start.ts": productionLauncher("./dist/server/entry.mjs"),
    },
    commands: lifecycle({
      source: "src/pages/index.astro", dev: [astroBin, "dev", "--host", "127.0.0.1", "--port", "{port}"],
      build: [astroBin, "build"], output: ["dist/server/entry.mjs"], start: ["start.ts", "{port}"],
    }),
  },
  {
    id: "fullstack-react-router", family: "fullstack",
    dependencies: {
      ...reactDependencies, "react-router": "7.9.4", "@react-router/dev": "7.9.4",
      "@react-router/node": "7.9.4", "@react-router/serve": "7.9.4", vite: "7.1.12", typescript: "5.9.3",
    },
    features: ["ssr-query", "query-dom", "client-interaction"],
    files: {
      "tsconfig.json": tsconfig,
      "vite.config.ts": `import { defineConfig } from 'vite';
import { reactRouter } from '@react-router/dev/vite';
export default defineConfig({ plugins: [reactRouter()] });
`,
      "react-router.config.ts": `import type { Config } from '@react-router/dev/config';
export default { ssr: true } satisfies Config;
`,
      "app/routes.ts": `import { index, type RouteConfig } from '@react-router/dev/routes';
export default [index('routes/home.tsx')] satisfies RouteConfig;
`,
      "app/root.tsx": `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
export default function Root() {
  return <html lang="en"><head><meta charSet="utf-8" /><Meta /><Links /></head><body><Outlet /><ScrollRestoration /><Scripts /></body></html>;
}
`,
      "app/routes/home.tsx": `import { useState } from 'react';
import { useLoaderData, type LoaderFunctionArgs } from 'react-router';
export function loader({ request }: LoaderFunctionArgs) {
  return { value: new URL(request.url).searchParams.get('value') ?? 'initial' };
}
export default function Home() {
  const data = useLoaderData<typeof loader>();
  const [count, setCount] = useState(0);
  return <main><h1 id="product-marker">${productMarker}</h1><p id="server-value">{data.value}</p><button id="increment" onClick={() => setCount(count + 1)}>Increment</button><output id="count">{count}</output></main>;
}
`,
      "start.ts": `const port = process.argv[2];
if (!port) throw new Error('Expected a port');
process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
process.env.PORT = port;
process.argv = [process.argv[0], 'react-router-serve', 'build/server/index.js'];
await import('./node_modules/@react-router/serve/bin.js');
`,
    },
    commands: lifecycle({
      source: "app/routes/home.tsx", dev: [routerBin, "dev", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
      build: [routerBin, "build"], output: ["build/server/index.js"], start: ["start.ts", "{port}"],
    }),
  },
  {
    id: "fullstack-solidstart", family: "fullstack",
    dependencies: {
      "@solidjs/start": "1.1.7", "@solidjs/router": "0.15.3", "@solidjs/meta": "0.29.4",
      "solid-js": "1.9.9", vinxi: "0.5.8", vite: "6.3.6", nitropack: "2.12.6", typescript: "5.9.3",
    },
    features: ["ssr-query", "query-dom", "client-interaction"],
    files: {
      "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "preserve", jsxImportSource: "solid-js", target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true } }),
      "app.config.ts": `import { defineConfig } from '@solidjs/start/config';
export default defineConfig({ ssr: true, server: { preset: 'node-server' } });
`,
      "src/app.tsx": `import { Suspense } from 'solid-js';
import { Router } from '@solidjs/router';
import { FileRoutes } from '@solidjs/start/router';
export default function App() {
  return <Router root={props => <Suspense>{props.children}</Suspense>}><FileRoutes /></Router>;
}
`,
      "src/entry-client.tsx": `import { mount, StartClient } from '@solidjs/start/client';
const root = document.getElementById('app');
if (!root) throw new Error('App root missing');
mount(() => <StartClient />, root);
`,
      "src/entry-server.tsx": `import { createHandler, StartServer } from '@solidjs/start/server';
export default createHandler(() => <StartServer document={({ assets, children, scripts }) => <html lang="en"><head><meta charSet="utf-8" />{assets}</head><body><div id="app">{children}</div>{scripts}</body></html>} />);
`,
      "src/routes/index.tsx": `import { createSignal } from 'solid-js';
import { useLocation } from '@solidjs/router';
export default function Home() {
  const location = useLocation();
  const [count, setCount] = createSignal(0);
  const value = () => new URLSearchParams(location.search).get('value') ?? 'initial';
  return <main><h1 id="product-marker">${productMarker}</h1><p id="server-value">{value()}</p><button id="increment" onClick={() => setCount(count() + 1)}>Increment</button><output id="count">{count()}</output></main>;
}
`,
    },
    commands: lifecycle({
      source: "src/routes/index.tsx", dev: [vinxiBin, "dev", "--port", "{port}"],
      build: [vinxiBin, "build", "--preset", "node-server"], output: [".output/server/index.mjs", ".output/nitro.json"],
      start: [vinxiBin, "start", "--preset", "node-server", "--host", "127.0.0.1", "--port", "{port}"],
    }),
  },
  {
    id: "fullstack-tanstack-start", family: "fullstack",
    dependencies: {
      ...reactDependencies, "@tanstack/react-start": "1.131.2", "@tanstack/react-router": "1.131.2",
      "@vitejs/plugin-react": "5.0.4", vite: "7.1.12", nitropack: "2.12.6", typescript: "5.9.3",
    },
    features: ["ssr-query", "query-dom", "client-interaction"],
    files: {
      "tsconfig.json": tsconfig,
      "vite.config.ts": `import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [tanstackStart({ target: 'node-server', customViteReactPlugin: true, tsr: { srcDirectory: 'src' } }), react()] });
`,
      "src/router.tsx": `import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
export function createRouter() {
  return createTanStackRouter({ routeTree, scrollRestoration: true });
}
declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof createRouter> }
}
`,
      "src/routes/__root.tsx": `import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
export const Route = createRootRoute({ component: Root });
function Root() {
  return <html lang="en"><head><meta charSet="utf-8" /><HeadContent /></head><body><Outlet /><Scripts /></body></html>;
}
`,
      "src/routes/index.tsx": `import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/')({
  loader: ({ location }) => ({ value: new URLSearchParams(location.searchStr).get('value') ?? 'initial' }),
  component: Home,
});
function Home() {
  const data = Route.useLoaderData();
  const [count, setCount] = useState(0);
  return <main><h1 id="product-marker">${productMarker}</h1><p id="server-value">{data.value}</p><button id="increment" onClick={() => setCount(count + 1)}>Increment</button><output id="count">{count}</output></main>;
}
`,
      "start.ts": productionLauncher("./.output/server/index.mjs"),
    },
    commands: lifecycle({
      source: "src/routes/index.tsx", dev: [viteBin, "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
      build: [viteBin, "build"], output: [".output/server/index.mjs", ".output/nitro.json"], start: ["start.ts", "{port}"],
    }),
  },
];
