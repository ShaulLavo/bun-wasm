import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
const start = source.indexOf("  function isModuleNamespace(value) {");
const end = source.indexOf("  Object.assign(internal,", start);
expect(start).toBeGreaterThan(0);
expect(end).toBeGreaterThan(start);
const predicateSource = `${source.slice(start, end)}; isModuleNamespace`;

type Native = { isModuleNamespaceObject?: (value: unknown) => boolean | undefined };
function predicate(native: Native): (value: unknown) => boolean {
  return runInNewContext(predicateSource, { native });
}

function tagged(prototype: object | null): object {
  const value: object = Object.create(prototype);
  Object.defineProperty(value, Symbol.toStringTag, { value: "Module" });
  return value;
}

test("bootstrap trusts native namespace branding instead of public tags and prototypes", () => {
  const namespace = tagged({ __esModule: true });
  const isNamespace = predicate({ isModuleNamespaceObject: value => value === namespace });
  expect(isNamespace(namespace)).toBe(true);
  expect(isNamespace(tagged(null))).toBe(false);
  expect(isNamespace(tagged(Object.getPrototypeOf(namespace)))).toBe(false);
  const throwing = new Proxy({}, { getPrototypeOf() { throw new Error("must not inspect"); } });
  expect(isNamespace(throwing)).toBe(false);
  expect(isNamespace(new Proxy(namespace, {}))).toBe(false);
});

test("unsupported native brands preserve the Browser, SpiderMonkey and Hermes recognition path", () => {
  for (const native of [{}, { isModuleNamespaceObject: () => undefined }]) {
    const isNamespace = predicate(native);
    expect(isNamespace(tagged(null))).toBe(true);
    expect(isNamespace(tagged({ __esModule: true }))).toBe(false);
    for (const value of [null, undefined, 0, "Module", {}, () => {}]) expect(isNamespace(value)).toBe(false);
  }
});

test("require caches the canonical engine namespace without a surrogate adapter", () => {
  expect(source).toContain("mod.exports = native.requireEsm(path);");
  expect(source).not.toContain('internal.require("require_esm_namespace")');
});
