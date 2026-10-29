import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage<string>();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const dynamic = AsyncFunction("storage", 'const trace = []; outer: for await (const _i of [1,2]) { for await (const _x of [1]) { trace.push(storage.getStore()); continue outer; } } return trace;');
async function printed() {
  const trace = [];
  outer: for await (const _i of [1, 2]) {
    for await (const _x of [1]) {
      trace.push(storage.getStore());
      continue outer;
    }
  }
  return trace;
}
const dynamicRows = await storage.run("loop", () => dynamic(storage));
const printedRows = await storage.run("loop", () => printed());
console.log(JSON.stringify({ dynamicRows, printedRows }));
assert.deepEqual(dynamicRows, ["loop", "loop"]);
assert.deepEqual(printedRows, ["loop", "loop"]);
