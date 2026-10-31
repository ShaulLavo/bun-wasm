import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { baseProgramAssets } from "../../scripts/base-program-build";
import { browserBuildConfig } from "../../scripts/browser-build";

async function buildAssets(root: string) {
  const modules = join(root, "node_modules");
  await mkdir(modules);
  for (const name of ["waffle", "waffle-base", "waffle-coreutils", "waffle-findutils", "waffle-grep", "waffle-ripgrep", "waffle-sed"])
    await symlink(resolve(import.meta.dir, "../node_modules", name), join(modules, name), "dir");
  const entry = join(root, "entry.ts");
  await Bun.write(entry, 'import { basePrograms } from "waffle-base"; export const urls = basePrograms.map(program => program.wasm.href);');
  const out = join(root, "out");
  const result = await Bun.build(browserBuildConfig([entry], out));
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return out;
}

async function buildTransitiveBaseAssets(root: string) {
  const modules = join(root, "node_modules");
  await mkdir(modules);
  for (const name of ["waffle", "waffle-base"])
    await symlink(resolve(import.meta.dir, "../node_modules", name), join(modules, name), "dir");
  const entry = join(root, "entry.ts");
  await Bun.write(entry, 'import { basePrograms } from "waffle-base"; export const count = basePrograms.length;');
  const out = join(root, "out");
  const result = await Bun.build(browserBuildConfig([entry], out));
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return { out, entry };
}

async function verifyAssets(out: string, server: ReturnType<typeof Bun.serve>, requests: () => number) {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: new URL("/nested/app/", server.url).href } });
  const bundled: unknown = await import(join(out, "entry.js"));
  expect(requests()).toBe(0);
  if (!bundled || typeof bundled !== "object" || !("urls" in bundled) || !Array.isArray(bundled.urls)) throw new Error("Missing bundled base URLs");
  expect(bundled.urls).toHaveLength(25);
  for (const url of bundled.urls) {
    if (typeof url !== "string") throw new Error("Invalid base asset URL");
    expect(new URL(url).pathname).toStartWith("/nested/app/programs/base/");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect((await response.bytes()).subarray(0, 4)).toEqual(new Uint8Array([0, 97, 115, 109]));
  }
  expect(requests()).toBe(25);
}

test("packed base assets remain lazy and resolve under the app path after bundling", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-base-assets-"));
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  let requests = 0;
  try {
    const out = await buildAssets(root);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests++;
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(out, path.replace(/^\/nested\/app\//, ""))));
    } });
    try {
      await verifyAssets(out, server, () => requests);
    } finally { await server.stop(true); }
  } finally {
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
    await rm(root, { recursive: true, force: true });
  }
});

test("transitive base families resolve from the isolated package scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-base-isolated-scope-"));
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  try {
    const { out } = await buildTransitiveBaseAssets(root);
    Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://example.test/" } });
    const bundled: unknown = await import(join(out, "entry.js"));
    expect(bundled).toMatchObject({ count: 25 });
    expect(await Bun.file(join(out, "programs/base/waffle-coreutils/dist/cat.wasm")).exists()).toBe(true);
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    await rm(root, { recursive: true, force: true });
  }
});

test("base asset staging preserves only supplied wasm representations byte for byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-base-variants-"));
  try {
    const family = join(root, "node_modules/waffle-coreutils");
    await Bun.write(join(family, "package.json"), JSON.stringify({ name: "waffle-coreutils", type: "module", exports: "./src/index.ts" }));
    await Bun.write(join(family, "src/index.ts"), 'export const wasm = new URL("../dist/ls.wasm", import.meta.url).href;');
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const variants = new Map([
      ["ls.wasm", wasm], ["raw-only.wasm", wasm],
      ["ls.wasm.br", brotliCompressSync(wasm)], ["ls.wasm.gz", gzipSync(wasm)],
      ["compressed-only.wasm.br", brotliCompressSync(wasm)],
    ]);
    for (const [name, bytes] of variants) await Bun.write(join(family, "dist", name), bytes);
    await Bun.write(join(family, "dist/README.txt"), "not a program");
    const entry = join(root, "entry.ts");
    await Bun.write(entry, 'export { wasm } from "waffle-coreutils";');
    const outdir = join(root, "out");
    const result = await Bun.build({ entrypoints: [entry], outdir, target: "browser", plugins: [baseProgramAssets(entry)] });
    expect(result.success).toBe(true);
    const staged = join(outdir, "programs/base/waffle-coreutils/dist");
    expect((await readdir(staged)).sort()).toEqual(Array.from(variants.keys()).sort());
    for (const [name, bytes] of variants) expect(await Bun.file(join(staged, name)).bytes()).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
