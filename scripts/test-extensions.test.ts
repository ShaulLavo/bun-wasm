import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types } from "node:util";
import { runInNewContext, runInThisContext } from "node:vm";

const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function expression(source: string, bindings?: Record<string, unknown>) {
  const code = `(function () {${transpiler.transformSync(`return (\n${source}\n)`)}\n})()`;
  return bindings ? runInNewContext(code, { setTimeout, ...bindings }) : runInThisContext(code);
}

function factory(name: string) {
  const source = readFileSync(new URL(name, runtime), "utf8");
  return expression(source.replace(/;\s*$/, ""));
}

function matcherSupport(BunFile?: { readonly prototype: object }, bindings?: Record<string, unknown>) {
  const source = readFileSync(new URL("test_matchers.ts", runtime), "utf8");
  return expression(source, bindings)({
    BunFile,
    realTimers: { setTimeout },
    promiseState: Bun.peek.status,
    isPromise: types.isPromise,
    promiseThen: (promise: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (value: unknown) => unknown) =>
      Promise.prototype.then.call(promise, fulfilled, rejected),
  });
}

for (const replacement of ["replaced timer", Symbol("timer"), 1n]) {
  test(`matcher initialization and assertion observation use the stable timer when global timeout is ${typeof replacement}`, async () => {
    const support = matcherSupport(undefined, { setTimeout: replacement, Blob });
    const observer = support.pending();
    let completed = false;
    observer.track(new Promise<void>(resolve => setTimeout(() => { completed = true; resolve(); }, 0)));
    await observer.complete({ ok: true }, (result: unknown) => expect(result).toEqual({ ok: true }));
    expect(completed).toBe(true);
  });
}

function runtimeBlob() {
  const state: {
    native: { platformInfo: { version: string; arch: string }; timeOrigin(): number; utf8Encode(text: string): Uint8Array };
    require(name: string): unknown;
    web?: { Blob: typeof Blob };
  } = {
    native: {
      platformInfo: { version: "test", arch: "test" },
      timeOrigin: () => 0,
      utf8Encode: text => new TextEncoder().encode(text),
    },
    require(name) {
      if (name === "text_decoder") return TextDecoder;
      if (name === "streams") return { ReadableStream };
      if (name === "body_streams") return {};
      return factory(`${name}.ts`)(state);
    },
  };
  factory("web.js")(state);
  if (!state.web) throw new Error("Runtime web factory did not publish its classes");
  return state.web.Blob;
}

async function runFixture(name: string) {
  const fixture = new URL(`../tests/fixtures/${name}/`, import.meta.url);
  const support = matcherSupport();
  const output = factory("pretty_output.ts")({ native: { isatty: () => false } });
  const modules = {
    inspect: { bunInspect: Bun.inspect },
    // Plain reports, whatever FORCE_COLOR the harness runs under.
    pretty_output: { prettyFmt: output.prettyFmt, markup: output.markup, stdout: false, stderr: false },
    util: factory("util.ts")({ isPromise: types.isPromise, promiseThen: (value: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (error: unknown) => unknown) => Promise.prototype.then.call(value, fulfilled, rejected) }),
    test_matchers: support,
  };
  const extensions = factory("test_extensions.ts")({ isPromise: types.isPromise, promiseThen: (value: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (error: unknown) => unknown) => Promise.prototype.then.call(value, fulfilled, rejected), require: (name: keyof typeof modules) => modules[name] });
  const available = { ...modules, test_extensions: extensions };
  const { exports } = factory("bun_test.js")({
    native: {},
    fakeTimers: { api: {} },
    require: (name: keyof typeof available) => available[name],
  });
  const source = readFileSync(new URL("index.ts", fixture), "utf8").replace(/^import[^\n]+\n/, "");
  const run = expression(`(async (expect, console, Bun) => {${source}\n})`);
  const lines: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-extended-"));
  try {
    await run(exports.expect, { log: (line: string) => lines.push(line) }, {
      write: (path: string, value: string) => Bun.write(join(directory, path), value),
      file: (path: string) => Bun.file(join(directory, path)),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(lines.join("\n") + "\n").toBe(readFileSync(new URL("expected.txt", fixture), "utf8"));
}

for (const name of ["test-extend-results", "test-extended-contract"]) {
  test(`${name} through the runtime expect factory`, () => runFixture(name));
}

test("whitespace matchers recognize string data across realms and reject forged prototypes", () => {
  const matchers = matcherSupport().extended(Bun.inspect);
  const foreign = runInNewContext('new String(" a ")');
  expect(matchers.ignoringWhitespace({}, foreign, "a")).toBeNull();
  expect(matchers.ignoringWhitespace({}, "a", foreign)).toBeNull();
  expect(matchers.ignoringWhitespace({}, String.prototype, "")).toBeNull();
  let coercions = 0;
  const fake = Object.assign(Object.create(String.prototype), { toString() { coercions++; return "a"; } });
  expect(matchers.ignoringWhitespace({}, fake, "a")).not.toBeNull();
  expect(() => matchers.ignoringWhitespace({ not: true }, "a", fake)).toThrow(/argument to be a string/);
  expect(coercions).toBe(0);
});

test("emptiness uses actual view and Blob sizes without reading own shadows", () => {
  const support = matcherSupport();
  const failure = new Error("shadow size");
  const full = new Uint8Array(1);
  Object.defineProperty(full, "byteLength", { value: 0 });
  expect(support.empty(full)).toBe(false);
  const empty = new Uint8Array();
  Object.defineProperty(empty, "byteLength", { get() { throw failure; } });
  expect(support.empty(empty)).toBe(true);
  const blob = new Blob();
  Object.defineProperty(blob, "size", { get() { throw failure; } });
  expect(support.empty(blob)).toBe(true);
  const fullBlob = new Blob(["x"]);
  Object.defineProperty(fullBlob, "size", { value: 0 });
  expect(support.empty(fullBlob)).toBe(false);
});

test("emptiness retains the lazy BunFile size accessor", () => {
  let reads = 0;
  class LazyFile extends Blob {
    #storedSize = 1;
    override get size() { return this.#storedSize; }
    override _bytes(): never { reads++; throw new Error("must not read file bytes"); }
  }
  const support = matcherSupport({ prototype: LazyFile.prototype });
  const file = new LazyFile();
  Object.defineProperty(file, "size", { get() { throw new Error("shadow file size"); } });
  expect(support.empty(file)).toBe(false);
  expect(reads).toBe(0);
});

test("runtime Blob emptiness never dispatches an own byte-reader shadow", () => {
  const RuntimeBlob = runtimeBlob();
  const support = matcherSupport(undefined, { Blob: RuntimeBlob });
  const sentinel = new Error("shadow byte reader");
  const empty = new RuntimeBlob();
  Object.defineProperty(empty, "_bytes", { get() { throw sentinel; } });
  expect(support.empty(empty)).toBe(true);
  const fakeFull = new RuntimeBlob();
  Object.defineProperty(fakeFull, "_bytes", { value: () => new Uint8Array(1) });
  expect(support.empty(fakeFull)).toBe(true);
  const full = new RuntimeBlob(["x"]);
  Object.defineProperty(full, "_bytes", { value: () => new Uint8Array() });
  expect(support.empty(full)).toBe(false);
});
