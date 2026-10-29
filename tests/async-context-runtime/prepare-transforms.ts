/* oxlint-disable no-eval -- These fixtures exercise lexical direct-eval preparation. */
import assert from "node:assert/strict";
const testing = require("bun:internal-for-testing");
const preparation = testing.preparation();
const prepare = (source: string, goal = "script", name?: string): string => testing.prepareSource(source, goal, "transform-test", name);
if (!("__bunwasm_capture" in globalThis)) throw new Error("requires the browser hooks guest");

const cases = [
  'async function f(x) { return await x; }',
  'async function f(x) { return g(await x); }',
  'async function f(x) { if (await x) return 1; }',
  'async function f(x) { return `value:${await x}`; }',
  'function f(x = async () => await 1) { return x; }',
  'class C { f = async () => await 1; }',
  'async function f(x) { return await await x; }',
  'async function f(a, b) { return await (a, b); }',
  'async function f(x) { return (await x).y; }',
  'async function f(x) { return await x.y(); }',
  'async function f(x) { y\nawait x; }',
  'async function f(x) { return await x\n(y); }',
  'async function f(x) { return await x /*comment*/; }',
  'async function f(x) { "use strict"; try { return await x; } finally {} }',
  'async function f(x) { function nested() { try {} finally {} } return await x; }',
  'async function f(x) { class C { static { try {} finally {} } } return await x; }',
  'async function f(x) { try { return await x; } catch { return 1; } }',
  'async function f(x) { try { return await x; } catch ({message = "x"}) { return message; } }',
  'async function f(xs) { a: b: for await (const x of xs) { if (x) continue b; } }',
  'async function f(xs) { for await (const x of await xs) for await (const y of x) void y; }',
  'async function* f(x) { try { yield x; yield* x; yield; } finally { await 0; } }',
  'function f(x) { return eval(x); }',
  'function f(x) { return (eval)(x); }',
  'function f(x) { return (0, eval)(x); }',
  'async function f(x) { const s = "é😀\ud800"; try { return await x; } finally {} }',
];
cases.push('; async function emptyPrefix(x) { ; try { return await x; } finally {} }');
for (const source of cases) {
  const result = prepare(source);
  assert.notEqual(result, source, source);
  assert.equal(result.split("\n").length, source.split("\n").length, source);
  assert.equal(prepare(result), result, source);
  Function(result);
}
const plain = prepare(cases[14]);
assert.ok(!plain.includes("let __bunwasm_s"), plain);
const staticBlock = prepare(cases[15]);
assert.ok(!staticBlock.includes("let __bunwasm_s"), staticBlock);
const directive = prepare(cases[13]);
assert.ok(directive.indexOf('"use strict"') < directive.indexOf("let __bunwasm_s"), directive);
assert.equal(prepare('eval?.("x")'), 'eval?.("x")');
assert.equal(prepare('eval(...xs)'), 'eval(...xs)');
assert.equal(prepare('function invalid() { await @; }'), 'function invalid() { await @; }');
assert.equal(prepare('"no work"'), '"no work"');
assert.equal(prepare('new.target; super.x', "eval"), 'new.target; super.x');
assert.ok(prepare('(function () { return async () => await 0; })', "wrapper").includes("__bunwasm_resume"));
const mapped = 'async function mapped() { await 0; throw new Error("mapped"); }\n//# sourceURL=prepare-map.js';
const hooked = prepare(mapped);
const originalColumn = mapped.indexOf('new Error') + 1;
const transformedColumn = hooked.indexOf('new Error') + 1;
assert.equal(preparation.correctPosition("prepare-map.js", 1, transformedColumn), originalColumn);
prepare('"updated without awaits"', "script", "prepare-map.js");
assert.equal(preparation.correctPosition("prepare-map.js", 1, transformedColumn), transformedColumn);
const before = preparation.counters.cacheHits;
prepare(cases[0]);
assert.ok(preparation.counters.cacheHits > before);
assert.ok(preparation.counters.spreadEval > 0);
assert.ok(preparation.counters.fallbacks > 0);
assert.ok(preparation.cacheBytes() <= 16 * 1024 * 1024);
assert.ok(preparation.columnBytes() <= 16 * 1024 * 1024);
const mappedCall = 'async function mappedCall() { await 0; throw new Error("mapped"); } mappedCall();\n//# sourceURL=prepare-stack.js';
try {
  await eval(prepare(mappedCall));
  assert.fail("expected mapped rejection");
} catch (error) {
  assert.ok(error instanceof Error);
  assert.ok(error.stack?.includes(`prepare-stack.js:1:${mappedCall.indexOf('new Error') + 1}`), error.stack);
}
console.log("PREPARE_TRANSFORMS_OK");
