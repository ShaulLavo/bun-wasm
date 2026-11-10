function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, received ${actual}`);
}
const receiver = { base: 10 };
function sum(this: typeof receiver, a: number, b: number): number { return this.base + a + b; }
equal(sum.call(receiver, 2, 3), 15);
equal(sum.apply(receiver, [2, 3]), 15);
equal(Reflect.apply(sum, receiver, [2, 3]), 15);
equal(sum.bind(receiver, 2)(3), 15);
equal(Math.max.apply(undefined, [2, 3]), 3);
const proxy = new Proxy(sum, {
  apply(target, thisArg, args) { return Reflect.apply(target, thisArg, args) + 1; },
});
equal(proxy.call(receiver, 2, 3), 16);
equal(proxy.apply(receiver, [2, 3]), 16);
class Box { constructor(public value: number) {} }
const Bound = Box.bind(undefined, 17);
equal(new Bound().value, 17);
const ProxyBox = new Proxy(Box, { construct(target, args, newTarget) { return Reflect.construct(target, args, newTarget); } });
equal(new ProxyBox(19).value, 19);
equal([1, 2].map(value => sum.call(receiver, value, 1)).join(","), "12,13");
const sentinel = new Error("native reentry sentinel");
let observed: unknown;
try { Reflect.apply(sum, receiver, { get length() { throw sentinel; } }); } catch (error) { observed = error; }
equal(observed, sentinel);
try { Reflect.apply(proxy, receiver, [2, 3]); } catch { throw new Error("exception leaked into next native call"); }
function* values(): Generator<number, number, number> { const value = yield 5; return value + 1; }
const iterator = values();
equal(iterator.next().value, 5);
equal(iterator.next(7).value, 8);
equal(iterator.next().done, true);
console.log("native callable semantics preserved");
