import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { browserBuildConfig, resolveRuntimePackage } from "./browser-build";

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe" });
}

test("a clean consumer install prepares Waffle Node exports from the pinned Git commit", () => {
  const root = resolve(import.meta.dir, "..");
  const source = join(root, "web");
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-waffle-install-"));
  const cache = join(scratch, "empty-cache");
  const global = join(scratch, "global");
  const config = join(scratch, "config");
  const consumer = join(scratch, "consumer");
  try {
    mkdirSync(cache, { recursive: true });
    mkdirSync(global, { recursive: true });
    mkdirSync(config, { recursive: true });
    mkdirSync(consumer, { recursive: true });
    for (const file of ["package.json", "bun.lock"]) writeFileSync(join(consumer, file), readFileSync(join(source, file)));
    expect(existsSync(join(consumer, "node_modules"))).toBe(false);
    run("bun", ["install", "--frozen-lockfile"], consumer, {
      BUN_INSTALL_CACHE_DIR: cache,
      BUN_INSTALL_GLOBAL_DIR: global,
      BUN_CONFIG_DIR: config,
    });
    const metadata = JSON.parse(readFileSync(join(consumer, "node_modules/waffle/package.json"), "utf8")) as {
      name: string;
      exports: Record<string, { node?: string }>;
    };
    const nodeEntries = Object.entries(metadata.exports).filter(([, target]) => target.node !== undefined);
    for (const [, target] of nodeEntries) expect(existsSync(join(consumer, "node_modules/waffle", target.node!))).toBe(true);
    const specifiers = nodeEntries.map(([key]) => key === "." ? metadata.name : `${metadata.name}${key.slice(1)}`);
    const script = `for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier);`;
    expect(() => run("node", ["--input-type=module", "--eval", script], consumer)).not.toThrow();
    expect(existsSync(join(root, "runtime"))).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("browser builds resolve Waffle through the installed consumer package", async () => {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-waffle-build-"));
  try {
    const entry = join(root, "web/src/main.ts");
    const installed = resolveRuntimePackage(entry);
    expect(installed.metadata.name).toBe("waffle");
    expect(installed.relativeInput(installed.source("waffle/core"))).toBe("core/index.ts");
    const { outdir, ...config } = browserBuildConfig([entry], join(scratch, "dist"), { runtimeWorker: true });
    const result = await Bun.build(config);
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some(input => installed.relativeInput(input)?.startsWith("core/"))).toBe(true);
    expect(inputs.some(input => input.includes("/runtime/"))).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
