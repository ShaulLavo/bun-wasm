import { expect, test } from "bun:test";
import { earlyInstance } from "../src/early-instance";
import { programMetadata, prepareProgram } from "../../src/assets";
import { wasmHasStartFunction } from "../../src/engine-kind";

const name = (text: string) => [text.length].concat(Array.from(text, character => character.charCodeAt(0)));
const section = (id: number, bytes: readonly number[]) => [id, bytes.length].concat(bytes);
const binary = (...sections: number[][]) => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(...sections));
const wasm = (bytes: Uint8Array<ArrayBuffer>) => new WebAssembly.Module(bytes);
const BINARY = [0x60, 2, 0x7f, 0x7f, 1, 0x7f];
const NULLARY = [0x60, 0, 0];

/** Imports `env.add` and exports `call(a, b)`, which returns what the import returns. */
const caller = () => binary(
  section(1, [1].concat(BINARY)),
  section(2, [1].concat(name("env"), name("add"), [0, 0])),
  section(3, [1, 0]),
  section(7, [1].concat(name("call"), [0, 1])),
  section(10, [1, 8, 0, 0x20, 0, 0x20, 1, 0x10, 0, 0x0b]),
);
/** Calls its `env.boot` import from a start function. */
const starter = () => binary(section(1, [1].concat(NULLARY)), section(2, [1].concat(name("env"), name("boot"), [0, 0])), section(8, [0]));
/** Runs a start function that writes 42 to its own memory and calls no import. */
const writer = () => binary(
  section(1, [1].concat(NULLARY)), section(3, [1, 0]), section(5, [1, 0, 1]),
  section(7, [1].concat(name("memory"), [2, 0])), section(8, [0]),
  section(10, [1, 9, 0, 0x41, 0, 0x41, 42, 0x36, 2, 0, 0x0b]),
);
/** Imports its memory. */
const borrower = () => binary(section(2, [1].concat(name("env"), name("memory"), [2, 0, 1])));

test("the guest runs on the imports the process links later", () => {
  const module = wasm(caller());
  const early = earlyInstance({ module, startless: true });
  expect(early?.module).toBe(module);
  const call = early!.instance.exports.call as (a: number, b: number) => number;
  expect(() => call(2, 3)).toThrow("Guest import env.add was called before the process linked it");
  const seen: unknown[][] = [];
  early!.link({ env: { add(...args: number[]) { seen.push(args); return args[0]! + args[1]!; } } });
  expect(call(2, 3)).toBe(5);
  expect(seen).toEqual([[2, 3]]);
});

test("a thrown import passes through unchanged", () => {
  const early = earlyInstance({ module: wasm(caller()), startless: true })!;
  const unwind = new Error("process exit");
  early.link({ env: { add() { throw unwind; } } });
  let caught: unknown;
  try { (early.instance.exports.call as (a: number, b: number) => number)(1, 1); } catch (error) { caught = error; }
  expect(caught).toBe(unwind);
});

test("requests the entry must not instantiate keep the late path", () => {
  const module = wasm(caller());
  expect(earlyInstance({ module })).toBeUndefined();
  expect(earlyInstance({ module, startless: false })).toBeUndefined();
  expect(earlyInstance({ module, startless: true, linkPlan: {} })).toBeUndefined();
  expect(earlyInstance({ module, startless: true, memoryGroup: {} })).toBeUndefined();
  expect(earlyInstance({ module, startless: true, adapter: "preview1" })).toBeUndefined();
  expect(earlyInstance({ module: new Uint8Array(8), startless: true })).toBeUndefined();
  expect(earlyInstance({ type: "other" })).toBeUndefined();
  expect(earlyInstance(null)).toBeUndefined();
  expect(earlyInstance("start")).toBeUndefined();
});

test("a module that imports more than functions keeps the late path", () => {
  expect(earlyInstance({ module: wasm(borrower()), startless: true })).toBeUndefined();
});

test("a failed early instantiation keeps the late path", () => {
  // The start function reaches an import before anything is linked, so instantiation throws.
  expect(earlyInstance({ module: wasm(starter()), startless: true })).toBeUndefined();
});

test("only a module whose bytes the loader read, and found no start function in, is startless", async () => {
  expect(wasmHasStartFunction(caller())).toBe(false);
  expect(wasmHasStartFunction(writer())).toBe(true);
  expect(programMetadata(await prepareProgram({ kind: "single", core: caller() })).startless).toBe(true);
  const started = await prepareProgram({ kind: "single", core: writer() });
  expect(programMetadata(started).startless).toBe(false);
  // A caller's own module: its bytes were never read here, so nothing is known about it.
  expect(programMetadata(wasm(caller())).startless).toBe(false);
  // The request the launcher builds for it therefore never instantiates it early.
  expect(earlyInstance({ module: started, ...programMetadata(started) })).toBeUndefined();
});
