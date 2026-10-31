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

test("filesystem options module exports the helper factory expected by node:fs", () => {
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/fs_options.ts"));
  // oxlint-disable-next-line no-eval -- Initialize the emitted module as bootstrap's internal.require does.
  const createOptions = (0, eval)(generated)({ native: {} });
  expect(typeof createOptions).toBe("function");
  const { Stats, flagsNumber } = createOptions({}, (path: string) => path);
  expect(flagsNumber("wx")).toBe(705);
  expect(new Stats({ mode: 0o100640 }).isFile()).toBe(true);
});

test("erases types without printing constructors or moving source positions", () => {
  const text = '(function (value: string) { "use strict"; throw new TypeError(value); })\n';
  writeFileSync(join(source, "position.ts"), text);
  const generated = emit(join(source, "position.ts"));
  expect(generated)
    .toBe('(function (value        ) { "use strict"; throw new TypeError(value); })\n');
});

test("empties type-only lines and keeps template text and every other position", () => {
  const text = [
    "(function (value: string) {",
    "  type Local = { a: string };",
    "  interface Shape {",
    "    b: number;",
    "  }",
    "  ",
    "  const kept = `",
    "   ",
    "  ${value as string}`;",
    "  return kept as string;",
    "})",
    "",
  ].join("\n");
  writeFileSync(join(source, "blank.ts"), text);
  expect(emit(join(source, "blank.ts")).split("\n")).toEqual([
    "(function (value        ) {",
    "",
    "",
    "",
    "",
    "  ",
    "  const kept = `",
    "   ",
    "  ${value          }`;",
    "  return kept          ;",
    "})",
    "",
  ]);
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
  const cases: [() => unknown, new (message?: string) => Error, string][] = [
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

test("converted byte sink keeps its factory and copied-buffer behavior", async () => {
  const { runInNewContext } = await import("node:vm");
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/array_buffer_sink.ts"));
  const factory = runInNewContext(generated, { Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView });
  const { ArrayBufferSink } = factory({
    native: { utf8Encode: (value: string) => new TextEncoder().encode(value) },
    concatBytes(chunks: Uint8Array[]) {
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    },
  });
  const sink = new ArrayBufferSink();
  sink.start({ stream: true, asUint8Array: true });
  const input = Uint8Array.of(1, 2, 3);
  expect(sink.write(input)).toBe(3);
  input.fill(9);
  expect(Array.from(sink.flush())).toEqual([1, 2, 3]);
  expect(sink.write("ok")).toBe(2);
  expect(Array.from(sink.end())).toEqual([111, 107]);
  sink.close();
  expect(() => sink.write("no")).toThrow("already been closed");
});

test("converted Function adapter preserves construction and module origins", async () => {
  const { createContext, runInContext } = await import("node:vm");
  const context = createContext({ process: { pid: 1, env: {} }, performance });
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/function.ts"));
  const factory = runInContext(generated, context);
  const resolutions: unknown[][] = [];
  const internal = {
    native: {
      engine: "quickjs",
      prepareFunction: (strings: string[]) => JSON.stringify(strings.map(source => ({
        version: 6, alreadyPrepared: false, edits: source.includes("import") ? [source.indexOf("import"), 6, 16] : [],
        columns: [], fallback: null, spreadEval: 0, unhookedAwaitUsing: 0,
      }))),
      resolve(...args: unknown[]) { resolutions.push(args); return "/loaded.ts"; },
      importModule: async (path: string) => ({ path }),
    },
    mainPath: "/entry.ts",
    require: () => ({ "bun:jsc": () => ({ callerSourceOrigin: () => "/entry.ts" }) }),
    defineGlobal(name: string, value: unknown) { context[name] = value; },
  };
  runInContext(emit(join(root, "crates/bunwasm-runtime/src/js/source_prepare.ts")), context)(internal);
  factory(internal);
  expect(runInContext('new Function("return 7")()', context)).toBe(7);
  expect(() => runInContext('new Function("return @")', context)).toThrow();
  expect(await runInContext('new Function("return import(\\\"./leaf\\\")")()', context)).toEqual({ path: "/loaded.ts" });
  expect(resolutions).toEqual([["./leaf", "/entry.ts", false]]);
});

test("prepared spread eval preserves concurrent context and iterable semantics", async () => {
  const { createContext, runInContext } = await import("node:vm");
  let frame = "none";
  const context = createContext({ process: { pid: 1, env: {} }, performance });
  Object.assign(context, {
    __bunwasm_capture: () => frame,
    __bunwasm_resume(saved: string, value: unknown) { frame = saved; return value; },
    __bunwasmSpreadFrame: () => frame,
  });
  const evaluated = "(async () => { await 0; return globalThis.__bunwasmSpreadFrame(); })()";
  const native = {
    engine: "host", contextHooks: true, prepareVersion: 6,
    preparedColumns: new Map(),
    prepareSource(source: string) {
      const values = source.indexOf("values");
      const awaitAt = source.indexOf("await");
      const edits = source === "eval(...values)"
        ? [values, 0, 18, values + "values".length, 0, 1]
        : [awaitAt, 0, 0, source.indexOf("0", awaitAt) + 1, 0, 1];
      return JSON.stringify({ version: 6, alreadyPrepared: false, edits, columns: [], fallback: null,
        spreadEval: source === "eval(...values)" ? 1 : 0, unhookedAwaitUsing: 0 });
    },
  };
  const internal = {
    native,
    mainPath: "/spread.ts",
    require: () => ({ "bun:jsc": () => ({ callerSourceOrigin: () => "/spread.ts" }) }),
    defineGlobal(name: string, value: unknown) { context[name] = value; },
  };
  const install = runInContext(emit(join(root, "crates/bunwasm-runtime/src/js/source_prepare.ts")), context);
  const preparation = install(internal);
  const call = preparation.prepareText("eval(...values)", "eval", "spread-test");
  expect(call).toBe("eval(...__bunwasm_evalSpread(eval, values))");
  const callable = runInContext(`new Function("values", ${JSON.stringify(`return ${call}`)})`, context);
  const request = (name: string) => {
    frame = name;
    return callable([evaluated]);
  };
  expect(await Promise.all([request("A"), request("B")])).toEqual(["A", "B"]);
  const raw = runInContext(`new Function("values", "return eval(...values)")`, context);
  const rawRequest = (name: string) => {
    frame = name;
    return raw([evaluated]);
  };
  expect(await Promise.all([rawRequest("A"), rawRequest("B")])).not.toEqual(["A", "B"]);
  expect(callable([])).toBeUndefined();
  expect(callable([19, "ignored"])).toBe(19);
  const nativeEval = context.eval;
  const customCalls: unknown[][] = [];
  try {
    context.eval = (...values: unknown[]) => {
      customCalls.push(values);
      return "custom";
    };
    expect(callable(["await 0", 19])).toBe("custom");
    expect(customCalls).toEqual([["await 0", 19]]);
  } finally {
    context.eval = nativeEval;
  }
  const failure = { marker: "same error" };
  const bad = { [Symbol.iterator]() { return { next() { throw failure; } }; } };
  let caught: unknown;
  try {
    callable(bad);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
});
