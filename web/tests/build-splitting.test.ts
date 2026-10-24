import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrowserEntries, buildClassicWorker, browserBuildConfig } from "../../scripts/browser-build";
import { initialJavaScript } from "../../scripts/runtime-size";

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

for (const fixture of [
  { name: "realm-local inline shared code", lazy: "export const lazy = 'dynamic chunk';", chunks: 1, initial: 1 },
  { name: "worker-local static and dynamic chunks", lazy: "import { shared } from './shared'; export const lazy = shared('dynamic chunk');", chunks: 2, initial: 2 },
]) test(`${fixture.name} preserves the complete worker scope`, async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../node_modules/.split-test-"));
  owned.push(dir);
  await Bun.write(join(dir, "shared.ts"), "export const shared = (value: string) => value.toUpperCase();");
  await Bun.write(join(dir, "lazy.ts"), fixture.lazy);
  await Bun.write(join(dir, "main.ts"), "import { shared } from './shared'; console.log(shared('page'));");
  await Bun.write(join(dir, "worker.ts"), "import { shared } from './shared'; postMessage([shared('worker'), (await import('./lazy')).lazy]);");
  const out = join(dir, "dist");
  const result = await buildBrowserEntries([join(dir, "main.ts"), join(dir, "worker.ts")], out);
  const chunks = result.outputs.filter((output) => output.kind === "chunk");
  expect(chunks).toHaveLength(fixture.chunks);
  const outputs = result.metafile!.outputs;
  const workerKey = Object.keys(outputs).find((path) => path.endsWith("/worker.js"))!;
  const initial = initialJavaScript(outputs, [workerKey]);
  expect(initial).toHaveLength(fixture.initial);
  const mainKey = Object.keys(outputs).find((path) => path.endsWith("/main.js"))!;
  expect(initialJavaScript(outputs, [mainKey])).toEqual([mainKey]);
  const initialCode = (await Promise.all(initial.map((path) => Bun.file(join(out, path)).text()))).join("\n");
  expect(initialCode).toContain("toUpperCase");
  expect(initialCode).not.toContain("dynamic chunk");
  expect(initialCode).not.toContain("DYNAMIC CHUNK");
  expect(initial.some((path) => path.endsWith("/worker.js"))).toBe(true);
  expect(await Bun.file(join(out, "__bunwasm/worker.js")).text()).toBe(await Bun.file(join(out, "worker.js")).text());
  for (const chunk of chunks) {
    const path = chunk.path.slice(out.length + 1);
    expect(path).toStartWith("chunks/");
    expect(await Bun.file(join(out, "__bunwasm", path)).text()).toBe(await chunk.text());
  }
});

test("runtime-free entries do not require the runtime package", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../node_modules/.runtime-free-test-"));
  owned.push(dir);
  const main = join(dir, "main.ts");
  await Bun.write(main, "console.log('runtime-free');");
  const result = await Bun.build(browserBuildConfig([main], join(dir, "dist")));
  expect(result.success).toBe(true);
});

async function sandboxOnlyInstall() {
  // Outside this checkout: none of the installed web dependencies can mask a missing resolver.
  const scratch = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const dir = await mkdtemp(join(scratch, "bun-wasm-resolver-"));
  owned.push(dir);
  const main = join(dir, "sandbox/src/main.ts");
  const worker = join(dir, "web/src/worker.ts");
  const dependency = join(dir, "sandbox/node_modules/waffle");
  await Bun.write(join(dependency, "package.json"), JSON.stringify({
    name: "waffle", type: "module",
    exports: { "./core": "./dist/public-core.ts", "./core/memory-views": "./dist/public-views.ts" },
  }));
  await Bun.write(join(dependency, "dist/public-core.ts"), "export const core = 'core from sandbox install';");
  await Bun.write(join(dependency, "dist/public-views.ts"), "export const views = 'views from sandbox install';");
  await Bun.write(join(dependency, "private.ts"), "export const secret = 'not exported';");
  await Bun.write(join(dir, "web/src/fs.ts"), "import { core } from 'waffle/core'; import { views } from 'waffle/core/memory-views'; export const shared = [core, views];");
  await Bun.write(main, "import { shared } from '../../web/src/fs'; console.log(shared);");
  await Bun.write(worker, "import { shared } from './fs'; postMessage(shared);");
  expect(() => Bun.resolveSync("waffle/core", join(dir, "web/src"))).toThrow();
  expect(await Bun.file(join(dir, "web/node_modules/waffle/package.json")).exists()).toBe(false);
  return { dir, main, worker };
}

test("sandbox-only install resolves shared web sources through the consumer's package exports", async () => {
  const { dir, main, worker } = await sandboxOnlyInstall();
  const result = await buildBrowserEntries([main, worker], join(dir, "sandbox/dist"));
  const javascript = (await Promise.all(result.outputs.filter((output) => output.path.endsWith(".js")).map((output) => output.text()))).join("\n");
  expect(javascript).toContain("core from sandbox install");
  expect(javascript).toContain("views from sandbox install");
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.some((path) => path.endsWith("sandbox/node_modules/waffle/dist/public-core.ts"))).toBe(true);
  expect(inputs.some((path) => path.endsWith("sandbox/node_modules/waffle/dist/public-views.ts"))).toBe(true);
});

test("consumer runtime resolution does not expose unexported package files", async () => {
  const { dir, main, worker } = await sandboxOnlyInstall();
  await Bun.write(join(dir, "web/src/fs.ts"), "import { secret } from 'waffle/private.ts'; export const shared = secret;");
  await expect(buildBrowserEntries([main, worker], join(dir, "sandbox/dist"))).rejects.toThrow();
});

test("service worker remains a standalone classic script alongside split entries", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../node_modules/.split-test-"));
  owned.push(dir);
  await Bun.write(join(dir, "shared.ts"), "export const value = 'classic';");
  await Bun.write(join(dir, "sw.ts"), "import { value } from './shared'; self.addEventListener('message', event => event.source.postMessage(value));");
  const result = await buildClassicWorker(join(dir, "sw.ts"), join(dir, "dist"));
  expect(result.outputs).toHaveLength(1);
  const source = await result.outputs[0]!.text();
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
  expect(source).not.toMatch(/\bexport\s/);
});


test("lazy worker chunks never import their worker entry again", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../node_modules/.worker-identity-test-"));
  owned.push(dir);
  await Bun.write(join(dir, "main.ts"), "console.log('page');");
  await Bun.write(join(dir, "worker.ts"), "export class Token {} self.onmessage = async () => postMessage((await import('./lazy')).make() instanceof Token);");
  await Bun.write(join(dir, "lazy.ts"), "import { Token } from './worker'; export const make = () => new Token();");
  const out = join(dir, "dist");
  const result = await buildBrowserEntries([join(dir, "main.ts"), join(dir, "worker.ts")], out);
  const outputs = result.metafile!.outputs;
  const worker = Object.keys(outputs).find(path => path.endsWith("/worker.js"))!;
  expect(outputs[worker]!.imports).toHaveLength(1);
  for (const output of Object.values(outputs)) expect(output.imports.some(imported => imported.path === worker)).toBe(false);
  expect(result.outputs.some(output => output.path.includes("bunwasm-worker-anchor"))).toBe(false);
  expect(await Bun.file(join(out, "bunwasm-worker-anchor.js")).exists()).toBe(false);
  expect(Object.keys(result.metafile!.inputs).some(path => path.includes("bunwasm-worker-anchor"))).toBe(false);
  expect(initialJavaScript(outputs, [worker]).length).toBeGreaterThan(1);
});
