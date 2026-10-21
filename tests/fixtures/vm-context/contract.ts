import assert from "node:assert/strict";

export function verifyVMContexts(vm: object, outer: object) {
  assert.ok("runInNewContext" in vm && typeof vm.runInNewContext === "function");
  assert.ok("runInContext" in vm && typeof vm.runInContext === "function");
  assert.ok("runInThisContext" in vm && typeof vm.runInThisContext === "function");
  assert.ok("createContext" in vm && typeof vm.createContext === "function");
  assert.ok("Script" in vm && typeof vm.Script === "function");
  const runInNewContext = vm.runInNewContext;
  const marker = "__bunwasm_vm_context_marker__";
  assert.equal(marker in outer, false);
  const first: Record<string, unknown> = { value: 6 };
  const second: Record<string, unknown> = { value: 20 };
  assert.equal(vm.runInNewContext("this === globalThis", first), true);
  assert.equal(vm.runInNewContext('"use strict"; this === globalThis', first), true);
  assert.equal(vm.runInNewContext(`globalThis.${marker} = value + 1`, first), 7);
  assert.equal(first[marker], 7);
  assert.equal(vm.runInNewContext(`this.${marker} += 1`, first), 8);
  assert.equal(first[marker], 8);
  assert.equal(vm.runInNewContext(`globalThis.${marker} = value + 1`, second), 21);
  assert.equal(second[marker], 21);
  assert.equal(first[marker], 8);
  assert.equal(marker in outer, false);
  assert.equal(vm.runInNewContext("globalThis", first), vm.runInNewContext("globalThis", first));
  assert.notEqual(vm.runInNewContext("globalThis", first), vm.runInNewContext("globalThis", second));
  assert.equal(Object.hasOwn(first, "globalThis"), false);
  assert.equal(vm.runInNewContext("globalThis.Math.max(value, 9)", first), 9);
  assert.equal(vm.runInNewContext("this.value === value", first), true);
  assert.equal(vm.runInNewContext("Object.keys(this).sort().join(',')", first), Object.keys(first).sort().join(","));
  assert.equal(vm.runInNewContext(`delete globalThis.${marker}`, second), true);
  assert.equal(marker in second, false);
  const supplied: Record<string, unknown> = {};
  const custom = { globalThis: supplied, value: 5 };
  assert.equal(vm.runInNewContext("this === globalThis", custom), false);
  assert.equal(vm.runInNewContext("globalThis.value = value + 4", custom), 9);
  assert.equal(supplied.value, 9);
  assert.equal(custom.value, 5);
  assert.equal(custom.globalThis, supplied);
  assert.equal(vm.runInNewContext("this.value += 1", custom), 6);
  assert.equal(custom.value, 6);
  assert.equal(vm.runInNewContext("globalThis", { globalThis: undefined }), undefined);
  let assigned = 0;
  const accessor = {
    get receiver() { return this === accessor; },
    set assigned(value: number) { assert.equal(this, accessor); assigned = value; },
  };
  assert.equal(vm.runInNewContext("receiver && this.receiver && globalThis.receiver", accessor), true);
  assert.equal(vm.runInNewContext("this.assigned = 12", accessor), 12);
  assert.equal(assigned, 12);
  assert.equal(vm.runInNewContext("globalThis.assigned = 14", accessor), 14);
  assert.equal(assigned, 14);
  const context: unknown = vm.createContext(first);
  assert.equal(context, first);
  assert.equal(vm.runInContext("this === globalThis", context), true);
  assert.equal(vm.runInContext(`globalThis.${marker} += 1`, context), 9);
  assert.equal(first[marker], 9);
  const script: unknown = Reflect.construct(vm.Script, [`globalThis.${marker} = (this.${marker} || 0) + 1`]);
  assert.ok(script && typeof script === "object");
  assert.ok("runInNewContext" in script && typeof script.runInNewContext === "function");
  assert.ok("runInContext" in script && typeof script.runInContext === "function");
  assert.ok("runInThisContext" in script && typeof script.runInThisContext === "function");
  assert.equal(script.runInContext(context), 10);
  assert.equal(script.runInNewContext(second), 1);
  assert.equal(script.runInNewContext(), 1);
  assert.equal(script.runInNewContext(), 1);
  const sentinel = new Error("context sentinel");
  assert.throws(() => runInNewContext("throw globalThis.error", { error: sentinel }), error => error === sentinel);
  assert.equal(first[marker], 10);
  assert.equal(second[marker], 1);
  assert.equal(vm.runInNewContext("40 + 2"), 42);
  assert.equal(vm.runInNewContext("void 0", first), undefined);
  assert.throws(() => runInNewContext("throw new Error('VM contract error')", first), /VM contract error/);
  assert.throws(() => runInNewContext("const =", first), /SyntaxError|Unexpected|Expected/);
  assert.equal(marker in outer, false);
  try {
    assert.equal(vm.runInThisContext(`globalThis.${marker} = 17`), 17);
    assert.equal(Reflect.get(outer, marker), 17);
    assert.equal(script.runInThisContext(), 18);
    assert.equal(Reflect.get(outer, marker), 18);
    assert.equal(first[marker], 10);
  } finally { Reflect.deleteProperty(outer, marker); }
  assert.equal(marker in outer, false);
}
