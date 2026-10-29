import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  expect(bundled.urls).toHaveLength(24);
  for (const url of bundled.urls) {
    if (typeof url !== "string") throw new Error("Invalid base asset URL");
    expect(new URL(url).pathname).toStartWith("/nested/app/programs/base/");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect((await response.bytes()).subarray(0, 4)).toEqual(new Uint8Array([0, 97, 115, 109]));
  }
  expect(requests()).toBe(24);
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
    expect(bundled).toMatchObject({ count: 24 });
    expect(await Bun.file(join(out, "programs/base/waffle-coreutils/dist/cat.wasm")).exists()).toBe(true);
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    await rm(root, { recursive: true, force: true });
  }
});
