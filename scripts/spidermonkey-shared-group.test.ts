import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkGroupCommands, checkGroupFeatures, checkGroupSymbols, groupFlags, groupImports, groupRegionConstructor } from "../spidermonkey/shared-group.ts";
import { convertSideInitializers } from "./spidermonkey-side-core-receipt.ts";

const sdk = "/work/cache/sdk";
const text = (value: string) => [value.length].concat(Array.from(value, character => character.charCodeAt(0)));
const section = (id: number, payload: number[]) => [id, payload.length].concat(payload);

/** A just-linked side: one memory import, the core table and stack, two initializers and a start. */
function side(shared: boolean): Uint8Array {
  const memory = text("env").concat(text("memory"), [2], shared ? [3, 1, 1] : [1, 1, 1]);
  const table = text("env").concat(text("__indirect_function_table"), [1, 0x70, 0, 0]);
  const stack = text("env").concat(text("__stack_pointer"), [3, 0x7f, 1]);
  const exports = text("__wasm_apply_data_relocs").concat([0, 0], text("__wasm_call_ctors"), [0, 1]);
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 0]),
    section(2, [3].concat(memory, table, stack)),
    section(3, [3, 0, 0, 0]),
    section(7, [2].concat(exports)),
    section(8, [2]),
    section(10, [3, 2, 0, 0x0b, 2, 0, 0x0b, 2, 0, 0x0b]),
  ));
}

/** One object file with a `target_features` section. */
function object(features: readonly string[]): Uint8Array {
  const entries = features.flatMap(feature => [feature.charCodeAt(0)].concat(text(feature.slice(1))));
  const payload = text("target_features").concat([features.length], entries);
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(section(0, payload)));
}

const command = (flags: readonly string[]) => ({ file: "vm.cpp", arguments: [sdk + "/bin/clang++"].concat(flags, ["-c", "vm.cpp"]) });
const symbols = (undefinedNames: readonly string[], defined: readonly string[] = [groupRegionConstructor]) =>
  defined.map(name => `${name} T 0 0`).concat(undefinedNames.map(name => `${name} U 0 0`)).join("\n") + "\n";

test("a group side imports the shared memory and never exports it", () => {
  const converted = new WebAssembly.Module(convertSideInitializers(side(true), "shared-group"));
  const exported = WebAssembly.Module.exports(converted);
  expect(exported.filter(entry => entry.kind === "memory")).toEqual([]);
  expect(exported.map(entry => entry.name).sort()).toEqual(["__stack_pointer", "spidermonkey_apply_data_relocs", "spidermonkey_call_ctors", "spidermonkey_initialize_memory"]);
});

test("the split conversion keeps its memory export and each profile refuses the other's side", () => {
  const converted = new WebAssembly.Module(convertSideInitializers(side(false)));
  expect(WebAssembly.Module.exports(converted).filter(entry => entry.kind === "memory")).toEqual([{ name: "memory", kind: "memory" }]);
  expect(() => convertSideInitializers(side(true))).toThrow(/program profile/);
  expect(() => convertSideInitializers(side(false), "shared-group")).toThrow(/program profile/);
});

test("every library compile command must carry the group flags", () => {
  expect(checkGroupCommands([command(groupFlags), { file: "host.c", arguments: ["/usr/bin/clang", "-c", "host.c"] }], sdk)).toBe(1);
  for (const missing of groupFlags) {
    expect(() => checkGroupCommands([command(groupFlags.filter(flag => flag !== missing))], sdk)).toThrow(/missing/);
  }
  expect(() => checkGroupCommands([{ file: "host.c", arguments: ["/usr/bin/clang", "-c", "host.c"] }], sdk)).toThrow(/no target compile commands/);
});

test("an archive member without atomics or one that disallows shared memory is refused", () => {
  checkGroupFeatures([{ name: "vm.o", bytes: object(["+atomics", "+bulk-memory", "+mutable-globals"]) }]);
  expect(() => checkGroupFeatures([{ name: "vm.o", bytes: object(["+bulk-memory"]) }])).toThrow(/without atomics/);
  expect(() => checkGroupFeatures([{ name: "vm.o", bytes: object(["+atomics", "-shared-mem"]) }])).toThrow(/disallows shared memory/);
  expect(() => checkGroupFeatures([{ name: "vm.o", bytes: object([]) }])).toThrow(/without atomics/);
});

test("the library defines the region constructor and asks the core only for the group services", () => {
  checkGroupSymbols(symbols(groupImports.concat(["malloc"])));
  expect(() => checkGroupSymbols(symbols(groupImports, []))).toThrow(/constructor/);
  expect(() => checkGroupSymbols(symbols(groupImports.filter(name => name !== "bun_futex_wake")))).toThrow(/bun_futex_wake/);
  expect(() => checkGroupSymbols(symbols(groupImports.concat(["bun_private_queue"])))).toThrow(/undocumented/);
});

test("the group port leaves the split recipe alone and gates every library hunk", () => {
  const patch = readFileSync(resolve("spidermonkey/spidermonkey-shared-group.patch"), "utf8");
  const split = readFileSync(resolve("spidermonkey/spidermonkey-wasi.patch"), "utf8");
  const files = (source: string) => Array.from(source.matchAll(/^diff --git \S+ \S\/(\S+)$/gm), match => match[1]);
  expect(files(patch)).toEqual(["js/public/SharedArrayBuffer.h", "js/src/builtin/AtomicsObject.cpp", "js/src/vm/SharedArrayObject.cpp", "js/src/vm/SharedArrayObject.h"]);
  expect(files(split).filter(file => files(patch).includes(file))).toEqual([]);
  const opened = patch.split("\n").filter(line => /^\+#\s*if(?:n?def)? /.test(line));
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.every(line => line.includes("BUN_WASM_SHARED_GROUP"))).toBe(true);
  const recipe = readFileSync(resolve("spidermonkey/build-shared-group.sh"), "utf8");
  for (const flag of groupFlags) expect(recipe).toContain(flag);
  expect(readFileSync(resolve("scripts/build-engine-spidermonkey.sh"), "utf8")).toContain("SpiderMonkey is split-only");
});

test("the adapter creates region views without pinning or detaching, and allows blocking waits only in a group", () => {
  const shim = readFileSync(resolve("crates/bunwasm-spidermonkey/cpp/engine.cpp"), "utf8");
  const start = shim.indexOf('extern "C" bool bsm_shared_region_buffer(');
  const view = shim.slice(start, shim.indexOf("\n}\n", start));
  expect(view).toContain("JS::NewSharedArrayBufferOverGroupRegion(context, data, length)");
  expect(view).not.toContain("PinArrayBufferOrViewLength");
  expect(view).not.toContain("externalBuffers");
  const guarded = shim.slice(shim.lastIndexOf("#if defined(BUN_WASM_SHARED_GROUP)", shim.indexOf("JS_SetFutexCanWait(context)")), shim.indexOf("JS_SetFutexCanWait(context)"));
  expect(guarded).not.toContain("#endif");
  const adapter = readFileSync(resolve("crates/bunwasm-engine-spidermonkey/src/vm.rs"), "utf8");
  for (const hook of ["fn nested_execute", "unsafe fn shared_wasm_memory_buffer", "fn shared_buffer_resource"]) {
    const at = adapter.indexOf(hook);
    expect(at).toBeGreaterThan(0);
    expect(adapter.slice(adapter.lastIndexOf("\n", adapter.lastIndexOf("#[cfg", at)), at)).toContain("#[cfg(bun_wasm_shared_group)]");
  }
});
