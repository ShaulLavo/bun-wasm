import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/require_namespace.ts", import.meta.url), "utf8");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);
const factory: () => (value: unknown) => Record<string, unknown> = runInNewContext(compiled);

test("CommonJS namespace retains the whole export as default and live named values", () => {
  const namespace = factory();
  const value = { __esModule: true, default: "not the module", named: 1 };
  const wrapped = namespace(value);
  expect(wrapped.default).toBe(value);
  expect(wrapped.named).toBe(1);
  value.named++;
  expect(wrapped.named).toBe(2);
  expect(namespace(value)).toBe(wrapped);
});

test("CommonJS namespace accepts functions, primitives and prototype-like names", () => {
  const namespace = factory();
  const fn = Object.assign(() => "called", { named: 3 });
  expect(namespace(fn).default).toBe(fn);
  expect(namespace(fn).named).toBe(3);
  for (const value of [null, undefined, false, 0, "text"]) expect(namespace(value).default).toBe(value);
  const value = JSON.parse('{"__proto__": 1, "constructor": 2}');
  expect(namespace(value).__proto__).toBe(1);
  expect(Reflect.get(namespace(value), "constructor")).toBe(2);
});
