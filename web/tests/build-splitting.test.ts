import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildBrowserEntries, buildClassicWorker } from "../../scripts/browser-build";
import { initialJavaScript } from "../../scripts/runtime-size";

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("split main/worker graph has all static and dynamic chunks in the worker scope", async () => {
  const dir = await mkdtemp(join(import.meta.dir, "../node_modules/.split-test-"));
  owned.push(dir);
  await Bun.write(join(dir, "shared.ts"), "export const shared = (value: string) => value.toUpperCase();");
  await Bun.write(join(dir, "lazy.ts"), "export const lazy = 'dynamic chunk';");
  await Bun.write(join(dir, "main.ts"), "import { shared } from './shared'; console.log(shared('page'));");
  await Bun.write(join(dir, "worker.ts"), "import { shared } from './shared'; postMessage([shared('worker'), (await import('./lazy')).lazy]);");
  const out = join(dir, "dist");
  const result = await buildBrowserEntries([join(dir, "main.ts"), join(dir, "worker.ts")], out);
  const chunks = result.outputs.filter((output) => output.kind === "chunk");
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  const outputs = result.metafile!.outputs;
  const workerKey = Object.keys(outputs).find((path) => path.endsWith("/worker.js"))!;
  const initial = initialJavaScript(outputs, [workerKey]);
  expect(initial).toHaveLength(2); // bootstrap plus shared chunk, not the dynamic chunk
  expect(initial.some((path) => path.endsWith("/worker.js"))).toBe(true);
  expect(await Bun.file(join(out, "__bunwasm/worker.js")).text()).toBe(await Bun.file(join(out, "worker.js")).text());
  for (const chunk of chunks) {
    const path = chunk.path.slice(out.length + 1);
    expect(path).toStartWith("chunks/");
    expect(await Bun.file(join(out, "__bunwasm", path)).text()).toBe(await chunk.text());
  }
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
