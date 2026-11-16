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

function matcherSupport() {
  return factory("test_matchers.ts")({
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
