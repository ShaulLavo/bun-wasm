import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = eval(readFileSync("runtime.js", "utf8"));
const catalog = JSON.parse(readFileSync("catalog.json", "utf8"));
const testNames = ["retry", "cycle", "intrinsics", "unknown-intrinsic", "stub"];
const base = catalog.modules.length;
const names = catalog.modules.map(module => module.name).concat(testNames.map(name => `internal:test-${name}`));
const freelist = names.indexOf("internal:freelist");
const counts = new Map();
const factories = new Map([[freelist, eval(readFileSync(`${freelist}.js`, "utf8"))]]);
const bridged = {};
const native = {
  bunBuiltinNames: () => names,
  loadBunBuiltin(id) {
    counts.set(id, (counts.get(id) || 0) + 1);
    return factories.get(id);
  },
  bunBuiltinHookName: id => id === 124 ? "createTestBinding" : `js2native_wrap_test_hook_${id}`,
  bunBuiltinErrorCode: () => "ERR_INVALID_URI",
  isPromise: value => value instanceof Promise,
  isProxy: () => false,
  isError: value => value instanceof Error,
};
const runtime = adapter({ native, builtin: () => bridged });
assert.equal(counts.size, 0);
const FreeList = runtime.require(freelist);
const list = new FreeList("test", 1, class { constructor(value) { this.value = value; } });
const item = list.alloc(42);
assert.equal(item.value, 42);
assert.equal(list.free(item), true);
assert.equal(list.free({}), false);
assert.equal(list.alloc(), item);
assert.equal(runtime.require("internal:freelist"), FreeList);
assert.equal(counts.get(freelist), 1);
assert.equal(runtime.require("node:assert"), bridged);
assert.throws(() => runtime.require(-1), { code: "ERR_BUN_BUILTIN_UNSUPPORTED" });

let retries = 0;
factories.set(base, () => {
  if (++retries === 1) throw new Error("retry me");
  return "retried";
});
assert.throws(() => runtime.require(base), /retry me/);
assert.equal(runtime.require(base), "retried");
factories.set(base + 1, i => i.createInternalModuleById(base + 1));
assert.throws(() => runtime.require(base + 1), /circular initialization/);
factories.set(base + 1, () => 0);
assert.equal(runtime.require(base + 1), 0);
assert.equal(runtime.require(base + 1), 0);
assert.equal(counts.get(base + 1), 2);

factories.set(base + 2, i => {
  const fn = function (left, right) { return this.value + left + right; };
  fn.call = fn.apply = fn.bind = () => { throw new Error("poisoned"); };
  assert.equal(i.uncurry(fn, "call")({ value: 1 }, 2, 3), 6);
  assert.equal(i.uncurry(fn, "apply")({ value: 1 }, [2, 3]), 6);
  const noArgs = function () { return this.value; };
  assert.equal(i.uncurry(noArgs, "apply")({ value: 9 }), 9);
  assert.equal(i.uncurry(noArgs, "apply")({ value: 9 }, null), 9);
  assert.equal(i.uncurry(fn, "bind")({ value: 1 }, 2)(3), 6);
  const object = Object.create({ set value(_) { throw new Error("setter invoked"); } });
  i.putByIdDirect(object, "value", 42);
  assert.equal(object.value, 42);
  i.putByIdDirectPrivate(object, "secret", 17);
  assert.equal(i.getByIdDirectPrivate(object, "secret"), 17);
  assert.equal(object[i.privateName("secret")], 17);
  assert.equal(Object.keys(object).join(","), "value");
  assert.equal(i.isCallable(fn), true);
  assert.equal(i.isPromise(Promise.resolve()), true);
  assert.equal(i.Buffer, Buffer);
  assert.equal(i.makeErrorWithCode(0).code, "ERR_INVALID_URI");
  assert.throws(() => i.lazy(124), /native hook 124 \(createTestBinding\)/);
  return "intrinsics passed";
});
assert.equal(runtime.require(base + 2), "intrinsics passed");
factories.set(base + 3, i => i.notImplemented);
assert.throws(() => runtime.require(base + 3), /intrinsic \$notImplemented/);
factories.set(base + 4, i => i.lazy(123));
const stub = runtime.require(base + 4);
assert.throws(() => stub(), /native hook 123 \(js2native_wrap_test_hook_123\)/);
const second = adapter({ native, builtin: () => bridged });
assert.notEqual(second.require(freelist), FreeList);
assert.equal(globalThis.__intrinsic__Array, undefined);
assert.equal(Function.prototype.__intrinsic__call, undefined);
console.log("Bun generated builtin loader passed");
