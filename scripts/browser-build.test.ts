import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { browserBuildConfig, resolveRuntimePackage } from "./browser-build";

test("browser build uses consumer exports through a dotted Git cache, not sibling source", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-package-resolver-"));
  try {
    const consumer = join(scratch, "consumer");
    const cached = join(scratch, "cache", "@bun-wasm.runtime.git.deadbeef");
    await mkdir(cached, { recursive: true });
    await mkdir(join(consumer, "node_modules/@bun-wasm"), { recursive: true });
    await writeFile(join(cached, "package.json"), JSON.stringify({ name: "waffle", type: "module", exports: { "./core": { types: "./wrong.d.ts", browser: "./browser.ts", node: "./wrong.js" }, "./blocked": { browser: null, default: "./browser.ts" } } }));
    await writeFile(join(cached, "browser.ts"), 'export const provenance = "consumer-installed-git";');
    await symlink(cached, join(consumer, "node_modules/waffle"));
    const entry = join(consumer, "main.ts");
    await writeFile(entry, 'export { provenance } from "waffle/core";');
    const installed = resolveRuntimePackage(entry);
    expect(installed.physical).toBe(cached);
    expect(installed.source("waffle/core")).toBe(join(consumer, "node_modules/waffle/browser.ts"));
    expect(() => installed.source("waffle/internal/private")).toThrow("not exported");
    expect(() => installed.source("waffle/blocked")).toThrow("not exported");
    const { outdir: _outdir, ...config } = browserBuildConfig([entry], join(scratch, "output"));
    const result = await Bun.build(config);
    expect(result.success).toBe(true);
    expect(await result.outputs[0]!.text()).toContain("consumer-installed-git");
    expect(installed.relativeInput(join(cached, "proc/supervisor.ts"))).toBe("proc/supervisor.ts");
    expect(installed.relativeInput(join(dirname(cached), "unrelated/proc/supervisor.ts"))).toBeUndefined();
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("isolated consumer exports and runtime relative imports share process class identity", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-class-identity-"));
  try {
    const consumer = join(scratch, "consumer"), cached = join(consumer, "node_modules/.bun/waffle@commit/node_modules/waffle");
    await mkdir(cached, { recursive: true });
    await writeFile(join(cached, "package.json"), JSON.stringify({ name: "waffle", type: "module", exports: { "./control": "./control.ts", "./client": "./client.ts" } }));
    await writeFile(join(cached, "control.ts"), "export class Cell { value = 42; }");
    await writeFile(join(cached, "client.ts"), 'import { Cell } from "./control.js"; export const create = () => new Cell();');
    await symlink(cached, join(consumer, "node_modules/waffle"));
    const entry = join(consumer, "main.ts");
    await writeFile(entry, 'import { Cell } from "waffle/control"; import { create } from "waffle/client"; if (!(create() instanceof Cell)) throw new Error("process cell identity split");');
    const { outdir: _outdir, ...config } = browserBuildConfig([entry], join(scratch, "output"), { splitting: false });
    const result = await Bun.build(config);
    expect(result.success).toBe(true);
    await import(`data:text/javascript;base64,${Buffer.from(await result.outputs[0]!.text()).toString("base64")}`);
    const inputs = Object.keys(result.metafile!.inputs).filter(path => path.endsWith("/control.ts"));
    expect(inputs).toHaveLength(1);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
