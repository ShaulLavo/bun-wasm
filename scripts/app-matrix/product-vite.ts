import { productMarker, type FeatureProbe, type ProductApp, type ProductCommand } from "./product-types.ts";

interface ViteFixture {
  id: string;
  dependencies: Record<string, string>;
  plugin: string;
  files: Record<string, string>;
  entry: string;
  component: string;
}

function viteCommands(component: string): ProductCommand[] {
  const probes: FeatureProbe[] = [{ kind: "action", id: "counter", path: "/", button: "#increment", selector: "#count", text: "Count: 1" }];
  return [
    {
      name: "dev",
      args: ["run", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
      check: { kind: "page", selector: "#message", text: productMarker, hmr: { path: component, search: productMarker, replacement: `${productMarker} updated` }, probes },
    },
    {
      name: "build",
      args: ["run", "node_modules/vite/bin/vite.js", "build"],
      check: { kind: "files", paths: ["dist/index.html", "dist/assets/app.js"], text: productMarker },
    },
    {
      name: "preview",
      after: "build",
      args: ["run", "node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
      check: { kind: "page", selector: "#message", text: productMarker, probes },
    },
  ];
}

function viteApp(fixture: ViteFixture): ProductApp {
  return {
    id: fixture.id,
    family: "vite",
    dependencies: { vite: "7.1.12", ...fixture.dependencies },
    files: {
      "index.html": `<!doctype html><html><head><meta charset="utf-8"><title>${productMarker}</title></head><body><div id="app"></div><script type="module" src="/${fixture.entry}"></script></body></html>`,
      "vite.config.ts": `import { defineConfig } from 'vite';
${fixture.plugin}
export default defineConfig({
  plugins,
  build: { rollupOptions: { output: { entryFileNames: 'assets/app.js' } } },
});
`,
      ...fixture.files,
    },
    commands: viteCommands(fixture.component),
    features: ["dev:http-dom", "dev:hmr-source-edit", "build:html-and-entry-output", "preview:built-dom", "interaction:reactive-counter"],
  };
}

export const viteApps: ProductApp[] = [
  viteApp({
    id: "vite-vanilla",
    dependencies: {},
    plugin: "const plugins = [];",
    entry: "src/main.ts",
    component: "src/main.ts",
    files: {
      "src/main.ts": `const root = document.querySelector('#app');
if (!root) throw new Error('Missing app root');
root.innerHTML = '<h1 id="message">${productMarker}</h1><button id="increment">Increment</button><p id="count">Count: 0</p>';
const button = document.querySelector('#increment');
const output = document.querySelector('#count');
if (!button || !output) throw new Error('Missing counter');
let count = 0;
button.addEventListener('click', () => { output.textContent = 'Count: ' + ++count; });
if (import.meta.hot) import.meta.hot.accept();
`,
    },
  }),
  viteApp({
    id: "vite-react",
    dependencies: { react: "19.1.1", "react-dom": "19.1.1", "@vitejs/plugin-react": "5.0.4" },
    plugin: "import react from '@vitejs/plugin-react';\nconst plugins = [react()];",
    entry: "src/main.tsx",
    component: "src/App.tsx",
    files: {
      "src/main.tsx": `import { createRoot } from 'react-dom/client';
import App from './App';
const root = document.getElementById('app');
if (!root) throw new Error('Missing app root');
createRoot(root).render(<App />);
`,
      "src/App.tsx": `import { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return <main><h1 id="message">${productMarker}</h1><button id="increment" onClick={() => setCount(count + 1)}>Increment</button><p id="count">Count: {count}</p></main>;
}
`,
    },
  }),
  viteApp({
    id: "vite-vue",
    dependencies: { vue: "3.5.22", "@vitejs/plugin-vue": "6.0.1" },
    plugin: "import vue from '@vitejs/plugin-vue';\nconst plugins = [vue()];",
    entry: "src/main.ts",
    component: "src/App.vue",
    files: {
      "src/main.ts": "import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');\n",
      "src/App.vue": `<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
<template><main><h1 id="message">${productMarker}</h1><button id="increment" @click="count++">Increment</button><p id="count">Count: {{ count }}</p></main></template>
`,
    },
  }),
  viteApp({
    id: "vite-svelte",
    dependencies: { svelte: "5.39.11", "@sveltejs/vite-plugin-svelte": "6.2.1" },
    plugin: "import { svelte } from '@sveltejs/vite-plugin-svelte';\nconst plugins = [svelte()];",
    entry: "src/main.ts",
    component: "src/App.svelte",
    files: {
      "src/main.ts": `import { mount } from 'svelte';
import App from './App.svelte';
const target = document.getElementById('app');
if (!target) throw new Error('Missing app root');
mount(App, { target });
`,
      "src/App.svelte": `<script lang="ts">
let count = $state(0);
</script>
<main><h1 id="message">${productMarker}</h1><button id="increment" onclick={() => count++}>Increment</button><p id="count">Count: {count}</p></main>
`,
    },
  }),
  viteApp({
    id: "vite-solid",
    dependencies: { "solid-js": "1.9.9", "vite-plugin-solid": "2.11.8" },
    plugin: "import solid from 'vite-plugin-solid';\nconst plugins = [solid()];",
    entry: "src/main.tsx",
    component: "src/App.tsx",
    files: {
      "src/main.tsx": `import { render } from 'solid-js/web';
import App from './App';
const root = document.getElementById('app');
if (!root) throw new Error('Missing app root');
render(() => <App />, root);
`,
      "src/App.tsx": `import { createSignal } from 'solid-js';
export default function App() {
  const [count, setCount] = createSignal(0);
  return <main><h1 id="message">${productMarker}</h1><button id="increment" onClick={() => setCount(count() + 1)}>Increment</button><p id="count">Count: {count()}</p></main>;
}
`,
    },
  }),
  viteApp({
    id: "vite-preact",
    dependencies: { preact: "10.27.2", "@preact/preset-vite": "2.10.2", "@babel/core": "7.28.4" },
    plugin: "import preact from '@preact/preset-vite';\nconst plugins = [preact()];",
    entry: "src/main.tsx",
    component: "src/App.tsx",
    files: {
      "src/main.tsx": `import { render } from 'preact';
import App from './App';
const root = document.getElementById('app');
if (!root) throw new Error('Missing app root');
render(<App />, root);
`,
      "src/App.tsx": `import { useState } from 'preact/hooks';
export default function App() {
  const [count, setCount] = useState(0);
  return <main><h1 id="message">${productMarker}</h1><button id="increment" onClick={() => setCount(count + 1)}>Increment</button><p id="count">Count: {count}</p></main>;
}
`,
    },
  }),
];
