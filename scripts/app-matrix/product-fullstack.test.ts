import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { fullstackApps } from "./product-fullstack.ts";
import { productMarker, type ProductApp, type ProductCommand } from "./product-types.ts";

function command(app: ProductApp, name: string): ProductCommand {
  const selected = app.commands.find(entry => entry.name === name);
  if (!selected) throw new Error(`${app.id} has no ${name} command`);
  return selected;
}

function app(id: string): ProductApp {
  const selected = fullstackApps.find(entry => entry.id === id);
  if (!selected) throw new Error(`Missing ${id}`);
  return selected;
}

function checkEntryPoint(fixture: ProductApp, entry: string | undefined) {
  if (!entry) throw new Error(`${fixture.id} has no executable`);
  if (!entry.startsWith("node_modules/")) {
    expect(fixture.files[entry]).toBeString();
    return;
  }
  const owners = Object.keys(fixture.dependencies).filter(name => entry.startsWith(`node_modules/${name}/`));
  expect(owners).toHaveLength(1);
}

test("six distinct fullstack fixtures cover the requested frameworks", () => {
  expect(fullstackApps.map(fixture => fixture.id)).toEqual([
    "fullstack-sveltekit", "fullstack-nuxt", "fullstack-astro", "fullstack-react-router",
    "fullstack-solidstart", "fullstack-tanstack-start",
  ]);
  expect(new Set(fullstackApps.map(fixture => fixture.id)).size).toBe(6);
});

for (const fixture of fullstackApps) {
  test(`${fixture.id}: exact dependencies and real executable entry points`, () => {
    expect(fixture.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    expect(fixture.family).toBe("fullstack");
    for (const version of Object.values(fixture.dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const stage of fixture.commands) checkEntryPoint(fixture, stage.args[1]);
    expect(fixture.files["package.json"]).toBeUndefined();
  });

  test(`${fixture.id}: source edit changes exactly one rendered marker`, () => {
    const dev = command(fixture, "dev");
    expect(dev.check.kind).toBe("page");
    if (dev.check.kind !== "page" || !dev.check.hmr) throw new Error("Missing dev page/HMR check");
    const edit = dev.check.hmr;
    const source = fixture.files[edit.path];
    if (!source) throw new Error(`Missing ${edit.path}`);
    expect(source.split(edit.search)).toHaveLength(2);
    expect(edit.search).toBe(productMarker);
    expect(edit.replacement).toBe(`${productMarker} updated`);
    expect(source.replace(edit.search, edit.replacement)).toContain(`<h1 id="product-marker">${edit.replacement}</h1>`);
    expect(dev.check.selector).toBe("#product-marker");
    expect(dev.args).toContain("{port}");
  });

  test(`${fixture.id}: production checks server artifacts and starts after build`, () => {
    expect(fixture.commands.map(stage => stage.name)).toEqual(["dev", "build", "start"]);
    const build = command(fixture, "build");
    const start = command(fixture, "start");
    expect(start.after).toBe("build");
    expect(build.check.kind).toBe("files");
    if (build.check.kind !== "files") throw new Error("Build must inspect output");
    expect(build.check.paths.length).toBeGreaterThan(0);
    expect(build.check.paths.some(path => /(?:build|dist|\.output)\/.*(?:index\.m?js|entry\.mjs)$/.test(path))).toBe(true);
    expect(build.check.paths.every(path => !path.includes("node_modules/") && !path.endsWith(".html"))).toBe(true);
    expect(start.check.kind).toBe("page");
    expect(start.args).toContain("{port}");
    expect(start.args).not.toContain("dev");
    expect(start.args).not.toContain("preview");
    const launcher = fixture.files["start.ts"];
    if (launcher) expect(build.check.paths.some(path => launcher.includes(path))).toBe(true);
  });

  test(`${fixture.id}: dev and built server require SSR query data, DOM and interaction`, () => {
    for (const name of ["dev", "start"]) checkPageProbes(fixture, name);
  });

  test(`${fixture.id}: generated TypeScript parses without runtime shims or hand-written JavaScript`, () => {
    for (const [path, source] of Object.entries(fixture.files)) checkSource(path, source);
  });
}

function checkPageProbes(fixture: ProductApp, name: string) {
  const stage = command(fixture, name);
  if (stage.check.kind !== "page") throw new Error(`Missing ${name} page check`);
  const probes = stage.check.probes ?? [];
  expect(stage.check.text).toBe(productMarker);
  const ids: readonly string[] = probes.map(probe => probe.id);
  expect(ids).toEqual(fixture.features ?? []);
  const response = probes.find(probe => probe.kind === "response");
  if (!response || response.kind !== "response" || !response.text) throw new Error("Missing SSR response check");
  expect(response.status).toBe(200);
  expect(new URL(response.path, "http://fixture.invalid").searchParams.get("value")).toBe(response.text);
  expect(Object.values(fixture.files).join("\n")).not.toContain(response.text);
  expect(probes).toContainEqual({ kind: "route", id: "query-dom", path: response.path, selector: "#server-value", text: response.text });
  expect(probes).toContainEqual({ kind: "action", id: "client-interaction", path: "/", button: "#increment", selector: "#count", text: "1" });
}

function checkSource(path: string, source: string) {
  expect(path).not.toMatch(/\.(?:[cm]?js|jsx)$/);
  expect(path).not.toMatch(/(?:^|\/)(?:\.\.|node_modules)(?:\/|$)/);
  expect(source).not.toMatch(/Bun\.serve|createServer\(|globalThis\.[\w]+\s*=|Object\.defineProperty\(process/);
  if (!/\.tsx?$/.test(path)) return;
  const parser = new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts", target: "browser" });
  expect(() => parser.transformSync(source)).not.toThrow();
}

test("React Router supplies a Bun-compatible server entry instead of the Node-only auto-install default", () => {
  const fixture = app("fullstack-react-router");
  const entry = fixture.files["app/entry.server.tsx"];
  expect(entry).toBeString();
  expect(entry).toContain("renderToReadableStream");
  expect(entry).not.toContain("renderToPipeableStream");
  expect(entry).toContain("ServerRouter");
  expect(entry).toContain("signal: request.signal");
  expect(entry).toContain("await body.allReady");
  expect(entry).toContain("new Response(body");
});

test("SvelteKit uses the node adapter and a server-only loader, never static prerender", () => {
  const fixture = app("fullstack-sveltekit");
  expect(fixture.dependencies["@sveltejs/adapter-node"]).toBe("5.3.2");
  expect(fixture.dependencies["@sveltejs/adapter-static"]).toBeUndefined();
  expect(fixture.files["svelte.config.ts"]).toContain("@sveltejs/adapter-node");
  expect(fixture.files["src/routes/+page.server.ts"]).toContain("url.searchParams.get('value')");
  expect(Object.values(fixture.files).join("\n")).not.toContain("prerender = true");
});

test("Astro emits a standalone server, not the existing static-only fixture", () => {
  const fixture = app("fullstack-astro");
  expect(fixture.files["astro.config.ts"]).toContain("output: 'server'");
  expect(fixture.files["astro.config.ts"]).toContain("mode: 'standalone'");
  expect(fixture.files["src/pages/index.astro"]).toContain("Astro.url.searchParams.get('value')");
});

test("Nuxt fetches request data through its real server API", () => {
  const fixture = app("fullstack-nuxt");
  expect(fixture.files["nuxt.config.ts"]).toContain("ssr: true");
  expect(fixture.files["nuxt.config.ts"]).toContain("preset: 'node-server'");
  expect(fixture.files["app.vue"]).toContain("await useFetch('/api/value'");
  expect(fixture.files["server/api/value.get.ts"]).toContain("getQuery(event).value");
});

test("React Router uses framework mode, server loader and official production server", () => {
  const fixture = app("fullstack-react-router");
  expect(fixture.files["vite.config.ts"]).toContain("@react-router/dev/vite");
  expect(fixture.files["react-router.config.ts"]).toContain("ssr: true");
  expect(fixture.files["app/routes/home.tsx"]).toContain("export function loader");
  expect(fixture.files["start.ts"]).toContain("@react-router/serve/bin.js");
});

test("React Router selects Bun SSR external exports for its readable server entry", () => {
  const fixture = app("fullstack-react-router");
  expect(fixture.files["vite.config.ts"]).toContain("plugins: [reactRouter()]");
  expect(fixture.files["vite.config.ts"]).toContain("ssr: { resolve: { externalConditions: ['bun', 'node'] } }");
  expect(fixture.files["app/entry.server.tsx"]).toContain("renderToReadableStream");
  expect(fixture.files["app/entry.server.tsx"]).not.toContain("renderToPipeableStream");
});

test("SolidStart and TanStack use their verified integrated Nitro node-server targets", () => {
  const solid = app("fullstack-solidstart");
  expect(solid.files["app.config.ts"]).toContain("ssr: true");
  expect(command(solid, "start").args).toContain("node-server");
  const tanstack = app("fullstack-tanstack-start");
  expect(tanstack.dependencies["@tanstack/react-start"]).toBe("1.131.2");
  expect(tanstack.files["vite.config.ts"]).toContain("target: 'node-server'");
  expect(tanstack.files["src/router.tsx"]).toContain("export function createRouter()");
});

test("feature-owned manifest registers only this catalog test with the quality gate", () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../checks/quality-product-fullstack.json", import.meta.url), "utf8"));
  expect(manifest).toEqual({ owner: "quality", path: "scripts/app-matrix/product-fullstack.test.ts" });
});
