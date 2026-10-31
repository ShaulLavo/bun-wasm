import { fullstackApps } from "../../scripts/app-matrix/product-fullstack.ts";
import type { Fixture } from "../shell-product/model.ts";

export type FinishlineFixture = Fixture & { editPath: string };

export const targets = ["vite-react", "next", "sveltekit", "nuxt", "astro", "react-router", "solidstart", "tanstack-start", "hono", "express"] as const;

const config = `import { defineConfig } from 'vite';
export default defineConfig({ plugins: [{ name: 'framework-server', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    try { const { default: handler } = await server.ssrLoadModule('/server.ts'); handler(req, res, next); }
    catch (error) { next(error); }
  });
} }] });
`;
function server(id: "hono" | "express"): FinishlineFixture {
  const marker = `TEN_${id.toUpperCase()}_ORIGINAL`;
  const app = id === "hono" ? `import { Hono } from 'hono';
const app = new Hono();
app.get('/', c => c.html('<!doctype html><h1 id="app-marker">${marker}</h1>'));
export default app;
` : `import express from 'express';
const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><h1 id="app-marker">${marker}</h1>'));
export default app;
`;
  return {
    id, editPath: "app.ts", selector: "#app-marker", text: marker, tool: "vite", buildOutputs: ["dist/production.js"],
    dependencies: id === "hono" ? { hono: "4.10.2", "@hono/node-server": "2.1.1", vite: "7.1.12" } : { express: "5.1.0", vite: "7.1.12" },
    files: {
      "app.ts": app, "vite.config.ts": config,
      "server.ts": id === "hono" ? "import app from './app';\nimport { getRequestListener } from '@hono/node-server';\nexport default getRequestListener(app.fetch);\n" : "export { default } from './app';\n",
      "production.ts": id === "hono" ? "import app from './app';\nBun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3137), fetch: app.fetch });\n" : "import app from './app';\napp.listen(Number(process.env.PORT ?? 3137), '127.0.0.1');\n",
    },
    scripts: { dev: "vite --host 127.0.0.1 --strictPort --port ${PORT:-3137}", build: "bun build production.ts --target=bun --outdir=dist", start: "bun run dist/production.js" },
  };
}
function sveltekit(): FinishlineFixture {
  const app = fullstackApps.find(app => app.id === "fullstack-sveltekit");
  if (!app) throw new Error("Missing maintained SvelteKit fixture");
  const command = app.commands.find(command => command.name === "dev");
  if (command?.check.kind !== "page") throw new Error("Missing SvelteKit dev page contract");
  const build = app.commands.find(command => command.name === "build");
  if (build?.check.kind !== "files" || !command.check.hmr) throw new Error("Missing SvelteKit build or edit contract");
  return {
    id: app.id, editPath: command.check.hmr.path, files: app.files, dependencies: app.dependencies,
    selector: command.check.selector, text: command.check.text, tool: "vite", buildOutputs: build.check.paths,
    scripts: {
      dev: "vite --host 127.0.0.1 --strictPort --port ${PORT:-3137}",
      build: "vite build",
      start: "bun run start.ts ${PORT:-3137}",
    },
  };
}
export function recipe(id: string): FinishlineFixture {
  if (id === "hono" || id === "express") return server(id);
  if (id === "sveltekit") return sveltekit();
  throw new Error(`Select one remaining app: hono, express or sveltekit, got ${id}`);
}
