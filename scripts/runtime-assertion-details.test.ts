import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as util from "node:util";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const runtime = join(root, "crates/bunwasm-runtime/src/js");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-assertion-details-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function factory(path: string): (internal: unknown) => unknown {
  const output = join(scratch, `${path.split("/").pop()}.js`);
  const strip = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), path, output]);
  if (strip.exitCode !== 0) throw new Error(strip.stderr.toString());
  const value: unknown = runInNewContext(readFileSync(output, "utf8"), { URL });
  if (typeof value !== "function") throw new TypeError("Expected emitted runtime factory");
  return internal => value(internal);
}

const partial = factory(join(runtime, "partial_assert.ts"))({ require: () => util });
const module: unknown = factory(process.env.ASSERTION_DETAIL_SOURCE ?? join(runtime, "assert.ts"))({
  require(name: string) {
    if (name === "util") return util;
    if (name === "inspect") return { nodeInspect: util.inspect };
    if (name === "partial_assert") return partial;
    throw new Error(`Unexpected builtin ${name}`);
  },
});
if (typeof module !== "function" || !("AssertionError" in module)) throw new TypeError("Missing AssertionError export");
const Constructor: unknown = module.AssertionError;

function assertion(options: object): object {
  if (typeof Constructor !== "function") throw new TypeError("Invalid AssertionError export");
  return Reflect.construct(Constructor, [options]);
}

function field(error: object, name: string): unknown {
  return Reflect.get(error, name);
}

function groupedKeys(error: object): string[] {
  return Object.keys(error).filter(key => /^(message|actual|expected|operator|stack trace) \d+$/.test(key));
}

const summary = { actual: "summary actual", expected: "summary expected", operator: "summary" };

test("exported AssertionError retains separate ordered detail groups and raw values", () => {
  const stack = new Error("captured call");
  const raw = { nested: true };
  const details = Object.freeze([
    Object.freeze({ message: "first", actual: raw, expected: 2, operator: "calls", stack }),
    Object.freeze({ message: "second", actual: 0, expected: 1, operator: "another", stack: undefined }),
  ]);
  const error = assertion({ message: "summary", ...summary, details });
  expect(groupedKeys(error)).toEqual([
    "message 0", "actual 0", "expected 0", "operator 0", "stack trace 0",
    "message 1", "actual 1", "expected 1", "operator 1", "stack trace 1",
  ]);
  for (const [index, detail] of details.entries()) {
    for (const [key, source] of [["message", "message"], ["actual", "actual"], ["expected", "expected"], ["operator", "operator"], ["stack trace", "stack"]]) {
      if (!key || !source) throw new Error("Missing detail mapping");
      expect(field(error, `${key} ${index}`)).toBe(Reflect.get(detail, source));
    }
  }
  expect(field(error, "actual 0")).toBe(raw);
  expect(field(error, "stack trace 0")).toBe(stack);
  for (const name of ["actual", "expected", "operator"]) expect(Object.hasOwn(error, name)).toBe(false);
  expect(field(error, "name")).toBe("AssertionError");
  expect(field(error, "code")).toBe("ERR_ASSERTION");
  expect(field(error, "message")).toBe("summary");
  expect(field(error, "generatedMessage")).toBe(false);
  expect(typeof field(error, "stack")).toBe("string");
});

test("empty details select detail mode rather than fabricating summary fields", () => {
  const error = assertion({ message: "empty", ...summary, details: Object.freeze([]) });
  expect(groupedKeys(error)).toEqual([]);
  for (const name of ["actual", "expected", "operator"]) expect(Object.hasOwn(error, name)).toBe(false);
});

test("detail groups retain absent fields as own undefined properties", () => {
  const error = assertion({ message: "sparse data", details: [{}] });
  expect(groupedKeys(error)).toHaveLength(5);
  for (const key of groupedKeys(error)) expect(field(error, key)).toBeUndefined();
});

test("ordinary AssertionError keeps its summary and generated message", () => {
  const error = assertion({ actual: 1, expected: 2, operator: "==" });
  expect(field(error, "actual")).toBe(1);
  expect(field(error, "expected")).toBe(2);
  expect(field(error, "operator")).toBe("==");
  expect(field(error, "message")).toBe("1 == 2");
  expect(field(error, "generatedMessage")).toBe(true);
  expect(groupedKeys(error)).toEqual([]);
  const noOperator = assertion({ actual: 1, expected: 2 });
  expect(Object.hasOwn(noOperator, "operator")).toBe(true);
  expect(field(noOperator, "operator")).toBeUndefined();
  expect(field(noOperator, "message")).toBe("1 undefined 2");
});

test("summary input getters retain their original read order and count", () => {
  const reads: string[] = [];
  const options = Object.fromEntries(Object.entries({ message: "custom", operator: "==", stackStartFn: undefined, actual: 1, expected: 2 })
    .map(([key, value]) => [key, { get() { reads.push(key); return value; } }]));
  const error = assertion(Object.defineProperties({}, options));
  expect(reads).toEqual(["message", "operator", "stackStartFn", "actual", "expected"]);
  expect(field(error, "message")).toBe("custom");
});
