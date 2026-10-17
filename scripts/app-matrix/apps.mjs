const marker = "bun-wasm app matrix";
const html = `<html><body><h1>${marker}</h1><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>`;
const server = (id, dependencies, source) => ({
  id, dependencies, files: { "server.ts": source },
  commands: [{ name: "start", args: ["run", "server.ts"], check: { kind: "http", text: marker } }],
});
const vite = (id, dependencies, source, extra = {}) => ({
  id, dependencies: { vite: "7.1.12", ...dependencies },
  files: { "index.html": html, "src/main.js": source, ...extra },
  commands: [
    { name: "dev", args: ["run", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "{port}"], check: { kind: "page", selector: "#app", text: marker } },
    { name: "build", args: ["run", "node_modules/vite/bin/vite.js", "build"], check: { kind: "files", paths: ["dist/index.html"], text: marker } },
  ],
});

export const apps = [
  server("hono", { hono: "4.10.2" }, `import { Hono } from 'hono'; const app = new Hono(); app.get('/', c => c.text('${marker}')); Bun.serve({ port: Number(process.env.PORT ?? '3137'), fetch: app.fetch });`),
  server("express", { express: "5.1.0" }, `import express from 'express'; const app = express(); app.get('/', (req, res) => res.send('${marker}')); app.listen(Number(process.env.PORT ?? '3137'), '127.0.0.1');`),
  server("elysia", { elysia: "1.4.13" }, `import { Elysia } from 'elysia'; new Elysia().get('/', () => '${marker}').listen(Number(process.env.PORT ?? '3137'));`),
  server("fastify", { fastify: "5.6.1" }, `import Fastify from 'fastify'; const app = Fastify(); app.get('/', async () => '${marker}'); await app.listen({ port: Number(process.env.PORT ?? '3137'), host: '127.0.0.1' });`),
  server("koa", { koa: "3.0.1" }, `import Koa from 'koa'; const app = new Koa(); app.use(ctx => { ctx.body = '${marker}'; }); app.listen(Number(process.env.PORT ?? '3137'), '127.0.0.1');`),
  vite("vite-vanilla", {}, `document.querySelector('#app').textContent = '${marker}';`),
  vite("vite-react", { react: "19.1.1", "react-dom": "19.1.1" }, `import React from 'react'; import { createRoot } from 'react-dom/client'; createRoot(document.querySelector('#app')).render(React.createElement('p', null, '${marker}'));`),
  vite("vite-vue", { vue: "3.5.22" }, `import { createApp, h } from 'vue'; createApp({ render: () => h('p', '${marker}') }).mount('#app');`),
  {
    id: "astro", dependencies: { astro: "5.14.1" },
    files: { "src/pages/index.astro": `<html><body><h1>${marker}</h1></body></html>` },
    commands: [{ name: "build", args: ["run", "node_modules/astro/astro.js", "build"], check: { kind: "files", paths: ["dist/index.html"], text: marker } }],
  },
  {
    id: "sveltekit", dependencies: { "@sveltejs/kit": "2.43.1", "@sveltejs/adapter-static": "3.0.9", "@sveltejs/vite-plugin-svelte": "6.2.1", svelte: "5.39.11", vite: "7.1.12" },
    files: {
      "svelte.config.js": `import adapter from '@sveltejs/adapter-static'; export default { kit: { adapter: adapter() } };`,
      "vite.config.js": `import { sveltekit } from '@sveltejs/kit/vite'; export default { plugins: [sveltekit()] };`,
      "src/app.html": `<html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>`,
      "src/routes/+page.svelte": `<h1>${marker}</h1>`,
      "src/routes/+layout.js": "export const prerender = true;",
    },
    commands: [
      { name: "dev", args: ["run", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "{port}"], check: { kind: "page", selector: "h1", text: marker } },
      { name: "build", args: ["run", "node_modules/vite/bin/vite.js", "build"], check: { kind: "files", paths: ["build/index.html"], text: marker } },
    ],
  },
  {
    id: "next", dependencies: { next: "15.5.6", react: "19.1.1", "react-dom": "19.1.1" },
    files: {
      "app/layout.js": "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
      "app/page.js": `export default function Page() { return <h1>${marker}</h1>; }`,
    },
    commands: [
      { name: "dev", args: ["run", "node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"], check: { kind: "page", selector: "h1", text: marker } },
      { name: "build", args: ["run", "node_modules/next/dist/bin/next", "build"], check: { kind: "files", paths: [".next/BUILD_ID"], text: "" } },
      { name: "start", after: "build", args: ["run", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "{port}"], check: { kind: "page", selector: "h1", text: marker } },
    ],
  },
  {
    id: "drizzle", dependencies: { "drizzle-orm": "0.44.6" },
    files: { "query.ts": `import { Database } from 'bun:sqlite'; import { drizzle } from 'drizzle-orm/bun-sqlite'; import { sqliteTable, text } from 'drizzle-orm/sqlite-core'; const db = drizzle(new Database(':memory:')); const messages = sqliteTable('messages', { value: text('value').notNull() }); db.run('create table messages (value text not null)'); db.insert(messages).values({ value: '${marker}' }).run(); if (db.select().from(messages).get()?.value !== '${marker}') throw new Error('query mismatch'); console.log('${marker}');` },
    commands: [{ name: "query", args: ["run", "query.ts"], check: { kind: "stdout", text: marker } }],
  },
  {
    id: "prisma", dependencies: { prisma: "6.17.1", "@prisma/client": "6.17.1" },
    files: {
      "prisma/schema.prisma": 'generator client {\n provider = "prisma-client-js"\n}\ndatasource db {\n provider = "sqlite"\n url = "file:./test.db"\n}\nmodel Message {\n id Int @id @default(autoincrement())\n value String\n}\n',
      "query.ts": `import { PrismaClient } from '@prisma/client'; const db = new PrismaClient(); try { await db.message.create({ data: { value: '${marker}' } }); if ((await db.message.findFirst())?.value !== '${marker}') throw new Error('query mismatch'); console.log('${marker}'); } finally { await db.$disconnect(); }`,
    },
    commands: [
      { name: "generate", args: ["run", "node_modules/prisma/build/index.js", "generate"], check: { kind: "files", paths: ["node_modules/.prisma/client/index.js"], text: "" } },
      { name: "schema", after: "generate", args: ["run", "node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], check: { kind: "files", paths: ["prisma/test.db"], text: "" } },
      { name: "query", after: "schema", args: ["run", "query.ts"], check: { kind: "stdout", text: marker } },
    ],
  },
  {
    id: "typescript", dependencies: { typescript: "5.9.3" },
    files: { "index.ts": 'const message: string = "matrix"; export { message };', "invalid.ts": 'const value: string = 42;\n', "tsconfig.json": '{"compilerOptions":{"strict":true,"outDir":"clean-output"},"files":["index.ts"]}' },
    commands: [
      { name: "check", args: ["run", "node_modules/typescript/bin/tsc", "--pretty", "false"], check: { kind: "files", paths: ["clean-output/index.js"], text: "matrix" } },
      { name: "reject", args: ["run", "node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false", "invalid.ts"], check: { kind: "diagnostics", exit: 2, texts: ["error TS2322", "Type 'number' is not assignable to type 'string'"] } },
    ],
  },
  {
    id: "eslint", dependencies: { eslint: "9.38.0" },
    files: { "index.js": "export const message = 1;\n", "invalid.js": "debugger;\n", "eslint.config.js": "export default [{ rules: { 'no-debugger': 'error' } }];" },
    commands: [
      { name: "lint", args: ["run", "node_modules/eslint/bin/eslint.js", "--format", "json", "index.js"], check: { kind: "stdout", text: '"errorCount":0' } },
      { name: "reject", args: ["run", "node_modules/eslint/bin/eslint.js", "--format", "json", "invalid.js"], check: { kind: "diagnostics", exit: 1, texts: ['"ruleId":"no-debugger"', `"message":"Unexpected 'debugger' statement."`, '"errorCount":1'] } },
    ],
  },
  {
    id: "prettier", dependencies: { prettier: "3.6.2" },
    files: { "index.js": "export const message = 1;\n" },
    commands: [{ name: "check", args: ["run", "node_modules/prettier/bin/prettier.cjs", "--check", "index.js"], check: { kind: "stdout", text: "All matched files use Prettier code style" } }],
  },
  {
    id: "vitest", dependencies: { vitest: "3.2.4" },
    files: { "sum.test.js": "import { test, expect } from 'vitest'; test('matrix', () => expect(2 + 2).toBe(4));" },
    commands: [
      { name: "test", args: ["run", "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1", "--no-file-parallelism"], check: { kind: "stdout", text: "1 passed" } },
      { name: "threads", args: ["run", "node_modules/vitest/vitest.mjs", "run", "--pool=threads", "--maxWorkers=1", "--no-file-parallelism"], check: { kind: "stdout", text: "1 passed" } },
    ],
  },
];

export const browserSubset = ["hono", "vite-react", "drizzle", "prettier", "typescript", "eslint"];

export function projectFiles(app, registry) {
  return {
    "package.json": JSON.stringify({ name: `matrix-${app.id}`, private: true, type: "module", dependencies: app.dependencies }, null, 2),
    "bunfig.toml": `[install]\nregistry = ${JSON.stringify(registry)}\n`,
    ...app.files,
  };
}
