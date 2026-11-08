import type {} from "../crates/bunwasm-runtime/src/js/import_requests_types.d.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/import_requests.ts", import.meta.url), "utf8");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);

function helpers() {
  const context = vm.createContext({});
  const factory = vm.runInContext(code, context);
  const internal = { native: { engine: "host" }, defineGlobal(name: string, value: unknown) { context[name] = value; } };
  const imports: BunWasm.ImportRequests = factory(internal);
  return imports;
}

function normalized(imports: BunWasm.ImportRequests, specifier: unknown, options?: unknown) {
  return imports.request<{ text: string; mode: BunWasm.ImportMode }>(specifier, options, (text, mode, resolve) => resolve({ text, mode }));
}

test("dynamic import snapshots attributes before deferring loading", async () => {
  const imports = helpers();
  const events: string[] = [];
  const specifier = { toString() { events.push("specifier"); return "./page.html"; } };
  const attributes = { get ignored() { events.push("ignored"); return "yes"; }, type: "text" };
  const options = { get with() { events.push("with"); return attributes; } };
  const first = normalized(imports, specifier, options);
  expect(events).toEqual(["specifier", "with", "ignored"]);
  attributes.type = "other";
  const second = normalized(imports, specifier, options);
  expect(first).not.toBe(second);
  expect(await first).toEqual({ text: "./page.html", mode: "text" });
  expect(await second).toEqual({ text: "./page.html", mode: "inferred" });
});

test("gathers enumerable own strings and values in order before validating", async () => {
  const imports = helpers();
  const events: string[] = [];
  const attributes = new Proxy({ bad: 1, type: "text", [Symbol()]: "ignored" }, {
    ownKeys(target) { events.push("keys"); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { events.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    get(target, key) { events.push(`get:${String(key)}`); return Reflect.get(target, key); },
  });
  await expect(normalized(imports, "page", { with: attributes })).rejects.toHaveProperty("name", "TypeError");
  expect(events).toEqual(["keys", "descriptor:bad", "get:bad", "descriptor:type", "get:type"]);
  const inherited = Object.create({ type: "text" });
  expect((await normalized(imports, "page", { with: inherited })).mode).toBe("inferred");
});

test("coercion and getter failures reject with the exact thrown value", async () => {
  const imports = helpers();
  const failure = { exact: true };
  const inputs: [unknown, unknown][] = [
    [{ toString() { throw failure; } }, undefined],
    ["page", { get with() { throw failure; } }],
    ["page", { with: { get ignored() { throw failure; }, type: "text" } }],
  ];
  for (const [specifier, options] of inputs) {
    await expect(normalized(imports, specifier, options)).rejects.toBe(failure);
  }
  await expect(imports.request("page", undefined, () => { throw failure; })).rejects.toBe(failure);
});

test("rejects Symbols and malformed options without coercing attribute values", async () => {
  const imports = helpers();
  await expect(normalized(imports, Symbol("page"))).rejects.toHaveProperty("name", "TypeError");
  for (const options of [null, 1, "text", { with: null }, { with: false }, { with: { type: { toString() { throw "must not run"; } } } }]) {
    await expect(normalized(imports, "page", options)).rejects.toHaveProperty("name", "TypeError");
  }
  expect((await normalized(imports, "page", { with: { other: "ignored", type: "unknown" } })).mode).toBe("inferred");
});

test("a record factory created before bootstrap initializes without a new Hermes native method", async () => {
  const context = vm.createContext({});
  const loaderText = readFileSync(new URL("../crates/bunwasm-runtime/src/js/esm_loader.ts", import.meta.url), "utf8");
  const loaderCode = new Bun.Transpiler({ loader: "ts" }).transformSync(loaderText.replace("(function (", "globalThis.factory = (function ("));
  const factory = vm.runInContext(loaderCode, context);
  const native = {
    resolve: (specifier: string) => specifier,
    load: () => ({ namespace: { value: "text" }, default: "text" }),
    initMeta() {},
  };
  const loader = factory(native);
  expect(Object.keys(native).sort()).toEqual(["initMeta", "load", "resolve"]);
  const initialize = vm.runInContext(code, context);
  const resolved: string[][] = [];
  initialize({
    native: {
      engine: "hermes",
      resolveImport(specifier: string, referrer: string, mode: string) { resolved.push([specifier, referrer, mode]); return "bunwasm:text:0"; },
      importModule: (name: string) => loader.importName(name),
    },
    defineGlobal(name: string, value: unknown) { context[name] = value; },
  });
  const first = loader.dynamicImport("./page.html", "/entry.mjs", { with: { type: "text" } });
  const second = vm.runInContext('__bunwasm_dynamicImport("/entry.mjs")("./page.html", { with: { type: "text" } })', context);
  expect(first).not.toBe(second);
  expect(await first).toBe(await second);
  expect((await first).default).toBe("text");
  expect(resolved).toEqual([["./page.html", "/entry.mjs", "text"], ["./page.html", "/entry.mjs", "text"]]);
});

test("native import hooks ignore lexical globalThis bindings, including JSC", async () => {
  const context = vm.createContext({});
  const functionSource = readFileSync(new URL("../crates/bunwasm-runtime/src/js/function.ts", import.meta.url), "utf8");
  const factory = vm.runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.functionFactory = ${functionSource}`), context);
  const calls: unknown[][] = [];
  context.__bunwasm_dynamicImport = (from: string) => (specifier: unknown, options: unknown) => {
    calls.push([from, specifier, options]);
    return Promise.resolve(specifier);
  };
  factory({ native: { engine: "jsc" } });
  const result = vm.runInContext(`
    const globalThis = {};
    (function(globalThis) {
      return (function(){})["__bunwasmFunctionImport"]("/entry.mjs")("./page.html", { with: { type: "text" } });
    })({});
  `, context);
  expect(await result).toBe("./page.html");
  expect(calls).toEqual([["/entry.mjs", "./page.html", { with: { type: "text" } }]]);
});

test("Browser metadata helpers follow the current host dispatch after replacement", () => {
  const context = vm.createContext({});
  const functionSource = readFileSync(new URL("../crates/bunwasm-runtime/src/js/function.ts", import.meta.url), "utf8");
  const factory = vm.runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.functionFactory = ${functionSource}`), context);
  factory({
    native: { engine: "host" },
    require: () => ({ "bun:jsc": () => ({ callerSourceOrigin: () => null }) }),
    defineGlobal(name: string, value: unknown) { context[name] = value; },
    initImportMeta() { throw new Error("Must not retain bootstrap metadata state"); },
  });
  const meta = {};
  context.__bunwasm_meta = (value: object, path: string) => Object.assign(value, { owner: "first", path });
  const initialize = vm.runInContext('(function(){})["__bunwasmModuleMeta"]', context);
  Reflect.apply(initialize, undefined, [meta, "/first.mjs"]);
  expect(meta).toEqual({ owner: "first", path: "/first.mjs" });
  context.__bunwasm_meta = (value: object, path: string) => Object.assign(value, { owner: "second", path });
  Reflect.apply(initialize, undefined, [meta, "/second.mjs"]);
  expect(meta).toEqual({ owner: "second", path: "/second.mjs" });
});
