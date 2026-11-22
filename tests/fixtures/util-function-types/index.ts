import { types } from "node:util";

// Source text that only looks like a native function's placeholder.
const looksNative = [
  Function("return async function f(){ // [native code]\n}")(),
  Function("return function* g(){ // [native code]\n}")(),
  Function("return async function* h(){ /* [native code] } */ }")(),
];

const functions: [string, unknown][] = [
  ["async", async function asyncFn() {}],
  ["async generator", async function* asyncGeneratorFn() {}],
  ["async arrow", async () => 1],
  ["async method", { async m() {} }.m],
  ["normal", function normal() {}],
  ["generator", function* generatorFn() {}],
  ["bound", function bound() {}.bind(undefined)],
  ["bound async", (async function asyncBound() {}).bind(undefined)],
  ["bound generator", function* boundGenerator() {}.bind(undefined)],
  ["bound async generator", async function* boundAsyncGenerator() {}.bind(undefined)],
  ["builtin", Promise.resolve],
  ["async with a comment", looksNative[0]],
  ["generator with a comment", looksNative[1]],
  ["async generator with a comment", looksNative[2]],
  ["not a function", {}],
];
for (const [name, value] of functions) {
  console.log(name, "async:", types.isAsyncFunction(value), "generator:", types.isGeneratorFunction(value));
}
