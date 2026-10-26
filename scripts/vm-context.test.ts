import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/builtins.js", import.meta.url), "utf8");
const installBuiltins = runInThisContext(source, { filename: "bun-wasm:builtins" });

type VmModule = typeof import("node:vm");

function vmModule(): VmModule {
  const internal = {
    native: { evalScript: (code: string) => runInThisContext(code) },
    builtinFactories: {} as Record<string, () => unknown>,
    require(name: string) {
      if (name === "dns") return {};
      throw new Error(`Unexpected eager builtin: ${name}`);
    },
  };
  installBuiltins(internal);
  return internal.builtinFactories["node:vm"]!() as VmModule;
}

function withoutSentinel<T>(callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__vmContextSentinel");
  delete (globalThis as Record<string, unknown>).__vmContextSentinel;
  try {
    return callback();
  } finally {
    delete (globalThis as Record<string, unknown>).__vmContextSentinel;
    if (descriptor) Object.defineProperty(globalThis, "__vmContextSentinel", descriptor);
  }
}

describe("VM context global binding", () => {
  test("writes through globalThis to the reusable context without outer pollution", () => {
    withoutSentinel(() => {
      const vm = vmModule();
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
      const vm = vmModule();
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
    const vm = vmModule();
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
    const vm = vmModule();
    const context = {};
    expect(vm.runInNewContext("Math === globalThis.Math", context)).toBe(false);
    expect(vm.runInNewContext("Math.max(3, 8)", context)).toBe(8);
    expect(vm.isContext(context)).toBe(true);
  });
});
