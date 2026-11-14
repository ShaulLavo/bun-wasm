import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { EngineHostEvaluatedSource } from "../web/src/engine-host.js";

const source = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
const start = source.indexOf("class EngineHost {");
if (start < 0) throw Error("Missing production EngineHost");
const factory: unknown = runInNewContext(`const nativeEval = eval; ${source.slice(start)}
  (options, done) => new EngineHost(options, done)`, {
  wasmCaller: () => ({}), NativeMessageChannel: undefined,
  ExitSignal: class ExitSignal {}, nativeClearTimeout() {},
});

type Observer = (error: unknown, sources: readonly EngineHostEvaluatedSource[]) => void;
type Host = {
  internal: { handleUncaught(error: unknown): boolean };
  native: { tlsDispose(): void; closeAllDirs(): void; flushOutput(): void };
  guard(callback: () => unknown, fallback: unknown): unknown;
  uncaught(error: unknown): void;
  evalAt(code: string, filename: string): unknown;
  exited: boolean;
};
function fixture(observer: Observer | undefined, handled = false) {
  if (typeof factory !== "function") throw Error("Missing host factory");
  const handlers: unknown[] = [], exits: number[] = [], completed: number[] = [];
  const value: unknown = factory({ instance: { exports: {} }, onUncaughtDiagnostic: observer,
    onExit(code: number) { exits.push(code); } }, (code: number) => completed.push(code));
  if (!value || typeof value !== "object" || !("guard" in value) || typeof value.guard !== "function"
    || !("uncaught" in value) || typeof value.uncaught !== "function"
    || !("evalAt" in value) || typeof value.evalAt !== "function"
    || !("exited" in value) || typeof value.exited !== "boolean") throw Error("Missing production host methods");
  const host = value as Host;
  host.native = { tlsDispose() {}, closeAllDirs() {}, flushOutput() {} };
  host.internal = { handleUncaught(error) { handlers.push(error); return handled; } };
  return { host, handlers, exits, completed };
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
  expect(sources).toEqual([]);
  expect(f.exits).toEqual(handled ? [] : [1]);
  expect(f.completed).toEqual(f.exits);
  expect(f.host.exited).toBe(!handled);
});

test("observer failure preserves the original error and unhandled exit", () => {
  let original: unknown;
  const f = fixture(error => { original = error; throw Error("observer failed"); });
  f.host.guard(() => f.host.evalAt(code, filename), undefined);
  expect(f.handlers).toEqual([original]);
  expect(original).toBeDefined();
  expect(f.exits).toEqual([1]);
  expect(f.completed).toEqual([1]);
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
