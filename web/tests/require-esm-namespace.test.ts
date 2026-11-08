import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/require_esm_namespace.ts", import.meta.url), "utf8");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);
const factory: () => (value: object) => object = runInNewContext(compiled);

test("required ES namespace view keeps live getters, its tag, and cached identity", () => {
  const wrap = factory();
  let value = 1;
  const original = Object.create(null);
  Object.defineProperty(original, "value", { get: () => value, enumerable: true });
  Object.defineProperty(original, Symbol.toStringTag, { value: "Module" });
  Object.preventExtensions(original);
  const namespace = wrap(original);
  expect(Reflect.get(namespace, "__esModule")).toBe(true);
  expect("__esModule" in namespace).toBe(true);
  expect(Object.hasOwn(namespace, "__esModule")).toBe(false);
  expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(namespace), "__esModule")?.enumerable).toBe(false);
  expect(Object.keys(namespace)).toEqual(["value"]);
  expect(Object.prototype.toString.call(namespace)).toBe("[object Module]");
  value++;
  expect(Reflect.get(namespace, "value")).toBe(2);
  expect(wrap(original)).toBe(namespace);
  expect(Reflect.get(original, "__esModule")).toBeUndefined();
  expect(Object.isExtensible(namespace)).toBe(false);
  expect(Reflect.set(namespace, "value", 3)).toBe(false);
});

test("namespace view does not read exports until requested", () => {
  const original = Object.create(null);
  const failure = new ReferenceError("uninitialized export");
  Object.defineProperty(original, "value", { get() { throw failure; }, enumerable: true });
  const namespace = factory()(original);
  expect(Object.keys(namespace)).toEqual(["value"]);
  expect(() => Reflect.get(namespace, "value")).toThrow(failure);
});

test("explicit false and undefined module markers keep the original live namespace", () => {
  const wrap = factory();
  for (const initial of [false, undefined]) {
    const original = { __esModule: initial };
    expect(wrap(original)).toBe(original);
    original.__esModule = true;
    expect(Reflect.get(wrap(original), "__esModule")).toBe(true);
  }
});
