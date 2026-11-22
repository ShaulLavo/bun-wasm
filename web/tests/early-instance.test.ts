import { expect, test } from "bun:test";
import { earlyInstance } from "../src/early-instance";

const name = (text: string) => [text.length].concat(Array.from(text, character => character.charCodeAt(0)));
const section = (id: number, bytes: readonly number[]) => [id, bytes.length].concat(bytes);
const wasm = (...sections: number[][]) => new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(...sections)));
const BINARY = [0x60, 2, 0x7f, 0x7f, 1, 0x7f];
const NULLARY = [0x60, 0, 0];

/** Imports `env.add` and exports `call(a, b)`, which returns what the import returns. */
const caller = () => wasm(
  section(1, [1].concat(BINARY)),
  section(2, [1].concat(name("env"), name("add"), [0, 0])),
  section(3, [1, 0]),
  section(7, [1].concat(name("call"), [0, 1])),
  section(10, [1, 8, 0, 0x20, 0, 0x20, 1, 0x10, 0, 0x0b]),
);
/** Calls its `env.boot` import from a start function. */
const starter = () => wasm(section(1, [1].concat(NULLARY)), section(2, [1].concat(name("env"), name("boot"), [0, 0])), section(8, [0]));
/** Imports its memory. */
const borrower = () => wasm(section(2, [1].concat(name("env"), name("memory"), [2, 0, 1])));

test("the guest runs on the imports the process links later", () => {
  const module = caller();
  const early = earlyInstance({ module });
  expect(early?.module).toBe(module);
  const call = early!.instance.exports.call as (a: number, b: number) => number;
  expect(() => call(2, 3)).toThrow("Guest import env.add was called before the process linked it");
  const seen: unknown[][] = [];
  early!.link({ env: { add(...args: number[]) { seen.push(args); return args[0]! + args[1]!; } } });
  expect(call(2, 3)).toBe(5);
  expect(seen).toEqual([[2, 3]]);
});

test("a thrown import passes through unchanged", () => {
  const early = earlyInstance({ module: caller() })!;
  const unwind = new Error("process exit");
  early.link({ env: { add() { throw unwind; } } });
  let caught: unknown;
  try { (early.instance.exports.call as (a: number, b: number) => number)(1, 1); } catch (error) { caught = error; }
  expect(caught).toBe(unwind);
});

test("requests the entry must not instantiate keep the late path", () => {
  const module = caller();
  expect(earlyInstance({ module, linkPlan: {} })).toBeUndefined();
  expect(earlyInstance({ module, memoryGroup: {} })).toBeUndefined();
  expect(earlyInstance({ module, adapter: "preview1" })).toBeUndefined();
  expect(earlyInstance({ module: new Uint8Array(8) })).toBeUndefined();
  expect(earlyInstance({ type: "other" })).toBeUndefined();
  expect(earlyInstance(null)).toBeUndefined();
  expect(earlyInstance("start")).toBeUndefined();
});

test("a module that imports more than functions keeps the late path", () => {
  expect(earlyInstance({ module: borrower() })).toBeUndefined();
});

test("a module whose start function reaches an import keeps the late path", () => {
  expect(earlyInstance({ module: starter() })).toBeUndefined();
});
