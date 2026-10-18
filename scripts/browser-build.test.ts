import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { browserBuildConfig, resolveRuntimePackage } from "./browser-build";

test("browser build uses consumer exports through a dotted Git cache, not sibling source", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-package-resolver-"));
  try {
    const consumer = join(scratch, "consumer");
    const cached = join(scratch, "cache", "@bun-wasm.runtime.git.deadbeef");
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
    expect(installed.source("waffle/core")).toBe(join(cached, "browser.ts"));
    expect(() => installed.source("waffle/internal/private")).toThrow("not exported");
    expect(() => installed.source("waffle/blocked")).toThrow("not exported");
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
