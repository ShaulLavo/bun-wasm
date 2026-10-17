import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserBuildConfig, resolveRuntimePackage } from "./browser-build";

interface OwnedCommand {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

const commands = new Set<OwnedCommand>();
const scratches = new Set<string>();
const commandTimeoutSeconds = 120;
const commandTimeout = commandTimeoutSeconds * 1000;
const timeoutWrapper = join(import.meta.dir, "run-with-timeout.mts");
function track<T extends OwnedCommand>(child: T): T {
  commands.add(child);
  void child.exited.finally(() => commands.delete(child));
  return child;
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const child = track(Bun.spawn(["node", timeoutWrapper, String(commandTimeoutSeconds), command].concat(args), {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: commandTimeout + 10_000,
    killSignal: "SIGKILL",
  }));
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${command} exited with code ${code}:\n${stderr}`);
    return stdout;
  } finally {
    child.kill();
  }
}

let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleanupPromise ??= (async () => {
    for (const child of commands) child.kill("SIGTERM");
    await Promise.all(Array.from(commands, child => child.exited));
    for (const scratch of scratches) rmSync(scratch, { recursive: true, force: true });
  })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });

test("a clean consumer install prepares Waffle Node exports from the pinned Git commit", async () => {
  const root = resolve(import.meta.dir, "..");
  const source = join(root, "web");
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-waffle-install-"));
  scratches.add(scratch);
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
    await run("bun", ["install", "--frozen-lockfile"], consumer, {
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
    const browserOnlySpecifiers = Object.entries(metadata.exports)
      .filter(([, target]) => target.node === undefined)
      .map(([key]) => `${metadata.name}${key.slice(1)}`);
    expect(browserOnlySpecifiers.length).toBeGreaterThan(0);
    const script = `
      import assert from "node:assert/strict";
      for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier);
      for (const specifier of ${JSON.stringify(browserOnlySpecifiers)}) {
        await assert.rejects(import(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      }
    `;
    await expect(run("node", ["--input-type=module", "--eval", script], consumer)).resolves.toBeString();
    expect(existsSync(join(root, "runtime"))).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    scratches.delete(scratch);
  }
}, 270_000);

test("browser builds resolve Waffle through the installed consumer package", async () => {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-waffle-build-"));
  scratches.add(scratch);
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
    scratches.delete(scratch);
  }
});
