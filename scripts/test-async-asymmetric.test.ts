import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { types } from "node:util";
import { runInThisContext } from "node:vm";

const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const fixture = new URL("../tests/fixtures/test-async-asymmetric/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function expression(source: string) {
  return runInThisContext(`(function () {${transpiler.transformSync(`return (\n${source}\n)`)}\n})()`);
}

function factory(name: string) {
  return expression(readFileSync(new URL(name, runtime), "utf8").replace(/;\s*$/, ""));
}

test("async asymmetric comparisons through the actual util and expect factories", async () => {
  const support = factory("test_matchers.ts")({
    realTimers: { setTimeout },
    isPromise: types.isPromise,
    promiseThen: (promise: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (value: unknown) => unknown) =>
      Promise.prototype.then.call(promise, fulfilled, rejected),
  });
  const intrinsic = { isPromise: types.isPromise, promiseThen: (value: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (error: unknown) => unknown) => Promise.prototype.then.call(value, fulfilled, rejected) };
  const modules = { inspect: { bunInspect: Bun.inspect, formatError: (error: unknown) => String(error) + "\n" }, test_matchers: support };
  const util = factory("util.ts")({ ...intrinsic, require: (name: keyof typeof modules) => modules[name] });
  const extensions = factory("test_extensions.ts")({ ...intrinsic, require: (name: keyof typeof modules) => modules[name] });
  const available = { ...modules, util, test_extensions: extensions };
  const diagnostics: string[] = [];
  const { exports } = factory("bun_test.js")({
    native: {
      writeStderr: (text: string) => diagnostics.push(text),
      promiseState: (promise: Promise<unknown>) => Bun.peek.status(promise),
      promiseResult: (promise: Promise<unknown>) => Bun.peek(promise),
      promiseThen: (promise: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (value: unknown) => unknown) =>
        Promise.prototype.then.call(promise, fulfilled, rejected),
    }, fakeTimers: { api: {} }, require: (name: keyof typeof available) => available[name],
  });
  const source = readFileSync(new URL("index.ts", fixture), "utf8").replace(/^import[^\n]+\n/, "");
  const run = expression(`(async (expect, mock, Bun, console) => {${source}\n})`);
  const lines: string[] = [];
  try {
    await run(exports.expect, exports.mock, { deepEquals: util.bunDeepEquals }, { log: (line: string) => lines.push(line) });
  } catch (cause) {
    throw new Error(lines.join("\n"), { cause });
  }
  expect(lines.join("\n") + "\n").toBe(readFileSync(new URL("expected.txt", fixture), "utf8"));
  expect(diagnostics).toEqual(["asymmetric rejection\n"]);
});
