import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-runtime-emission-"));
afterAll(() => rmSync(source, { recursive: true, force: true }));

function emit(path: string) {
  const output = join(source, "output.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), path, output], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

test("erases types without printing constructors or moving source positions", () => {
  const text = '(function (value: string) { "use strict"; throw new TypeError(value); })\n';
  writeFileSync(join(source, "position.ts"), text);
  const generated = emit(join(source, "position.ts"));
  expect(generated)
    .toBe('(function (value        ) { "use strict"; throw new TypeError(value); })\n');
});

test("converted Glob preserves replacement error classes and their stacks", async () => {
  const { runInNewContext } = await import("node:vm");
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/glob.ts"));
  class ReplacementError extends Error { name = "ReplacementError"; }
  class ReplacementTypeError extends Error { name = "ReplacementTypeError"; }
  const factory = runInNewContext(generated, {
    TypeError: ReplacementTypeError, Error: ReplacementError, process: { cwd: () => "/" },
  }, { filename: "bun-wasm:glob" });
  const { Glob } = factory({ native: {}, require: () => ({ resolve: (cwd: string) => cwd }) });
  const cases: [() => unknown, typeof Error, string][] = [
    [() => new Glob(), ReplacementTypeError, "Glob.constructor: expected 1 arguments, got 0"],
    [() => new Glob(7), ReplacementTypeError, "Glob.constructor: first argument is not a string"],
    [() => new Glob("*").match(), ReplacementTypeError, "Glob.matchString: expected 1 arguments, got 0"],
    [() => new Glob("*").match(7), ReplacementTypeError, "Glob.matchString: first argument is not a string"],
    [() => new Glob("*").scanSync(false), ReplacementTypeError, "Expected options to be an object"],
    [() => new Glob("*").scanSync({ cwd: false }), ReplacementTypeError, "Expected cwd to be a string"],
    [() => new Glob("*").scanSync({ cwd: "/".repeat(4097) }), ReplacementError, "ENAMETOOLONG: name too long, scandir"],
  ];
  for (const [trigger, Ctor, message] of cases) {
    let error: unknown;
    try { trigger(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Ctor);
    if (!(error instanceof Error)) throw new Error("Expected an Error instance");
    expect(Object.getPrototypeOf(error)).toBe(Ctor.prototype);
    expect(error.name).toBe(Ctor === ReplacementError ? "ReplacementError" : "ReplacementTypeError");
    expect(error.message).toBe(message);
    expect(error.stack).toContain("bun-wasm:glob");
  }
});

test("embedded source positions and fixture locations agree with TypeScript", () => {
  const path = join(root, "crates/bunwasm-runtime/src/js/glob.ts");
  const text = readFileSync(path, "utf8");
  const generated = emit(path);
  expect(generated.length).toBe(text.length);
  expect(generated.split("\n").length).toBe(text.split("\n").length);
  for (const token of ["new TypeError(", "new Error(", "class Glob", "#pattern", "scanSync("]) {
    let cursor = text.indexOf(token);
    while (cursor !== -1) {
      expect(generated.slice(cursor, cursor + token.length)).toBe(token);
      cursor = text.indexOf(token, cursor + token.length);
    }
  }
  const locations = JSON.parse(readFileSync(join(root, "tests/fixtures/runtime-typescript/locations.json"), "utf8"));
  const messages = {
    constructor: "Glob.constructor: expected 1 arguments, got 0",
    match: "Glob.matchString: expected 1 arguments, got 0",
    scan: "Expected options to be an object",
  };
  const lines = text.split("\n");
  for (const [key, message] of Object.entries(messages)) {
    const line = lines.findIndex(value => value.includes(message));
    const sourceLine = lines[line];
    if (sourceLine === undefined) throw new Error(`Missing source throw for ${key}`);
    const start = sourceLine.indexOf("new TypeError(");
    expect(locations[key]).toEqual({ line: line + 1, columns: [start + 1, start + 5, start + 14] });
  }
});

test("builtin helper prepares runnable globals from the TypeScript factory", async () => {
  const directory = join(source, "builtins");
  const result = Bun.spawnSync(["bash", join(root, "scripts/test-bun-builtins.sh"), "--prepare-only", directory], {
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const { runInNewContext } = await import("node:vm");
  const globals = runInNewContext(readFileSync(join(directory, "globals.js"), "utf8"), { Buffer })();
  expect(Object.isFrozen(globals)).toBe(true);
  expect(globals.Buffer).toBe(Buffer);
  expect(globals.Array.isArray([])).toBe(true);
  expect(JSON.parse(readFileSync(join(directory, "catalog.json"), "utf8"))).toBeDefined();
});
