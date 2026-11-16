import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types, isDeepStrictEqual } from "node:util";
import { runInNewContext, runInThisContext } from "node:vm";

const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function expression(source: string) {
  return runInThisContext(`(function () {${transpiler.transformSync(`return (\n${source}\n)`)}\n})()`);
}

function factory(name: string) {
  const source = readFileSync(new URL(name, runtime), "utf8");
  return expression(source);
}

function matcherSupport(BunFile?: { readonly prototype: object }) {
  return factory("test_matchers.ts")({
    BunFile,
    isPromise: types.isPromise,
    promiseThen: (promise: Promise<unknown>, fulfilled: (value: unknown) => unknown, rejected?: (value: unknown) => unknown) =>
      Promise.prototype.then.call(promise, fulfilled, rejected),
  });
}

async function runFixture(name: string) {
  const fixture = new URL(`../tests/fixtures/${name}/`, import.meta.url);
  const support = matcherSupport();
  const modules = {
    inspect: { bunInspect: Bun.inspect },
    util: { bunDeepEquals: isDeepStrictEqual },
    test_matchers: support,
  };
  const extensions = factory("test_extensions.ts")({ require: (name: keyof typeof modules) => modules[name] });
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
    _bytes() { reads++; throw new Error("must not read file bytes"); }
  }
  const support = matcherSupport({ prototype: LazyFile.prototype });
  const file = new LazyFile();
  Object.defineProperty(file, "size", { get() { throw new Error("shadow file size"); } });
  expect(support.empty(file)).toBe(false);
  expect(reads).toBe(0);
});
