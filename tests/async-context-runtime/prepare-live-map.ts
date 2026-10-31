import assert from "node:assert/strict";
const testing = require("bun:internal-for-testing");
const preparation = testing.preparation();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function identity(fn: Function): string {
  const urls = Array.from(fn.toString().matchAll(/\/\/# sourceURL=([^\r\n]+)/g), match => match[1]);
  const value = urls.at(-1);
  assert.ok(value);
  return value;
}
const firstBody = 'await 0; throw new Error("first");';
const first = AsyncFunction(firstBody + '\n//# sourceURL=live-shared.js');
const firstID = identity(first);
const transformed = first.toString().split("\n")[2].indexOf("new Error") + 1;
const original = firstBody.indexOf("new Error") + 1;
const corrected = () => preparation.correctPosition(firstID, 3, transformed);
async function frame(): Promise<string> {
  try { await first(); assert.fail("expected first rejection"); } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "first");
    const value = error.stack?.split("\n").find(line => line.includes("live-shared.js") || line.includes("anonymous@"));
    assert.ok(value, error.stack);
    return value;
  }
}
assert.equal(corrected(), original);
const before = await frame();
const second = AsyncFunction('await 0; await 0; await 0; throw new Error("second");\n//# sourceURL=live-shared.js');
assert.notEqual(identity(second), firstID);
assert.ok(first.toString().includes('//# sourceURL=live-shared.js'));
assert.equal(corrected(), original);
assert.equal(await frame(), before);
const plain = AsyncFunction('throw new Error("plain");\n//# sourceURL=live-shared.js');
assert.notEqual(identity(plain), firstID);
assert.equal(corrected(), original);
assert.equal(await frame(), before);
for (let index = 0; index < 40; index++) {
  testing.prepareSource(`async function hmr() { await ${index}; await 0; }`, "eval", "live-map", "live-shared.js");
}
assert.equal(corrected(), original);
assert.equal(await frame(), before);
assert.ok(preparation.cacheBytes() <= 16 * 1024 * 1024);
console.log("PREPARE_LIVE_MAP_OK");
