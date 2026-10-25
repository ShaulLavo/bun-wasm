import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { browserBuildConfig, buildBrowserEntries, resolveRuntimePackage } from "./browser-build";

test("browser build uses consumer exports through a dotted Git cache, not sibling source", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-package-resolver-"));
  try {
    const consumer = join(scratch, "consumer");
    const cached = join(scratch, "cache", "@bun-wasm.runtime.git.dead..beef");
    await mkdir(cached, { recursive: true });
    await mkdir(join(consumer, "node_modules/@bun-wasm"), { recursive: true });
    await writeFile(join(cached, "package.json"), JSON.stringify({ name: "waffle", type: "module", exports: { "./core": { types: "./wrong.d.ts", browser: "./browser.ts", node: "./wrong.js" }, "./errors": "./errors.ts", "./blocked": { browser: null, default: "./browser.ts" } } }));
    await writeFile(join(cached, "errors.ts"), 'export class RuntimeError extends Error {}');
    await writeFile(join(cached, "browser.ts"), 'import { RuntimeError } from "./errors.js"; export const provenance = "consumer-installed-git"; export const makeError = () => new RuntimeError();');
    await symlink(cached, join(consumer, "node_modules/waffle"));
    const entry = join(consumer, "main.ts");
    await writeFile(entry, 'export { provenance } from "waffle/core";');
    const installed = resolveRuntimePackage(entry);
    expect(installed.physical).toBe(cached);
    expect(installed.source("waffle/core")).toBe(join(consumer, "node_modules/waffle/browser.ts"));
    expect(() => installed.source("waffle/internal/private")).toThrow("not exported");
    expect(() => installed.source("waffle/blocked")).toThrow("not exported");
    const errors = join(consumer, "node_modules/waffle/errors.ts");
    expect(installed.relativeSource("./errors.js", installed.source("waffle/core"))).toBe(errors);
    expect(installed.relativeSource("./errors.js", join(cached, "browser.ts"))).toBe(errors);
    expect(installed.relativeSource("./errors.js", entry)).toBeUndefined();
    await writeFile(join(scratch, "cache/escape.ts"), "export {};");
    expect(() => installed.relativeSource("../escape.ts", join(cached, "browser.ts"))).toThrow("escapes installed package");
    const { outdir: _outdir, ...config } = browserBuildConfig([entry], join(scratch, "output"));
    const result = await Bun.build(config);
    expect(result.success).toBe(true);
    expect(await result.outputs[0]!.text()).toContain("consumer-installed-git");
    await writeFile(entry, 'import { makeError } from "waffle/core"; import { RuntimeError } from "waffle/errors"; globalThis.sameErrorClass = makeError() instanceof RuntimeError;');
    const identityBuild = await Bun.build({ ...config, format: "iife", splitting: false });
    expect(identityBuild.success).toBe(true);
    const context = { sameErrorClass: false };
    runInNewContext(await identityBuild.outputs[0]!.text(), context);
    expect(context.sameErrorClass).toBe(true);
    expect(installed.relativeInput(join(cached, "proc/supervisor.ts"))).toBe("proc/supervisor.ts");
    expect(installed.relativeInput(join(dirname(cached), "unrelated/proc/supervisor.ts"))).toBeUndefined();
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("browser realms tree-shake shared modules independently", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-realm-build-"));
  try {
    await writeFile(join(scratch, "shared.ts"), 'export const common = () => "common-marker"; export const page = () => "page-only-marker"; export const worker = () => "worker-only-marker";');
    await writeFile(join(scratch, "main.ts"), 'import { common, page } from "./shared"; console.log(common(), page());');
    await writeFile(join(scratch, "worker.ts"), 'import { common, worker } from "./shared"; console.log(common(), worker());');
    const build = await buildBrowserEntries([join(scratch, "main.ts"), join(scratch, "worker.ts")], join(scratch, "dist"));
    const code = await Bun.file(join(scratch, "dist/worker.js")).text();
    expect(code).toContain("worker-only-marker");
    expect(code).toContain("common-marker");
    expect(code).not.toContain("page-only-marker");
    const output = Object.entries(build.metafile!.outputs).find(([path]) => path.endsWith("/worker.js"))?.[1];
    expect(output).toBeDefined();
    expect(output!.imports).toEqual([]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

async function verifyNetworkAssets(outdir: string, expected: Uint8Array<ArrayBuffer>, scoped: boolean) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const file = Bun.file(join(outdir, new URL(request.url).pathname));
      return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  try {
    const references: string[] = [];
    for await (const path of new Bun.Glob("**/*.js").scan(outdir)) {
      const code = await Bun.file(join(outdir, path)).text();
      if (!/new URL\(["']\.\/network\.wasm["'],\s*import\.meta\.url\)/.test(code)) continue;
      references.push(new URL("./network.wasm", new URL(path, server.url)).href);
    }
    expect(references.length).toBeGreaterThan(0);
    if (scoped) {
      expect(references.some(url => url.includes("/__bunwasm/chunks/"))).toBe(true);
      expect(references.some(url => url.includes("/chunks/") && !url.includes("/__bunwasm/"))).toBe(true);
    }
    for (const url of references) {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/wasm");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes).toEqual(expected);
      const module = await WebAssembly.compileStreaming(fetch(url));
      expect(WebAssembly.Module.exports(module).some(item => item.name === "tcp_dispose")).toBe(true);
    }
    const missing = references[0]!;
    await rm(join(outdir, new URL(missing).pathname));
    expect((await fetch(missing)).status).toBe(404);
    await expect(WebAssembly.compileStreaming(fetch(missing))).rejects.toThrow();
  } finally { await server.stop(true); }
}

for (const split of [false, true]) test(`browser network asset is served beside ${split ? "split and scoped" : "unsplit"} emitted code`, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-network-asset-"));
  try {
    const installed = resolveRuntimePackage(import.meta.filename);
    await mkdir(join(scratch, "node_modules"));
    await symlink(installed.physical, join(scratch, "node_modules/waffle"));
    const asset = join(dirname(installed.source("waffle/network")), "network.wasm");
    const expected = new Uint8Array(await Bun.file(asset).arrayBuffer());
    const checksum = await Bun.file(join(dirname(asset), "network.sha256")).text();
    expect(new Bun.CryptoHasher("sha256").update(expected).digest("hex")).toBe(checksum);
    const main = join(scratch, "main.ts"), worker = join(scratch, "worker.ts");
    await writeFile(main, 'export { loadNetworkModule } from "waffle/network";');
    await writeFile(worker, 'self.onmessage = async () => postMessage(await (await import("waffle/network")).loadNetworkModule());');
    const outdir = join(scratch, "dist");
    const result = split
      ? await buildBrowserEntries([main, worker], outdir)
      : await Bun.build(browserBuildConfig([main], outdir, { splitting: false }));
    expect(result.success).toBe(true);
    await verifyNetworkAssets(outdir, expected, split);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

for (const failure of ["missing", "corrupt"]) test(`browser build rejects a ${failure} installed network artifact`, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-network-receipt-"));
  try {
    const installed = resolveRuntimePackage(import.meta.filename);
    const loader = installed.source("waffle/network");
    const dependency = join(scratch, "node_modules/waffle");
    await mkdir(join(dependency, "browser/net"), { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "waffle", type: "module", exports: { "./network": "./browser/net/module.ts" } }));
    await Bun.write(join(dependency, "browser/net/module.ts"), Bun.file(loader));
    await Bun.write(join(dependency, "browser/net/network.sha256"), Bun.file(join(dirname(loader), "network.sha256")));
    if (failure === "corrupt") await writeFile(join(dependency, "browser/net/network.wasm"), "not the selected asset");
    const main = join(scratch, "main.ts");
    await writeFile(main, 'export { loadNetworkModule } from "waffle/network";');
    const config = browserBuildConfig([main], join(scratch, "dist"));
    await expect(Bun.build(config)).rejects.toThrow(failure === "corrupt" ? "checksum mismatch" : "ENOENT");
    expect(await Bun.file(join(scratch, "dist/network.wasm")).exists()).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
