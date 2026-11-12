import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const producer = join(import.meta.dir, "bash-web-guests.ts");
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
type Layout = "hoisted" | "nested" | "isolated";

async function packageEntry(directory: string, name: string, source: string) {
  await Bun.write(join(directory, "package.json"), JSON.stringify({ name, type: "module", exports: "./src/index.ts" }));
  await Bun.write(join(directory, "src/index.ts"), source);
}

async function installation(root: string, layout: Layout) {
  const modules = join(root, "node_modules");
  const base = layout === "isolated" ? join(modules, ".bun/base/node_modules/waffle-base") : join(modules, "waffle-base");
  const family = layout === "hoisted" ? join(modules, "waffle-coreutils") : join(base, "node_modules/waffle-coreutils");
  await Bun.write(join(root, "package.json"), JSON.stringify({ dependencies: { "waffle-base": "fixture" } }));
  await packageEntry(base, "waffle-base", 'export { coreutilsPrograms as basePrograms } from "waffle-coreutils";');
  await packageEntry(family, "waffle-coreutils", 'export const coreutilsPrograms = [{ path: "/usr/bin/env", aliases: ["/bin/env"], wasm: new URL("../payload%20%23%20%C3%BC/env.wasm", import.meta.url) }];');
  const asset = join(family, "payload # ü/env.wasm");
  await Bun.write(asset, bytes);
  if (layout === "isolated") await symlink(base, join(modules, "waffle-base"), "dir");
  if (layout !== "hoisted") await Bun.write(join(modules, "waffle-coreutils/dist/env.wasm"), "wrong root package");
  const dist = join(root, "dist");
  await mkdir(dist);
  return { asset, base, dist };
}

function stage(root: string, dist: string) {
  return Bun.spawnSync([process.execPath, producer, "stage-env", root, dist], { stdout: "pipe", stderr: "pipe" });
}

async function checkLayout(layout: Layout) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-shell-env-"));
  try {
    const { dist } = await installation(root, layout);
    const result = stage(root, dist);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(dist, "bash-web-env.wasm")).bytes()).toEqual(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const layout of ["hoisted", "nested", "isolated"] as const)
  test(`Shell env staging follows the consuming ${layout} package graph and metadata URL`, () => checkLayout(layout));

test("Shell env staging identifies a missing asset without using the root package", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-shell-env-missing-"));
  try {
    const { asset, dist } = await installation(root, "isolated");
    await rm(asset);
    const result = stage(root, dist);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Missing waffle-base env WASM asset");
    expect(result.stderr.toString()).toContain(asset);
    expect(await Bun.file(join(dist, "bash-web-env.wasm")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Shell env staging identifies missing public env metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-shell-env-metadata-"));
  try {
    const { base, dist } = await installation(root, "hoisted");
    await packageEntry(base, "waffle-base", "export const basePrograms = [];");
    const result = stage(root, dist);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("waffle-base has no env WASM program");
    expect(await Bun.file(join(dist, "bash-web-env.wasm")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
