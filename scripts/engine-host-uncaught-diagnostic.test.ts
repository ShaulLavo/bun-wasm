import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { EngineHostEvaluatedSource } from "../web/src/engine-host.js";

const source = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
const start = source.indexOf("class EngineHost {");
const signalStart = source.indexOf("class ExitSignal {");
const signalEnd = source.indexOf("/**", signalStart);
if (start < 0 || signalStart < 0 || signalEnd < signalStart) throw Error("Missing production EngineHost");
const factory: unknown = runInNewContext(`const nativeEval = eval; ${source.slice(signalStart, signalEnd)} ${source.slice(start)}
  (options, done) => new EngineHost(options, done)`, {
  wasmCaller: () => ({}), NativeMessageChannel: undefined,
  nativeClearTimeout() {},
  nativeEncodeURIComponent: encodeURIComponent,
  nativeMapSet: Function.prototype.call.bind(Map.prototype.set),
  escapeParentheses: encodeURIComponent,
});

type Observer = (error: unknown, sources: readonly EngineHostEvaluatedSource[]) => void;
type Host = {
  internal: { handleUncaught(error: unknown): boolean; pumpSignals(): boolean; runTimers(): number; ioPending(): number; pumpIo(): boolean };
  native: { tlsDispose(): void; closeAllDirs(): void; flushOutput(): void; writeStderr(message: string): void };
  guard(callback: () => unknown, fallback: unknown): unknown;
  uncaught(error: unknown): void;
  evalAt(code: string, filename: string): unknown;
  url(source: string, key: string): string;
  pump(): void;
  schedule(delay: number): void;
  exit(code: number): void;
  exited: boolean;
};
function fixture(observer: Observer | undefined, handled = false) {
  if (typeof factory !== "function") throw Error("Missing host factory");
  const handlers: unknown[] = [], exits: number[] = [], completed: number[] = [], stderr: string[] = [];
  const value: unknown = factory({ instance: { exports: {} }, onUncaughtDiagnostic: observer,
    onExit(code: number) { exits.push(code); } }, (code: number) => completed.push(code));
  if (!value || typeof value !== "object" || !("guard" in value) || typeof value.guard !== "function"
    || !("uncaught" in value) || typeof value.uncaught !== "function"
    || !("evalAt" in value) || typeof value.evalAt !== "function"
    || !("url" in value) || typeof value.url !== "function"
    || !("pump" in value) || typeof value.pump !== "function"
    || !("schedule" in value) || typeof value.schedule !== "function"
    || !("exit" in value) || typeof value.exit !== "function"
    || !("exited" in value) || typeof value.exited !== "boolean") throw Error("Missing production host methods");
  const host = value as Host;
  host.native = { tlsDispose() {}, closeAllDirs() {}, flushOutput() {}, writeStderr(message) { stderr.push(message); } };
  host.internal = { handleUncaught(error) { handlers.push(error); return handled; },
    pumpSignals: () => false, runTimers: () => -1, ioPending: () => 0, pumpIo: () => false };
  return { host, handlers, exits, completed, stderr };
}

const filename = "blob:exact-diagnostic-positive-control";
const code = "new Uint8Array(1).set(new Uint8Array(2));";
for (const handled of [false, true]) test(`real evaluated bounds error is observed before one handler, handled=${handled}`, () => {
  let original: unknown, rawStack: unknown, sources: readonly EngineHostEvaluatedSource[] = [];
  let previousHandlerCalls = -1;
  const f = fixture((error, evaluated) => {
    original = error;
    if (error && typeof error === "object" && "stack" in error) rawStack = error.stack;
    sources = evaluated;
    previousHandlerCalls = f.handlers.length;
  }, handled);
  expect(f.host.guard(() => f.host.evalAt(code, filename), 17)).toBe(17);
  expect(original).toBeDefined();
  expect(previousHandlerCalls).toBe(0);
  expect(f.handlers).toEqual([original]);
  expect(String(rawStack)).toContain(filename);
  expect(sources).toContainEqual({ kind: "eval", filename, source: code });
  expect(f.exits).toEqual(handled ? [] : [1]);
  expect(f.completed).toEqual(f.exits);
  expect(f.host.exited).toBe(!handled);
});

for (const handled of [false, true]) test(`observer failure preserves the original error, handled=${handled}`, () => {
  let original: unknown;
  const f = fixture(error => { original = error; throw Error("observer failed"); }, handled);
  f.host.guard(() => f.host.evalAt(code, filename), undefined);
  expect(f.handlers).toEqual([original]);
  expect(original).toBeDefined();
  expect(f.exits).toEqual(handled ? [] : [1]);
  expect(f.completed).toEqual(f.exits);
});

test("disabled observation never reads the original stack", () => {
  const f = fixture(undefined);
  const original = Object.defineProperty({}, "stack", { get() { throw Error("stack must stay unread"); } });
  expect(f.host.guard(() => { throw original; }, "fallback")).toBe("fallback");
  expect(f.handlers).toEqual([original]);
  expect(f.exits).toEqual([1]);
});

test("an exited host skips observation and the handler", () => {
  let observations = 0;
  const f = fixture(() => { observations++; });
  f.host.exited = true;
  f.host.uncaught(Error("late"));
  expect(observations).toBe(0);
  expect(f.handlers).toHaveLength(0);
  expect(f.exits).toHaveLength(0);
});

test("handler failure keeps the original reporting and exit behavior", () => {
  const original = Error("original");
  let observed: unknown, calls = 0;
  const f = fixture(error => { observed = error; throw Error("observer failed"); });
  f.host.internal.handleUncaught = error => { calls++; expect(error).toBe(original); throw Error("handler failed"); };
  f.host.uncaught(original);
  expect(observed).toBe(original);
  expect(calls).toBe(1);
  expect(f.stderr).toEqual(["error: Error: handler failed\n"]);
  expect(f.exits).toEqual([1]);
});

for (const handled of [false, true]) test(`pump keeps scheduling and exit semantics, handled=${handled}`, () => {
  let observed: unknown;
  const f = fixture(error => { observed = error; throw Error("observer failed"); }, handled);
  const scheduled: number[] = [];
  f.host.schedule = delay => { scheduled.push(delay); };
  f.host.internal.runTimers = () => { f.host.evalAt(code, filename); return -1; };
  f.host.pump();
  expect(observed).toBeDefined();
  expect(f.handlers).toEqual([observed]);
  expect(scheduled).toEqual(handled ? [0] : []);
  expect(f.exits).toEqual(handled ? [] : [1]);
});

test("the host's actual exit signal bypasses observation", () => {
  let observations = 0;
  const f = fixture(() => { observations++; });
  const signal: unknown = f.host.evalAt("new ExitSignal(7)", filename);
  f.host.guard(() => { throw signal; }, undefined);
  expect(observations).toBe(0);
  expect(f.handlers).toHaveLength(0);
  expect(f.exits).toHaveLength(0);
});

test("a handler's explicit exit keeps its code without another exit", () => {
  const original = Error("original");
  let observed: unknown, calls = 0;
  const f = fixture(error => { observed = error; });
  const signal: unknown = f.host.evalAt("new ExitSignal(7)", filename);
  f.host.internal.handleUncaught = error => {
    calls++;
    expect(error).toBe(original);
    f.host.exit(7);
    throw signal;
  };
  f.host.uncaught(original);
  expect(observed).toBe(original);
  expect(calls).toBe(1);
  expect(f.exits).toEqual([7]);
  expect(f.completed).toEqual([7]);
  expect(f.stderr).toHaveLength(0);
});

test("source retention preserves repeated evaluations and module URL bytes", () => {
  let sources: readonly EngineHostEvaluatedSource[] = [];
  const f = fixture((_error, evaluated) => { sources = evaluated; }, true);
  expect(f.host.evalAt("1 + 2", filename)).toBe(3);
  expect(f.host.evalAt("3 + 4", filename)).toBe(7);
  const moduleSource = "export default 9;";
  const url = f.host.url(moduleSource, "/module.mjs");
  f.host.uncaught(Error("control"));
  expect(sources).toEqual([
    { kind: "eval", filename, source: "1 + 2" },
    { kind: "eval", filename, source: "3 + 4" },
    { kind: "module", filename: "/module.mjs", url: url.slice(0, url.indexOf("#")), source: moduleSource },
  ]);
  expect(sources.every(Object.isFrozen)).toBe(true);
  expect(url).toBe("data:text/javascript;charset=utf-8,export%20default%209%3B#%2Fmodule.mjs");
});

test("disabled source retention keeps no ledger", () => {
  const f = fixture(undefined);
  expect(f.host.evalAt("1 + 2", filename)).toBe(3);
  f.host.url("export default 9;", "/module.mjs");
  expect(Reflect.has(f.host, "diagnosticSources")).toBe(false);
});

test("a failed ledger does not replace evaluation or the original error", () => {
  let observed: unknown;
  const f = fixture(error => { observed = error; });
  const ledger = Reflect.get(f.host, "diagnosticSources");
  expect(Array.isArray(ledger)).toBe(true);
  Object.freeze(ledger);
  expect(f.host.evalAt("1 + 2", filename)).toBe(3);
  expect(f.host.url("export default 9;", "/module.mjs")).toContain("#%2Fmodule.mjs");
  f.host.guard(() => f.host.evalAt(code, filename), undefined);
  expect(observed).toBeDefined();
  expect(f.handlers).toEqual([observed]);
  expect(f.exits).toEqual([1]);
});
