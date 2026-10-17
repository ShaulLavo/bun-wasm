import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const module = new WebAssembly.Module(readFileSync("./module.wasm"));
const e = new WebAssembly.Instance(module).exports as any;
assert(e.table instanceof WebAssembly.Table);
assert.equal(WebAssembly.Table.length, 1);
assert.equal(WebAssembly.Table.prototype.grow.length, 1);
assert.equal(Object.prototype.toString.call(e.table), "[object WebAssembly.Table]");
assert.equal(e.table, e.alias);
assert.equal(e.table.length, 2);
assert.equal(e.table.get(0), e.add);
assert.equal(e.table.get(1), null);
assert.equal(e.table.get(0)(4), 5);
e.table.set(1, e.add);
assert.equal(e.invoke(1, 10), 11);
assert.equal(e.table.grow(1, e.add), 2);
assert.equal(e.table.get(2), e.add);
assert.equal(e.table.grow(0), 3);
assert.throws(() => e.table.grow(3), RangeError);
assert.throws(() => e.table.get(3), RangeError);
assert.throws(() => e.table.set(3, null), RangeError);
assert.throws(() => e.table.set(0, () => 1), TypeError);
for (const index of [-1, NaN, undefined, Infinity, 2 ** 32, 1n, Symbol()]) {
  assert.throws(() => e.table.get(index), TypeError);
  assert.throws(() => e.table.grow(index), TypeError);
}
assert.equal(e.table.get("1"), e.add);
assert.throws(() => WebAssembly.Table.prototype.get.call({}, 0), TypeError);
assert.throws(() => e.table.set(0, undefined), TypeError);
assert.throws(() => e.table.grow(0, undefined), TypeError);
assert.throws(() => new WebAssembly.Table({ element: "invalid", initial: 0 }), TypeError);
assert.throws(() => new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 1 }), RangeError);
const imported = new WebAssembly.Instance(new WebAssembly.Module(readFileSync("./import.wasm")), { env: { table: e.table } }).exports as any;
assert.equal(imported.table, e.table);
assert.equal(imported.invoke(0, 8), 9);
imported.table.set(0, null);
assert.equal(e.table.get(0), null);
assert.throws(() => e.invoke(0, 1), WebAssembly.RuntimeError);
const standalone = new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 5 });
standalone.set(0, e.add);
const cross = new WebAssembly.Instance(new WebAssembly.Module(readFileSync("./import.wasm")), { env: { table: standalone } }).exports as any;
assert.equal(cross.table, standalone);
assert.equal(cross.invoke(0, 11), 12);
const value = { nested: true };
const refs = new WebAssembly.Table({ element: "externref", initial: 2, maximum: 4 }, value);
assert.equal(refs.get(0), value);
refs.set(0, undefined);
assert.equal(refs.get(0), undefined);
refs.set(1, "hello");
assert.equal(refs.grow(1, value), 2);
assert.equal(refs.get(2), value);
const linkedRefs = new WebAssembly.Instance(new WebAssembly.Module(readFileSync("./references.wasm")), { env: { refs } }).exports as any;
assert.equal(linkedRefs.refs, refs);
assert.equal(linkedRefs.get(2), value);
linkedRefs.set(1, value);
assert.equal(refs.get(1), value);
assert.equal(linkedRefs.grow(undefined, 1), 3);
assert.equal(refs.get(3), undefined);
let rejectCallback = false;
const sentinel = new Error("callback failed");
const callbackExports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync("./callbacks.wasm")), { env: {
  callback(value: number) { if (rejectCallback) throw sentinel; return value + 3; },
} }).exports as any;
assert.equal(callbackExports.table.get(0), callbackExports.callback);
assert.equal(callbackExports.table.get(1)(9), 18);
assert.equal(callbackExports.callback(5), 8);
assert.equal(callbackExports.table.get(0)(6), 9);
assert.equal(callbackExports.invoke(7), 10);
standalone.set(0, callbackExports.callback);
assert.equal(cross.invoke(0, 8), 11);
rejectCallback = true;
for (const invoke of [() => callbackExports.callback(1), () => callbackExports.invoke(1), () => cross.invoke(0, 1)]) {
  assert.throws(invoke, error => error === sentinel);
}
const tablePrototype = Object.getPrototypeOf(standalone);
Object.setPrototypeOf(standalone, null);
const branded = new WebAssembly.Instance(new WebAssembly.Module(readFileSync("./import.wasm")), { env: { table: standalone } }).exports as any;
assert.equal(branded.table, standalone);
Object.setPrototypeOf(standalone, tablePrototype);
assert.throws(() => new WebAssembly.Instance(new WebAssembly.Module(readFileSync("./import.wasm")), { env: {
  table: Object.create(WebAssembly.Table.prototype),
} }), WebAssembly.LinkError);
const first = new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 5 });
const second = new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 5 });
let reads = 0;
const duplicate = new WebAssembly.Instance(new WebAssembly.Module(readFileSync("./duplicate.wasm")), { env: {
  get table() { return reads++ === 0 ? first : second; },
} }).exports as any;
assert.equal(duplicate.first, first);
assert.equal(duplicate.second, second);
assert.equal(reads, 2);
console.log("table exports, imports, identity, indirect calls, growth and externref pass");
