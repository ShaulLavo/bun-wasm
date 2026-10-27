import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");

test("Bun WASI runs actual WASM imports through native host filesystem calls", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-wasi-control-"));
  try {
    const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/runtime-wasi-host.ts", import.meta.url))], {
      cwd: root, env: { ...process.env, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("PASS Bun WASI through real host WebAssembly");
    expect(result.stdout.toString()).toContain("generated modules=[188]");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

function createSelection(scratch: string, modules: string[]) {
  const names = ["node:entry", "node:fs", "internal:private", "node:explicit", "bun", "bun:ffi", "node:architecture", "native:only"];
  for (const name of names.slice(0, 7)) {
    const file = name.replace(":", "/") + ".ts";
    mkdirSync(join(scratch, "src/js", file, ".."), { recursive: true });
    writeFileSync(join(scratch, "src/js", file), name === "node:architecture" ? "process.arch;" : "export default {};\n");
  }
  const dependencies = [[1, 3, 4, 5], [2], [], [], [2], [2], [], []];
  const source = readFileSync(process.env.WASI_GENERATOR_SOURCE ?? join(root, "scripts/generate-bun-builtins.mjs"), "utf8");
  const start = source.indexOf("const selected = new Set();");
  const end = source.indexOf("for (const name of selection.modules) include(name);", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  const context = {
    selection: { modules }, names, count: 7, bun: scratch, join, readFileSync,
    catalog: names.map((_name, id) => ({ dependencies: dependencies[id] })),
    upstream: (id: number) => names[id]!.replace(":", "/") + ".ts",
  };
  const run = runInNewContext(`(function(name) { ${body}; include(name); return Array.from(selected); })`, context);
  if (typeof run !== "function") throw new Error("Missing generator selection function");
  return (name: string): number[] => run(name);
}

function selection(modules: string[]) {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-wasi-selection-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  try { return { run: createSelection(scratch, modules), cleanup }; }
  catch (error) { cleanup(); throw error; }
}

test("unselected public dependencies stop before their private closure", () => {
  const control = selection(["node:entry"]);
  try { expect(control.run("node:entry")).toEqual([0]); }
  finally { control.cleanup(); }
});

test("explicit public selections and their internal dependencies remain eligible", () => {
  const control = selection(["node:fs", "node:explicit", "bun", "bun:ffi"]);
  try {
    expect(control.run("node:fs")).toEqual([1, 2]);
    expect(control.run("node:explicit")).toEqual([3]);
    expect(control.run("bun")).toEqual([4, 2]);
    expect(control.run("bun:ffi")).toEqual([5, 2]);
  } finally { control.cleanup(); }
});

test("generator keeps unknown, native, and architecture guards", () => {
  const control = selection(["node:architecture"]);
  try {
    expect(() => control.run("missing")).toThrow("Unknown builtin missing");
    expect(control.run("native:only")).toEqual([]);
    expect(() => control.run("node:architecture")).toThrow("Architecture-specialized builtin");
  } finally { control.cleanup(); }
});
