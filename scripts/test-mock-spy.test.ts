import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { types } from "node:util";
import { runInThisContext } from "node:vm";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const fixture = new URL("../tests/fixtures/test-mock-spy-contract/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function expression(source: string) {
  return runInThisContext(`(function () {${transpiler.transformSync(`return (\n${source}\n)`)}\n})()`);
}

function factory(name: string) {
  return expression(readFileSync(new URL(name, directory), "utf8").replace(/;\s*$/, ""));
}

test("mock and spy contracts through the runtime factory", async () => {
  const output = factory("pretty_output.ts")({ native: { isatty: () => false } });
  const modules = {
    inspect: { bunInspect: Bun.inspect },
    // Plain reports, whatever FORCE_COLOR the harness runs under.
    pretty_output: { prettyFmt: output.prettyFmt, markup: output.markup, stdout: false, stderr: false },
    util: factory("util.ts")({ isPromise: types.isPromise, promiseThen: (value: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (error: unknown) => unknown) => Promise.prototype.then.call(value, fulfilled, rejected) }),
    test_matchers: factory("test_matchers.ts")({
      realTimers: { setTimeout },
      isPromise: types.isPromise,
      promiseThen: (promise: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (value: unknown) => unknown) =>
        Promise.prototype.then.call(promise, fulfilled, rejected),
    }),
  };
  const available = {
    ...modules,
    test_extensions: factory("test_extensions.ts")({ isPromise: types.isPromise, promiseThen: (value: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (error: unknown) => unknown) => Promise.prototype.then.call(value, fulfilled, rejected), require: (name: keyof typeof modules) => modules[name] }),
  };
  const runtime = factory("bun_test.js")({
    native: {},
    fakeTimers: { api: {} },
    require: (name: keyof typeof available) => available[name],
  }).exports;
  const source = readFileSync(new URL("index.ts", fixture), "utf8").replace(/^import[^\n]+\n/gm, "");
  const run = expression(`async (assert, { expect, jest, mock, spyOn }, console) => {${source}\n}`);
  const lines: string[] = [];
  await run(assert, runtime, { log: (line: string) => lines.push(line) });
  expect(lines.join("\n") + "\n").toBe(readFileSync(new URL("expected.txt", fixture), "utf8"));
});
