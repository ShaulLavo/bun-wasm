import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-typed-utilities-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function factory(name: string) {
  const output = join(scratch, `${name}.js`);
  const emitted = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), output], { stdout: "pipe", stderr: "pipe" });
  expect(emitted.exitCode).toBe(0);
  return runInNewContext(readFileSync(output, "utf8"), { ArrayBuffer, Uint8Array, DataView, SyntaxError, TypeError });
}

test("emitted JSONL preserves partial parsing and UTF-8 read offsets", () => {
  const parse = factory("jsonl")({
    native: {
      utf8Encode: (text: string) => new TextEncoder().encode(text),
      utf8Decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
    },
    require: () => ({ parse: JSON.parse }),
    toUint8: (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  });
  const bytes = new TextEncoder().encode('\ufeff{"é":1}\n[true,');
  const result = parse.parseChunk(bytes);
  expect(result.values).toEqual([{ é: 1 }]);
  expect(result.read).toBe(11);
  expect(result.done).toBe(false);
  expect(result.error).toBeNull();
  const invalid = parse.parseChunk("true\n{bad}");
  expect(invalid.values).toEqual([true]);
  expect(invalid.error).toBeInstanceOf(SyntaxError);
  expect(() => parse.parse(null)).toThrow("JSONL.parse requires a string argument");
  expect(parse.parseChunk({ toString: () => "null\n7" }).values).toEqual([null, 7]);
});

test("emitted node:test adapter preserves registration selection and hook identity", () => {
  const calls: { kind: string; name: string; value: unknown; timeout: unknown }[] = [];
  const register = (kind: string) => (name: string, callback?: () => unknown, timeout?: unknown) => {
    calls.push({ kind, name, value: callback?.(), timeout });
    return kind;
  };
  const runner = {
    test: Object.assign(register("test"), { skip: register("skip"), todo: register("todo"), only: register("only") }),
    describe: register("describe"), beforeAll() {}, afterAll() {}, beforeEach() {}, afterEach() {},
  };
  const adapter = factory("node_test")({ require: () => ({ exports: runner }) });
  expect(adapter("plain", () => 1)).toBe("test");
  adapter("skip wins", { skip: true, todo: true, timeout: 17 }, () => 2);
  adapter.only("todo wins", { todo: "later" }, () => 3);
  adapter.skip("explicit", null, () => 4);
  adapter.todo("pending");
  expect(calls).toEqual([
    { kind: "test", name: "plain", value: 1, timeout: undefined },
    { kind: "skip", name: "skip wins", value: 2, timeout: 17 },
    { kind: "todo", name: "todo wins", value: 3, timeout: undefined },
    { kind: "skip", name: "explicit", value: 4, timeout: undefined },
    { kind: "todo", name: "pending", value: undefined, timeout: undefined },
  ]);
  expect(adapter.test).toBe(adapter);
  expect(adapter.it).toBe(adapter);
  expect(adapter.describe).toBe(runner.describe);
  expect(adapter.suite).toBe(runner.describe);
  expect(adapter.before).toBe(runner.beforeAll);
  expect(adapter.after).toBe(runner.afterAll);
  expect(adapter.beforeEach).toBe(runner.beforeEach);
  expect(adapter.afterEach).toBe(runner.afterEach);
});

function contracts(text: string) {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(probe, 'declare const internal: BunWasm.Internal;\n' + text);
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [],
    files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), probe],
  }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("accepts JSONL native and builtin test-runner contracts", () => {
  const result = contracts('internal.native.utf8Decode(internal.native.utf8Encode("é"));\ninternal.require("formats").parse("null", "JSON");\ninternal.require("bun_test").exports.test("works", () => 1, 10);');
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const invalidContracts: [label: string, text: string][] = [
  ["decode text", 'internal.native.utf8Decode("not bytes");'],
  ["encode number", "internal.native.utf8Encode(1);"],
  ["format kind", 'internal.require("formats").parse("null", "OTHER");'],
  ["test callback", 'internal.require("bun_test").exports.test("bad", 1);'],
  ["test name", 'internal.require("bun_test").exports.test(1, () => {});'],
];
for (const [label, text] of invalidContracts) {
  test(`rejects an invalid utility contract: ${label}`, () => {
    const result = contracts(text);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
