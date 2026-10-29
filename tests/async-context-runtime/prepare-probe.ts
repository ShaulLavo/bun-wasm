/* oxlint-disable no-eval -- These fixtures exercise lexical direct-eval preparation. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";
import Module from "node:module";
import { evaluate } from "./eval-callsite.mjs";

const storage = new AsyncLocalStorage<string>();
const second = new AsyncLocalStorage<string>();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
const observations: string[] = [];
const note = (phase: string) => observations.push(`${phase}:${storage.getStore()}:${second.getStore()}`);
const body = 'note("before"); await Promise.resolve(); note("after"); await new Promise(r => setTimeout(r, 0)); note("timer"); try { await Promise.reject(false); } catch (e) { if (e !== false) throw Error("identity"); note("catch"); } finally { note("finally"); }';
const callable = [
  AsyncFunction("note", body),
  new AsyncFunction("note", body),
  Reflect.construct(AsyncFunction, ["note", body]),
  (async function () {}).constructor("note", body),
  eval(`(async function(note) { ${body} })`),
  vm.runInThisContext(`(async function(note) { ${body} })`),
  vm.runInNewContext(`(async function(note) { ${body} })`, { Promise, setTimeout }),
  vm.compileFunction(`return async function(note) { ${body} }`)(),
];
const module = new Module("prepare-compiled");
module._compile(`module.exports = async function(note) { ${body} }`, "prepare-compiled.js");
callable.push(module.exports);

for (const [index, fn] of callable.entries()) {
  const execute = (name: string) => storage.run(name, () => fn(() => note(`${index}:${name}`)));
  await Promise.all([execute("A"), execute("B")]);
  const rows = observations.splice(0);
  assert.equal(rows.length, 10);
  assert.ok(rows.every(row => row === `${index}:A:A:undefined` || row === `${index}:B:B:undefined`), JSON.stringify(rows));
}

const generator = AsyncGeneratorFunction("note", `${body}; yield 7;`);
await Promise.all(["A", "B"].map(name => storage.run(name, async () => {
  const values = [];
  for await (const value of generator(() => assert.equal(storage.getStore(), name))) values.push(value);
  assert.deepEqual(values, [7]);
})));

function lexicalEval() {
  const local = 7;
  assert.equal(local, 7);
  assert.equal(eval("local + 1"), 8);
  assert.equal((eval)("local"), 7);
  assert.equal(eval(19), 19);
  assert.equal(eval('"use strict"; typeof local'), "number");
}
lexicalEval();
const varLeak = Function('eval("var answer = 11"); return answer;');
assert.equal(varLeak(), 11);
const shadow = Function("eval", 'return eval("await unchanged");');
assert.equal(shadow((value: string) => value), "await unchanged");
class Generated extends Function {}
assert.equal(new Generated("return 13")(), 13);
assert.equal(Function.prototype.constructor, Function);
assert.equal(AsyncFunction.prototype.constructor, AsyncFunction);

let constructorReads = 0;
let thenReads = 0;
const protocol = AsyncFunction("promise", "thenable", 'try { await promise; await thenable; } catch (e) { return e; }');
const promise = Promise.resolve();
Object.defineProperty(promise, "constructor", { get() { constructorReads++; return Promise; } });
const thenable = { get then() { thenReads++; return (resolve: (value: number) => void) => resolve(1); } };
await protocol(promise, thenable);
assert.equal(constructorReads, 1);
assert.equal(thenReads, 1);
for (const value of [undefined, null, false, 0, "", NaN]) {
  const rejected = AsyncFunction("value", 'try { await Promise.reject(value); } catch (caught) { return Object.is(caught, value); }');
  assert.equal(await rejected(value), true);
}

const badIterator = AsyncFunction("storage", `try { for await (const x of { [Symbol.asyncIterator]() { storage.enterWith("changed"); throw false; } }) {} } catch (error) { if (error !== false) throw error; return storage.getStore(); }`);
assert.equal(await storage.run("initial", () => badIterator(storage)), "changed");

const nested = AsyncFunction("storage", 'return eval("(async () => { await 0; return storage.getStore(); })")();');
assert.equal(await storage.run("nested", () => nested(storage)), "nested");
const reused = AsyncFunction("storage", 'await 0; return storage.getStore();');
assert.deepEqual(await Promise.all([storage.run("reuse-A", () => reused(storage)), storage.run("reuse-B", () => reused(storage))]), ["reuse-A", "reuse-B"]);
const shared = AsyncFunction("storage", "second", 'await 0; return [storage.getStore(), second.getStore()];');
assert.deepEqual(await Promise.all([
  second.run("secret", () => storage.run("isolated-A", () => shared(storage, second))),
  storage.run("isolated-B", () => shared(storage, second)),
]), [["isolated-A", "secret"], ["isolated-B", undefined]]);
assert.deepEqual(await Promise.all(["file-eval-A", "file-eval-B"].map(name => storage.run(name, () =>
  evaluate('(async () => { await 0; return storage.getStore(); })()', storage)))), ["file-eval-A", "file-eval-B"]);
console.log("PREPARE_OK");
