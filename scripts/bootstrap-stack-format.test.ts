import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

type Position = {
  file: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
  eval: boolean;
  native: boolean;
  enclosingLine: number | null;
  enclosingColumn: number | null;
  functionValue: Function | undefined;
  evalOrigin: string | null;
};

type CallSite = ReturnType<typeof callSite>;
type Mapping = [string, number, number];
type BootstrapRuntime = {
  formatCallSite(site: CallSite): string;
  defaultPrepareStackTrace(error: unknown, callsites: readonly CallSite[]): string;
  mappedCallSites: WeakSet<object>;
  displayName?: (file: string | null, isEval: boolean) => string | null;
  prepareFunctionArgs?: (strings: string[], kind: string, path: string | undefined) => string[];
};

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const source = (name: string) => readFileSync(new URL(name, directory), "utf8");
const bootstrapSource = source("bootstrap.js");

function callSite(position: Partial<Position> = {}) {
  const value: Position = {
    file: "/source.ts", line: 12, column: 7, name: "run", eval: false, native: false,
    enclosingLine: 2, enclosingColumn: 3, functionValue: function run() {}, evalOrigin: null,
    ...position,
  };
  return {
    getScriptNameOrSourceURL: () => value.file,
    getFileName: () => value.file,
    getEvalOrigin: () => value.evalOrigin,
    getFunctionName: () => value.name,
    getFunction: () => value.functionValue,
    getLineNumber: () => value.line,
    getColumnNumber: () => value.column,
    isEval: () => value.eval,
    isNative: () => value.native,
    isConstructor: () => false,
    getEnclosingLineNumber: () => value.enclosingLine,
    getEnclosingColumnNumber: () => value.enclosingColumn,
  };
}

function bootstrap(engine = "hermes", generated = false, mapped: [number, number] | null = [30, 7]) {
  const context = createContext({});
  const mappings: Mapping[] = [];
  const lookups: [string, number][] = [];
  const factory: (native: object) => BootstrapRuntime = runInContext(bootstrapSource, context, { filename: "bun-wasm:bootstrap" });
  const runtime = factory({
    engine,
    // Match natives.rs: filename is a string; numeric arguments 1 and 2 never coerce null.
    mapPosition(file: unknown, line: unknown, column: unknown) {
      if (typeof file !== "string") throw new TypeError("expected a string argument");
      if (typeof line !== "number" || typeof column !== "number") throw new TypeError("expected a number argument, got null");
      mappings.push([file, line, column]);
      return mapped ?? undefined;
    },
    getSourceLine(file: string, line: number) { lookups.push([file, line]); return "      new Error()"; },
    preparedSourceName: () => generated ? "/source.ts" : undefined,
    mainPath: () => "/main.ts",
    // Only builtins and inspect participate in these tests; unrelated bootstrap factories stay inert.
    loadPolyfill(name: string) {
      if (name === "builtins" || name === "inspect") return runInContext(source(`${name}.js`), context, { filename: `bun-wasm:${name}` });
      if (name === "node_url") return () => ({ fileURLToPath });
      if (name === "process") return () => ({ env: {} });
      if (name === "web" || name === "crypto") return () => () => {};
      return () => ({});
    },
  });
  context.runtime = runtime;
  return { runtime, context, mappings, lookups };
}

test("complete positions retain mapping offsets and function names", () => {
  const state = bootstrap();
  expect(state.runtime.formatCallSite(callSite())).toBe("run (/source.ts:30:7)");
  expect(state.mappings).toEqual([["/source.ts", 12, 7]]);
});

for (const engine of ["hermes", "quickjs", "jsc", "host"]) {
  test(`${engine} formatter retains a known line without mapping a missing column`, () => {
    const state = bootstrap(engine);
    expect(state.runtime.formatCallSite(callSite({ column: null }))).toBe("run (/source.ts:12)");
    expect(state.mappings).toEqual([]);
    expect(state.lookups).toEqual([]);
  });
}

for (const column of [null, 7]) {
  test(`missing line keeps the filename and does not map column ${column}`, () => {
    const state = bootstrap();
    expect(state.runtime.formatCallSite(callSite({ line: null, column }))).toBe("run (/source.ts)");
    expect(state.mappings).toEqual([]);
  });
}

for (const generated of [false, true]) {
  test(`complete host ${generated ? "prepared" : "ordinary"} positions retain filename and constructor mapping`, () => {
    const state = bootstrap("host", generated);
    state.runtime.displayName = () => "/source.ts";
    expect(state.runtime.formatCallSite(callSite({ file: "/prepared/module.js" }))).toBe(`run (/source.ts:30:${generated ? 7 : 11})`);
    expect(state.mappings).toEqual([[generated ? "/prepared/module.js" : "/source.ts", 12, 7]]);
    expect(state.lookups).toEqual(generated ? [] : [["/source.ts", 30]]);
  });
}

test("already-mapped frames do not apply source offsets twice", () => {
  const state = bootstrap("host");
  const site = callSite();
  state.runtime.mappedCallSites.add(site);
  expect(state.runtime.formatCallSite(site)).toBe("run (/source.ts:12:7)");
  expect(state.mappings).toEqual([]);
  expect(state.lookups).toEqual([]);
});

test("a missing source map keeps complete positions unchanged", () => {
  const state = bootstrap("hermes", false, null);
  expect(state.runtime.formatCallSite(callSite())).toBe("run (/source.ts:12:7)");
  expect(state.mappings).toEqual([["/source.ts", 12, 7]]);
});

test("native and eval frames retain their labels and eval creation filename", () => {
  const state = bootstrap();
  expect(state.runtime.formatCallSite(callSite({ file: null, line: null, column: null, native: true }))).toBe("run (native)");
  expect(state.runtime.formatCallSite(callSite({ file: null, line: null, column: null, eval: true }))).toBe("run (unknown)");
  expect(state.runtime.formatCallSite(callSite({ file: null, column: null, eval: true, evalOrigin: "eval at create (/origin.ts:4:5)" }))).toBe("run (/origin.ts:12)");
  expect(state.mappings).toEqual([]);
});

for (const engine of ["hermes", "host"]) {
  test(`${engine} top-level locations omit unknown coordinates`, () => {
    const state = bootstrap(engine);
    const top = { name: null, functionValue: undefined, enclosingLine: 1, enclosingColumn: 1 };
    expect(state.runtime.formatCallSite(callSite({ ...top, column: null }))).toBe("/source.ts:12");
    expect(state.runtime.formatCallSite(callSite({ ...top, line: null, column: null }))).toBe(engine === "host" ? "<anonymous> (/source.ts)" : "/source.ts");
    expect(state.mappings).toEqual([]);
  });
}

test("the default formatter preserves the original exception and mixed frame positions", () => {
  const state = bootstrap();
  const error = new TypeError("original application failure");
  const stack = error.stack;
  expect(state.runtime.defaultPrepareStackTrace(error, [callSite(), callSite({ column: null }), callSite({ line: null, column: null })]))
    .toBe("    at run (/source.ts:30:7)\n    at run (/source.ts:12)\n    at run (/source.ts)\n");
  expect(error.message).toBe("original application failure");
  expect(error.stack).toBe(stack);
});

function installFunctionCaller(state: ReturnType<typeof bootstrap>, sites: readonly CallSite[]) {
  const prepared: unknown[][] = [];
  state.context.sites = sites;
  state.runtime.prepareFunctionArgs = (strings, kind, path) => { prepared.push([strings, kind, path]); return strings; };
  // Supply incomplete engine CallSites without altering the production formatter or origin parser.
  runInContext(`globalThis.Error = class extends Error {
    constructor() {
      super();
      Object.defineProperty(this, "stack", { get: () => Error.prepareStackTrace(this, sites) });
    }
  }; Error.prepareStackTrace = () => "custom formatter";`, state.context);
  const erased = Bun.spawnSync(["node", "--input-type=module", "-e",
    'import { stripTypeScriptTypes } from "node:module"; let text = ""; for await (const chunk of process.stdin) text += chunk; process.stdout.write(stripTypeScriptTypes(text));'],
  { stdin: Buffer.from(source("function.ts")), stdout: "pipe", stderr: "pipe" });
  expect(erased.exitCode, erased.stderr.toString()).toBe(0);
  const factory: (runtime: BootstrapRuntime) => unknown = runInContext(erased.stdout.toString(), state.context, { filename: "bun-wasm:function" });
  factory(state.runtime);
  return prepared;
}

test("Function construction reaches caller-origin preparation past incomplete runtime frames", () => {
  const state = bootstrap();
  const prepared = installFunctionCaller(state, [
    callSite({ file: "bun-wasm:builtins", column: null, name: "callerSourceOrigin" }),
    callSite({ file: "/project/schema-utils3.js", name: "localCompile" }),
  ]);
  expect(runInContext('new Function("value", "return value + 1")(41)', state.context)).toBe(42);
  expect(prepared).toEqual([[["value", "return value + 1"], "normal", "/project/schema-utils3.js"]]);
  expect(state.mappings.filter(([file]) => file === "/project/schema-utils3.js")).toEqual([["/project/schema-utils3.js", 12, 7]]);
  expect(runInContext('Error.prepareStackTrace()', state.context)).toBe("custom formatter");
});

test("an incomplete user frame stays opaque instead of borrowing a later caller origin", () => {
  const state = bootstrap();
  const prepared = installFunctionCaller(state, [
    callSite({ file: "bun-wasm:builtins", column: null, name: "callerSourceOrigin" }),
    callSite({ file: "/project/schema-utils3.js", column: null, name: "localCompile" }),
    callSite({ file: "/unrelated.ts" }),
  ]);
  expect(runInContext('Function("return 42")()', state.context)).toBe(42);
  expect(prepared).toEqual([[["return 42"], "normal", undefined]]);
  expect(runInContext('Error.prepareStackTrace()', state.context)).toBe("custom formatter");
});
