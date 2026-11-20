import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { createContext, runInContext } from "node:vm";

const runtimeRoot = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const fixtures = new URL("../tests/fixtures/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function runtime(isProxy = types.isProxy) {
  const lines: string[] = [];
  const process = Object.assign(new EventEmitter(), { env: { CI: "1", AGENT: "0" }, exitCode: 0 });
  const context = createContext({ process, setTimeout, clearTimeout, URL, URLSearchParams, Headers, FormData, Blob,
    console: { log: (line: string) => lines.push(line) }, Bun: { version: "test", revision: "test" } });
  const evaluate = (source: string) => runInContext(transpiler.transformSync(source), context);
  const factory = (name: string) => evaluate(`(function(){return (${readFileSync(new URL(name, runtimeRoot), "utf8").replace(/;\s*$/, "")});})()`);
  const modules: Record<string, unknown> = { path, inspect: { bunInspect: Bun.inspect, formatError: (error: unknown) => String(error) + "\n" } };
  let stderr = "";
  let load = (_file: string) => {};
  const internal = {
    isPromise: types.isPromise, isProxy,
    promiseState: (value: Promise<unknown>) => Bun.peek.status(value),
    promiseThen: (value: Promise<unknown>, pass: (value: unknown) => unknown, fail?: (error: unknown) => unknown) => Promise.prototype.then.call(value, pass, fail),
    realTimers: { setTimeout, clearTimeout }, fakeTimers: { api: {} },
    // No async context in this harness: every frame is empty and runs its callback directly.
    runInContext: (_context: unknown, fn: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]) => Reflect.apply(fn, receiver, args),
    native: { now: () => performance.now(), cwd: () => "/", stat: () => ({ mode: 0o100644 }),
      getAsyncContext: () => undefined,
      writeStdout() {}, writeStderr: (value: string) => { stderr += value; } },
    require: (name: string) => modules[name], importModule: async (file: string) => load(file),
  };
  const util = factory("util.ts")(internal);
  modules.util = util;
  modules.test_matchers = factory("test_matchers.ts")(internal);
  modules.test_extensions = factory("test_extensions.ts")(internal);
  modules.test_lifecycle = factory("test_lifecycle.ts")();
  modules.fs = {
    existsSync(name: string) {
      if (path.basename(name) === "same-file.test.ts.snap") return true;
      throw new Error("Snapshot storage reached before origin validation");
    },
    readFileSync(name: string) {
      return readFileSync(new URL("test-expectation-file-lifetime/__snapshots__/" + path.basename(name), fixtures), "utf8");
    },
  };
  modules.node_fs = { fs: modules.fs };
  const runner = factory("bun_test.js")(internal);
  context.Bun.deepEquals = util.bunDeepEquals;
  const source = (text: string) => text.replace(/^import[^\n]+\n/gm, "").replace(/^export /gm, "");
  return { lines, process, runner, evaluate, source, stderr: () => stderr,
    setLoader(callback: (file: string) => void) { load = callback; } };
}

async function checkEqualityFixture(control: ReturnType<typeof runtime>) {
  const fixture = new URL("test-equality-platform/", fixtures);
  const body = control.source(readFileSync(new URL("index.ts", fixture), "utf8"));
  const run = control.evaluate(`(function(){return async function(expect){${body}\n};})()`);
  await run(control.runner.exports.expect);
  expect(control.lines.join("\n") + "\n").toBe(readFileSync(new URL("expected.txt", fixture), "utf8"));
}

test("platform equality, accessor order, promise throws and assertion diagnostics", async () => {
  await checkEqualityFixture(runtime());
});

test("Browser data-index reads retain proxy getter order without a proxy detector", async () => {
  await checkEqualityFixture(runtime(() => false));
});

test("mixed object and primitive diagnostics retain the received class label", () => {
  const control = runtime();
  const value = Object.defineProperty(new FormData(), "toJSON", { value: 42 });
  expect(() => control.runner.exports.expect(value).toEqual(1)).toThrow("Received: FormData");
});

test("snapshot file identity permits hooks and asynchronous same-file use", async () => {
  const control = runtime();
  const fixture = new URL("test-expectation-file-lifetime/", fixtures);
  control.setLoader(file => {
    const body = control.source(readFileSync(new URL(path.basename(file), fixture), "utf8"));
    control.evaluate(`(function(){${body}\n})()`);
  });
  await control.runner.run(["/same-file.test.ts"]);
  expect(control.process.exitCode, control.stderr()).toBe(0);
  expect(control.stderr()).toContain("3 pass");
});

test("cached expectations retain file identity through modifiers before snapshot storage", async () => {
  const control = runtime();
  const fixture = new URL("test-expectation-file-lifetime/", fixtures);
  control.evaluate(control.source(readFileSync(new URL("shared.ts", fixture), "utf8")));
  control.setLoader(file => {
    const body = control.source(readFileSync(new URL(path.basename(file), fixture), "utf8"));
    control.evaluate(`(function(){${body}\n})()`);
  });
  await control.runner.run(["/first.ts", "/second.ts"]);
  expect(control.process.exitCode, control.stderr()).toBe(0);
  expect(control.stderr()).toContain("8 pass");
  expect(control.stderr()).not.toContain("Snapshot storage reached");
});
