function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const depth = process.env.BUN_WASM_SPIDERMONKEY_TIER === "pbl" ? 48 : 4096;
let remaining = depth;
const own = { get value(): number { return remaining-- ? 1 + own.value : 0; } };
check(own.value === depth, "own getter depth");
console.log("own getter completed");

const prototype = { get value(): number { return this.left-- ? 1 + this.value : 0; }, left: 0 };
const inherited = Object.create(prototype);
inherited.left = depth;
check(inherited.value === depth, "prototype getter receiver");
console.log("prototype getter completed");

class Static {
  static left = depth;
  static get value(): number { return this.left-- ? 1 + this.value : 0; }
}
check(Static.value === depth, "static getter");
console.log("static getter completed");

class Base {
  left = depth / 2;
  get value(): number { return this.left-- ? 1 + this.value : -1; }
}
class Derived extends Base {
  override get value(): number { return 1 + super.value; }
}
check(new Derived().value === depth, "super getter receiver");
console.log("super getter completed");

const token = {};
let unwound = 0;
remaining = depth;
const throwing = {
  get value(): number {
    try {
      if (!remaining--) throw token;
      return throwing.value;
    } finally { unwound++; }
  },
};
let caught: unknown;
try { throwing.value; } catch (error) { caught = error; }
check(caught === token && unwound === depth + 1, "throw identity and finally");
console.log("getter throw and finally preserved");

check(({ marker: token, get value() { return this.marker; } }).value === token, "temporary receiver");
Object.defineProperty(Number.prototype, "getterReceiver", { configurable: true, get: function () { "use strict"; return this; } });
check(Reflect.get(Number.prototype, "getterReceiver", 7) === 7, "primitive reference control");
check((7 as number & { getterReceiver: number }).getterReceiver === 7, "primitive receiver");
delete (Number.prototype as Number & { getterReceiver?: number }).getterReceiver;
const parameters = new Function("a", "b", "return [a, b, arguments.length, this.marker]");
const object: { marker: object; value?: unknown[]; bad?: unknown } = { marker: token };
Object.defineProperty(object, "value", { get: parameters });
const args = object.value;
check(args, "getter arguments result");
check(args[0] === undefined && args[1] === undefined && args[2] === 0 && args[3] === token, "padded getter parameters");
console.log("receivers and arguments preserved");

let reads = 0;
const redefining = { get value() { reads++; Object.defineProperty(this, "value", { value: 42 }); return 17; } };
check(redefining.value === 17 && redefining.value === 42 && reads === 1, "getter redefinition");
const generator = { marker: token, value: undefined as unknown };
Object.defineProperty(generator, "value", { get: function* () { yield this.marker; } });
check((generator.value as Generator).next().value === token, "generator getter");
const asyncObject = { marker: token, value: undefined as unknown };
Object.defineProperty(asyncObject, "value", { get: async function () { return this.marker; } });
check(await asyncObject.value === token, "async getter");
Object.defineProperty(object, "bad", { get: class {} });
try { object.bad; caught = undefined; } catch (error) { caught = error; }
check(caught instanceof TypeError, "class getter rejected");
console.log("special getters preserved");

let traps = 0;
const target = { get value() { return this.marker; }, marker: null };
const proxy = new Proxy(target, { get(target, key, receiver) { traps++; return Reflect.get(target, key, receiver); } });
const throughProxy = Object.assign(Object.create(proxy), { marker: token });
check(throughProxy.value === token && traps === 1, "proxy prototype dispatch");
console.log("proxy prototype preserved");

const endless = { get value(): number { return 1 + endless.value; } };
try { endless.value; caught = undefined; } catch (error) { caught = error; }
check(caught instanceof RangeError, "unbounded getter caught");
remaining = depth;
check(own.value === depth, "evaluation after exhaustion");
console.log("getter exhaustion caught and recovered");
