import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface CallSite {
  getScriptNameOrSourceURL(): string | null;
  getFileName(): string | null;
  getEvalOrigin(): string | null;
  getFunctionName(): string | null;
  getFunction(): Function | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  isEval(): boolean | null;
  isNative(): boolean;
  isConstructor(): boolean;
  getEnclosingLineNumber(): number | null;
  getEnclosingColumnNumber(): number | null;
}

interface BootstrapRuntime {
  formatCallSite(site: CallSite): string;
  defaultPrepareStackTrace(error: unknown, callsites: readonly CallSite[]): string;
}

interface Position {
  file: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
  eval: boolean | null;
  native: boolean;
  enclosingLine: number | null;
  enclosingColumn: number | null;
  functionValue: Function | undefined;
}

const bootstrapSource = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");

function bootstrap(engine: string, mapPosition: (...args: unknown[]) => unknown, displayName?: (file: string | null, isEval: boolean | null) => string | null): BootstrapRuntime {
  const factory: (native: object) => BootstrapRuntime = runInNewContext(bootstrapSource, { process: { env: {} } }, { filename: "bun-wasm:bootstrap" });
  return factory({
    engine,
    mapPosition,
    preparedSourceName: () => undefined,
    displayName,
    sharedObjects: undefined,
    loadPolyfill: (name: string) => name === "process" ? () => ({ env: {} }) : name === "web" || name === "crypto" ? () => () => {} : () => ({}),
    mainPath: () => "/main.ts",
  });
}

function callSite(position: Partial<Position>): CallSite {
  const value: Position = {
    file: "/source.ts",
    line: 12,
    column: 7,
    name: "run",
    eval: false,
    native: false,
    enclosingLine: 2,
    enclosingColumn: 3,
    functionValue: function run() {},
    ...position,
  };
  return {
    getScriptNameOrSourceURL: () => value.file,
    getFileName: () => value.file,
    getEvalOrigin: () => null,
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

test("maps complete CallSite positions through the strict native boundary", () => {
  const calls: unknown[][] = [];
  const runtime = bootstrap("jsc", (...args: unknown[]) => {
    if (typeof args[1] !== "number" || typeof args[2] !== "number") throw new Error("non-numeric mapPosition argument");
    calls.push(args);
    return [30, 40];
  });
  const site = callSite({ file: "/generated.js", line: 12, column: 7 });

  expect(runtime.formatCallSite(site)).toBe("run (/generated.js:30:40)");
  expect(calls).toEqual([["/generated.js", 12, 7]]);
});

test("formats a known line without calling native mapping when the column is absent", () => {
  const calls: unknown[][] = [];
  const runtime = bootstrap("jsc", (...args: unknown[]) => {
    calls.push(args);
    if (typeof args[1] !== "number" || typeof args[2] !== "number") throw new Error("non-numeric mapPosition argument");
    return [30, 40];
  });
  const site = callSite({ line: 12, column: null });

  expect(runtime.formatCallSite(site)).toBe("run (/source.ts:12)");
  expect(calls).toEqual([]);
});

test("formats a file without a line and preserves eval and native origins", () => {
  const calls: unknown[][] = [];
  const runtime = bootstrap("jsc", (...args: unknown[]) => {
    calls.push(args);
    return [30, 40];
  });

  expect(runtime.formatCallSite(callSite({ line: null, column: null }))).toBe("run (/source.ts)");
  expect(runtime.formatCallSite(callSite({ file: null, line: null, column: null, eval: true }))).toBe("run (unknown)");
  expect(runtime.formatCallSite(callSite({ file: null, line: null, column: null, name: "nativeFn", native: true }))).toBe("nativeFn (native)");
  expect(calls).toEqual([]);
});

test("formats a host top-level frame with a known line and absent column", () => {
  const calls: unknown[][] = [];
  const runtime = bootstrap("host", (...args: unknown[]) => {
    calls.push(args);
    if (typeof args[1] !== "number" || typeof args[2] !== "number") throw new Error("non-numeric mapPosition argument");
    return [30, 40];
  });

  expect(runtime.formatCallSite(callSite({ name: "", line: 12, column: null, functionValue: undefined, enclosingLine: 1, enclosingColumn: 1 }))).toBe("/source.ts:12");
  expect(calls).toEqual([]);
});

test("the default stack formatter keeps complete and incomplete positions distinct", () => {
  const runtime = bootstrap("jsc", (...args: unknown[]) => {
    if (typeof args[1] !== "number" || typeof args[2] !== "number") throw new Error("non-numeric mapPosition argument");
    return [30, 40];
  });
  const error = new Error("original");

  expect(runtime.defaultPrepareStackTrace(error, [
    callSite({ line: 12, column: 7 }),
    callSite({ line: 12, column: null }),
    callSite({ line: null, column: null }),
  ])).toBe("    at run (/source.ts:30:40)\n    at run (/source.ts:12)\n    at run (/source.ts)\n");
});
