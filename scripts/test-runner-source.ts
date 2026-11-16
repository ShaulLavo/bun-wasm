import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { createContext, runInContext } from "node:vm";

const root = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });
type Body = () => unknown;
type Options = { retry?: number; repeats?: number };
interface RegisterTest {
  (name: string, fn?: Body, options?: Options): void;
  failing(name: string, fn?: Body): void;
  only(name: string, fn?: Body): void;
}
interface RegisterDescribe {
  (name: string | Body, fn?: Body): void;
  skip(name: string, fn?: Body): void;
  todo(name: string, fn?: Body): void;
  only(name: string, fn?: Body): void;
}
export interface API {
  test: RegisterTest;
  describe: RegisterDescribe;
  beforeAll(fn: Body): void;
  beforeEach(fn: Body): void;
  afterEach(fn: Body): void;
  afterAll(fn: Body): void;
  onTestFinished(fn: Body): void;
  jest: { setTimeout(ms: number): void };
}

export async function runner(load: (api: API, file: string) => void | Promise<void>, paths: readonly string[] = ["/control.test.ts"], preloads: readonly string[] = []) {
  const process = Object.assign(new EventEmitter(), { env: { AGENT: "0" }, exitCode: 0 });
  const context = createContext({ process, setTimeout, clearTimeout, Blob, Headers, FormData, URLSearchParams,
    Bun: { version: "test", revision: "test" } });
  const factory = (name: string) => runInContext(`(function () {${transpiler.transformSync(`return (${readFileSync(new URL(name, root), "utf8")})`)}\n})()`, context);
  let stderr = "";
  const then = Promise.prototype.then;
  const modules: Record<string, unknown> = {
    path, inspect: { bunInspect: Bun.inspect }, util: { bunDeepEquals: isDeepStrictEqual },
    test_matchers: factory("test_matchers.ts")({ isPromise: types.isPromise, realTimers: { setTimeout },
      promiseThen: (promise: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected: (error: unknown) => unknown) => then.call(promise, fulfilled, rejected) }),
  };
  const internal = {
    native: { now: () => performance.now(), cwd: () => "/", stat: () => ({ mode: 0o100644 }),
      writeStdout() {}, writeStderr: (value: string) => { stderr += value; } },
    require: (name: string) => modules[name], builtin: () => ({ AsyncLocalStorage }),
    isPromise: types.isPromise,
    promiseThen: (promise: Promise<unknown>, fulfilled: () => void, rejected: (error: unknown) => void) => then.call(promise, fulfilled, rejected),
    realTimers: { setTimeout, clearTimeout }, fakeTimers: { api: {} },
    importModule: async (file: string) => load(runtime.exports, file),
  };
  modules.test_extensions = factory("test_extensions.ts")(internal);
  modules.test_lifecycle = factory("test_lifecycle.ts")();
  modules.test_collection = factory("test_collection.ts")(internal);
  const runtime = factory("bun_test.js")(internal);
  await runtime.run(preloads.flatMap(file => ["--preload", file]).concat(paths));
  return { stderr, exit: process.exitCode };
}
