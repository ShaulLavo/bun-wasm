import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInThisContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/builtins.js", import.meta.url), "utf8");
const installBuiltins = runInThisContext(source, { filename: "bun-wasm:builtins" });
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-vm-context-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
type Factory = (internal: object) => unknown;
type Prepared = { name: string; source: string; scope: string | null; edits: number[]; fallback: string | null };
// The same source-to-edits records prepare.rs's tests check against Bun's parser.
const fixture: { cases: Prepared[] } = JSON.parse(readFileSync(new URL("../tests/fixtures/vm-context-prepare.json", import.meta.url), "utf8"));
const prepared = new Map(fixture.cases.map(value => [value.source, value]));
const factories: Record<string, Factory> = {};
beforeAll(() => {
  for (const name of ["source_prepare", "vm_context"]) {
    const output = join(scratch, `${name}.js`);
    const result = Bun.spawnSync(["node", "--disable-warning=ExperimentalWarning", new URL("./transpile-runtime.ts", import.meta.url).pathname,
      new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url).pathname, output], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    factories[name] = runInThisContext(readFileSync(output, "utf8"), { filename: `bun-wasm:${name}` });
  }
});

type VmModule = typeof import("node:vm");
type Engine = "quickjs" | "hermes";

// Not Hermes: host JavaScript stands in for the engine, so this checks the lowered source and the
// scope lookups. Like pinned Hermes, the stub refuses `with`; prepareSource answers from the fixture.
function hermesNative(compiled: string[]) {
  return {
    engine: "hermes",
    evalScript(code: string, filename: string) {
      compiled.push(code);
      if (code.includes("with (")) throw new SyntaxError("1:43:with statement is not supported");
      return runInThisContext(code, { filename });
    },
    prepareSource(text: string, goal: string) {
      const value = prepared.get(text);
      if (goal !== "vm-context" || !value) throw new Error(`No ${goal} fixture for ${JSON.stringify(text)}`);
      return JSON.stringify({ version: 6, alreadyPrepared: false, edits: value.edits, columns: [], fallback: value.fallback,
        spreadEval: 0, unhookedAwaitUsing: 0, scope: value.scope ?? undefined });
    },
  };
}

function vmModule(engine: Engine = "quickjs", compiled: string[] = []): VmModule {
  const polyfills = new Map<string, unknown>();
  const internal = {
    native: engine === "hermes" ? hermesNative(compiled) : { engine, evalScript: (code: string) => runInThisContext(code) },
    builtinFactories: {} as Record<string, () => unknown>,
    require(name: string) {
      if (name === "dns") return {};
      if (name !== "vm_context") throw new Error(`Unexpected eager builtin: ${name}`);
      if (!polyfills.has(name)) polyfills.set(name, factories[name]!(internal));
      return polyfills.get(name);
    },
  };
  factories.source_prepare!(internal);
  installBuiltins(internal);
  return internal.builtinFactories["node:vm"]!() as VmModule;
}

function withoutGlobals<T>(names: string[], callback: () => T): T {
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const clear = () => names.forEach(name => delete (globalThis as Record<string, unknown>)[name]);
  clear();
  try {
    return callback();
  } finally {
    clear();
    descriptors.forEach((descriptor, index) => descriptor && Object.defineProperty(globalThis, names[index]!, descriptor));
  }
}

function withoutSentinel<T>(callback: () => T): T {
  return withoutGlobals(["__vmContextSentinel"], callback);
}

describe.each(["quickjs", "hermes"] as const)("VM context global binding (%s)", engine => {
  test("writes through globalThis to the reusable context without outer pollution", () => {
    withoutSentinel(() => {
      const vm = vmModule(engine);
      const context: Record<string, unknown> = vm.createContext({});
      const result = vm.runInContext("globalThis.__vmContextSentinel = 41", context);
      expect(result).toBe(41);
      expect(context.__vmContextSentinel).toBe(41);
      expect((globalThis as Record<string, unknown>).__vmContextSentinel).toBeUndefined();
      const descriptor = Object.getOwnPropertyDescriptor(context, "globalThis");
      expect(descriptor).toMatchObject({ value: context, writable: true, enumerable: false, configurable: true });
      expect(Object.keys(context)).toEqual(["__vmContextSentinel"]);

      expect(vm.runInNewContext("globalThis.__vmContextSentinel += 1; globalThis.__vmContextSentinel", context)).toBe(42);
      expect(context.__vmContextSentinel).toBe(42);
      expect(Object.getOwnPropertyDescriptor(context, "globalThis")).toEqual(descriptor);
      expect((globalThis as Record<string, unknown>).__vmContextSentinel).toBeUndefined();
    });
  });

  test("preserves caller-provided data and accessor descriptors", () => {
    withoutSentinel(() => {
      const vm = vmModule(engine);
      const customGlobal: Record<string, unknown> = { marker: 7 };
      const dataContext = { globalThis: customGlobal };
      const dataDescriptor = Object.getOwnPropertyDescriptor(dataContext, "globalThis");
      expect(vm.runInNewContext("globalThis.__vmContextSentinel = globalThis.marker", dataContext)).toBe(7);
      expect(customGlobal).toEqual({ marker: 7, __vmContextSentinel: 7 });
      expect(Object.getOwnPropertyDescriptor(dataContext, "globalThis")).toEqual(dataDescriptor);

      const inheritedContext = Object.create(dataContext);
      expect(vm.runInNewContext("globalThis.marker", inheritedContext)).toBe(7);
      expect(Object.hasOwn(inheritedContext, "globalThis")).toBe(false);
      expect(Object.getOwnPropertyDescriptor(dataContext, "globalThis")).toEqual(dataDescriptor);

      let reads = 0;
      const accessorContext = {};
      Object.defineProperty(accessorContext, "globalThis", {
        get() { reads++; return customGlobal; },
        enumerable: false,
        configurable: false,
      });
      const accessorDescriptor = Object.getOwnPropertyDescriptor(accessorContext, "globalThis");
      expect(vm.runInNewContext("globalThis.marker", accessorContext)).toBe(7);
      expect(reads).toBe(1);
      expect(Object.getOwnPropertyDescriptor(accessorContext, "globalThis")).toEqual(accessorDescriptor);
      expect((globalThis as Record<string, unknown>).__vmContextSentinel).toBeUndefined();
    });
  });

  test("does not redefine bindings on frozen contexts", () => {
    const vm = vmModule(engine);
    const customGlobal = { marker: 9 };
    const bound = Object.freeze({ globalThis: customGlobal });
    const boundDescriptor = Object.getOwnPropertyDescriptor(bound, "globalThis");
    expect(vm.runInNewContext("globalThis.marker", bound)).toBe(9);
    expect(Object.getOwnPropertyDescriptor(bound, "globalThis")).toEqual(boundDescriptor);

    const unbound = Object.freeze({ marker: 11 });
    expect(vm.runInNewContext("marker", unbound)).toBe(11);
    expect(Object.getOwnPropertyDescriptor(unbound, "globalThis")).toBeUndefined();
    expect(Object.isFrozen(unbound)).toBe(true);
  });

  test("keeps the existing fallback-global partial realm", () => {
    const vm = vmModule(engine);
    const context = {};
    expect(vm.runInNewContext("Math === globalThis.Math", context)).toBe(false);
    expect(vm.runInNewContext("Math.max(3, 8)", context)).toBe(8);
    expect(vm.isContext(context)).toBe(true);
  });
});

describe("VM context scripts without with (hermes stub)", () => {
  test("compiles context code without with or eval", () => {
    const compiled: string[] = [];
    const vm = vmModule("hermes", compiled);
    expect(vm.runInNewContext("marker", { marker: 1 })).toBe(1);
    expect(compiled).toHaveLength(1);
    expect(compiled[0]).toStartWith("(function (__bunwasm_vm, __bunwasm_vm_typeof) {\n");
    expect(compiled[0]).not.toContain("with (");
    expect(compiled[0]).not.toContain("eval(");
  });

  test("writes Next manifests through the supplied globalThis and process.env", () => {
    withoutGlobals(["__RSC_MANIFEST"], () => {
      const vm = vmModule("hermes");
      const context: Record<string, unknown> = { process: { env: { X: "from context" } } };
      const source = prepared.get("globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[\"/p\"]={a:process.env.X}")!.source;
      expect(vm.runInNewContext(source, context)).toEqual({ a: "from context" });
      expect(context.__RSC_MANIFEST).toEqual({ "/p": { a: "from context" } });
      expect("__RSC_MANIFEST" in globalThis).toBe(false);
    });
  });

  test("returns webpack's magic comment object", () => {
    const vm = vmModule("hermes");
    expect(vm.runInContext("(function(){return {webpackMode:\"eager\"};})()", vm.createContext(undefined))).toEqual({ webpackMode: "eager" });
  });

  test("looks names up live, also from closures that outlive the call", () => {
    const vm = vmModule("hermes");
    const context: Record<string, unknown> = {};
    expect(vm.runInNewContext("globalThis.added = 1; added", context)).toBe(1);
    const read = vm.runInNewContext("(() => late)", context) as () => unknown;
    expect(() => read()).toThrow(new ReferenceError("late is not defined"));
    context.late = 5;
    expect(read()).toBe(5);
    expect(vm.runInNewContext("typeof window", context)).toBe("undefined");
  });

  test("keeps lexical, destructured, function and CommonJS bindings straight", () => {
    const vm = vmModule("hermes");
    expect(vm.runInNewContext("let x = 1; x", { x: 9 })).toBe(1);
    expect(vm.runInNewContext("const {a, b: [c]} = o; a + c + d", { o: { a: 1, b: [2] }, d: 3, a: 100, c: 200 })).toBe(6);
    const context = { module: {} as Record<string, unknown>, exports: { value: 1 }, require: 2 };
    expect(vm.runInNewContext("module.exports = exports.value + require", context)).toBe(3);
    expect(context.module.exports).toBe(3);
    expect(vm.runInNewContext("var exports = 1; exports", context)).toBe(1);
  });

  test("handles escaped and Unicode names and keeps the scope parameter hygienic", () => {
    const vm = vmModule("hermes");
    expect(vm.runInNewContext("\\u0078 + \\u{79}", { x: 1, y: 2 })).toBe(3);
    expect(vm.runInNewContext("ünï + ({ü})", { ünï: 1, ü: 2 })).toBe("1[object Object]");
    expect(vm.runInNewContext("var __bunwasm_vm = 1; function f(__bunwasm_vm1_typeof) {} x", { x: 3 })).toBe(3);
  });

  test("propagates the original thrown objects", () => {
    const vm = vmModule("hermes");
    const error = new Error("boom");
    expect(() => vm.runInNewContext("boom()", { boom() { throw error; } })).toThrow(error);
    const getter = { get trap(): never { throw error; } };
    let caught: unknown;
    try { vm.runInNewContext("trap", getter); } catch (thrown) { caught = thrown; }
    expect(caught).toBe(error);
  });

  test("writes bindings like with: silent in sloppy code, TypeError in strict code", () => {
    const vm = vmModule("hermes");
    const context = { marker: 1 };
    expect(vm.runInNewContext("marker = 12", context)).toBe(12);
    expect(context.marker).toBe(12);
    const frozen = Object.freeze({ marker: 1 });
    expect(vm.runInNewContext("marker = 12", frozen)).toBe(12);
    expect(() => vm.runInNewContext("\"use strict\"; marker = 12", frozen)).toThrow(TypeError);
    expect(frozen.marker).toBe(1);
  });

  test("rejects syntax before reading the context", () => {
    const vm = vmModule("hermes");
    let reads = 0;
    const context = { get x() { reads++; return 1; } };
    expect(() => vm.runInNewContext("x +", context)).toThrow(new SyntaxError("Unexpected end of file"));
    expect(() => vm.runInNewContext("import x from \"y\"", context)).toThrow(SyntaxError);
    expect(() => vm.runInNewContext("return 1", context)).toThrow(SyntaxError);
    expect(reads).toBe(0);
  });

  test("pins the named partial-realm limits", () => {
    withoutGlobals(["later", "undeclared"], () => {
      const vm = vmModule("hermes");
      // `with` passes the context as `this` to a bare call; a scope member call passes undefined.
      const receiver = { whoami(this: unknown) { return this; } };
      expect(vm.runInNewContext("whoami()", receiver)).toBeUndefined();
      // Only the final top-level expression statement completes.
      expect(vm.runInNewContext("if (a) { 1 }", { a: true })).toBeUndefined();
      // A top-level var stays local to the call, even when the context has the name.
      const context: Record<string, unknown> = { v: 5 };
      expect(vm.runInNewContext("var v = 1; v", context)).toBe(1);
      expect(context.v).toBe(5);
      // The binding is chosen when the write happens, after the right-hand side runs.
      expect(vm.runInNewContext("later = (globalThis.later = 1, 2)", context)).toBe(2);
      expect(context.later).toBe(2);
      expect("later" in globalThis).toBe(false);
      // Writes to names nobody has go to the host global, also from strict code.
      expect(vm.runInNewContext("\"use strict\"; undeclared = 1", {})).toBe(1);
      expect((globalThis as Record<string, unknown>).undeclared).toBe(1);
    });
  });
});
