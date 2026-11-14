// Function.prototype.call and apply to scripted targets. On SpiderMonkey's interpreter
// tier eligible calls run as interpreter frames, so recursion through them reaches far
// past the native recursion limit; everything else keeps the native route and its
// exact semantics.
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const depth = process.env.BUN_WASM_SPIDERMONKEY_TIER === "pbl" ? 48 : 5000;
const token = { token: true };
let remaining = 0;
let caught: unknown;

function zero(): number { return remaining-- ? 1 + zero.call() : 0; }
function one(this: object): number {
  check(this === token, "call receiver");
  return remaining-- ? 1 + one.call(this) : 0;
}
function many(this: object, a: number, b: number, c: number): number {
  check(a === 1 && b === 2 && c === 3 && arguments.length === 4 && arguments[3] === 4, "call arguments");
  return remaining-- ? 1 + many.call(this, a, b, c, 4) : 0;
}
for (const [label, run] of [
  ["zero", () => zero()],
  ["one", () => one.call(token)],
  ["many", () => many.call(token, 1, 2, 3, 4)],
] as const) {
  remaining = depth;
  check(run() === depth, `${label}-argument call depth`);
}
console.log("call recursion completed");

function viaArray(this: object, a: number, b: string): number {
  check(this === token && a === 7 && b === "b" && arguments.length === 2, "apply array arguments");
  return remaining-- ? 1 + viaArray.apply(this, [a, b]) : 0;
}
function viaArguments(this: object, a: number): number {
  check(this === token && a === 7 && arguments.length === 3, "apply arguments object");
  return remaining-- ? 1 + viaArguments.apply(this, arguments) : 0;
}
remaining = depth;
check(viaArray.apply(token, [7, "b"]) === depth, "apply array depth");
remaining = depth;
check(viaArguments.apply(token, [7, 8, 9]) === depth, "apply arguments depth");
console.log("apply recursion completed");

let unwound = 0;
function thrower(this: object): number {
  try {
    if (!remaining--) throw token;
    return thrower.call(this);
  } finally { unwound++; }
}
remaining = depth;
try { thrower.call(token); caught = undefined; } catch (error) { caught = error; }
check(caught === token && unwound === depth + 1, "throw identity and finally");
console.log("call throw and finally preserved");

const sloppyThis = new Function("return this") as (this: unknown) => unknown;
function strictThis(this: unknown): unknown { return this; }
check(typeof sloppyThis.call(7) === "object" && sloppyThis.call(undefined) === globalThis, "sloppy receiver");
check(strictThis.call(7) === 7 && strictThis.call(undefined) === undefined && strictThis.call() === undefined, "strict receiver");
check(typeof sloppyThis.apply(7) === "object" && strictThis.apply(7, null) === 7, "apply receiver");
class Constructor {}
for (const run of [() => (Constructor as unknown as () => void).call(token), () => (Constructor as unknown as () => void).apply(token, [1])]) {
  try { run(); caught = undefined; } catch (error) { caught = error; }
  check(caught instanceof TypeError, "class constructor target rejected");
}
const callBuiltin = strictThis.call as unknown as new () => unknown;
const applyBuiltin = strictThis.apply as unknown as new () => unknown;
for (const run of [() => new callBuiltin(), () => new applyBuiltin(), () => Reflect.construct(callBuiltin, []), () => Reflect.construct(applyBuiltin, [])]) {
  try { run(); caught = undefined; } catch (error) { caught = error; }
  check(caught instanceof TypeError, "call and apply are not constructors");
}
console.log("receivers and constructor checks preserved");

function report(this: unknown, ...values: unknown[]): unknown[] { return [this, arguments.length].concat(values); }
const same = (actual: unknown[], expected: unknown[]) => actual.length === expected.length && actual.every((value, index) => value === expected[index]);
const invoke = (fn: typeof report) => fn.call(token, 1);
check(same(invoke(report), [token, 1, 1]), "unpatched call");
const original = Function.prototype.call;
Function.prototype.call = function patched(this: Function, ...values: unknown[]) { return ["patched", values.length]; };
check(same(invoke(report), ["patched", 2]), "patched call");
Function.prototype.call = original;
check(same(invoke(report), [token, 1, 1]), "restored call");
check(same(report.call.call(report, token, 5) as unknown[], [token, 1, 5]), "call of call");
check(same(report.apply.call(report, token, [5, 6]) as unknown[], [token, 2, 5, 6]), "call of apply");
const bound = report.bind(token, 1);
check(same(bound.call(globalThis, 2), [token, 2, 1, 2]), "bound target");
check(same(new Proxy(report, {}).call(token, 3), [token, 1, 3]), "proxy target");
check(Math.max.call(null, 1, 5, 3) === 5 && Math.max.apply(null, [1, 5, 3]) === 5, "native target");
async function asyncTarget(this: unknown, value: number): Promise<unknown[]> { await null; return [this, value]; }
check(same(await asyncTarget.call(token, 4), [token, 4]), "async target");
check(same(await asyncTarget.apply(token, [5]), [token, 5]), "async apply target");
function* generatorTarget(this: unknown, value: number): Generator<unknown> { yield this; yield value; }
check(same(Array.from(generatorTarget.call(token, 6)), [token, 6]), "generator target");
check(same(Array.from(generatorTarget.apply(token, [7])), [token, 7]), "generator apply target");
console.log("call targets preserved");

const loose = report as unknown as { apply(...values: unknown[]): unknown[] };
check(same(loose.apply(token, null, 1, 2), [token, 0]), "null list ignores extras");
check(same(loose.apply(token, undefined, 1), [token, 0]), "undefined list ignores extras");
check(same(report.apply(token), [token, 0]) && same(report.apply(), [undefined, 0]), "missing list");
check(same(report.apply(token, [1, 2, 3]), [token, 3, 1, 2, 3]), "packed array");
const holes = [1, , 3];
check(same(report.apply(token, holes), [token, 3, 1, undefined, 3]), "holes read as undefined");
Object.defineProperty(Array.prototype, 1, { configurable: true, value: "inherited" });
check(same(report.apply(token, holes), [token, 3, 1, "inherited", 3]), "holes read through the prototype");
delete (Array.prototype as unknown as Record<number, unknown>)[1];
let reads = 0;
const arrayLike = { length: 2, get 0() { reads++; return "a"; }, 1: "b" };
check(same(report.apply(token, arrayLike as unknown as unknown[]), [token, 2, "a", "b"]) && reads === 1, "array-like with getter");
const packed = (length: number) => {
  const list: number[] = [];
  for (let index = 0; index < length; index++) list.push(index);
  return list;
};
const long = report.apply(token, packed(100_000));
check(long.length === 100_002 && long[1] === 100_000 && long[100_001] === 99_999, "long packed list");
try { report.apply(token, packed(500_001)); caught = undefined; } catch (error) { caught = error; }
check(caught instanceof RangeError, "over-limit list");
try { report.apply(token, 1 as unknown as unknown[]); caught = undefined; } catch (error) { caught = error; }
check(caught instanceof TypeError, "non-object list");
const lengthRead = { get length() { reads++; return 0; } };
const notCallable = { apply: Function.prototype.apply } as unknown as { apply(thisArg: unknown, list: unknown): unknown };
reads = 0;
try { notCallable.apply(null, lengthRead); caught = undefined; } catch (error) { caught = error; }
check(caught instanceof TypeError && reads === 0, "callable check before the list is read");
console.log("apply lists preserved");

function plainArguments(this: unknown, ..._values: unknown[]): unknown[] { return report.apply(this, arguments as unknown as unknown[]); }
check(same(plainArguments.call(token, 1, 2), [token, 2, 1, 2]), "unmapped arguments");
const mapped = new Function("report", "a", "b", "a = 'changed'; return report.apply(this, arguments);");
check(same(mapped.call(token, report, 1, 2), [token, 3, report, "changed", 2]), "mapped arguments");
const forwarded = new Function("report", "a", "var read = () => a; a = 'closed'; return report.apply(this, arguments).concat(read());");
check(same(forwarded.call(token, report, 1), [token, 2, report, "closed", "closed"]), "forwarded arguments");
const resized = (length: PropertyDescriptor) => function (this: unknown, ..._values: unknown[]): unknown[] {
  Object.defineProperty(arguments, "length", length);
  return report.apply(this, arguments as unknown as unknown[]);
};
check(same(resized({ value: 1 }).call(token, 1, 2), [token, 1, 1]), "shorter arguments length");
check(same(resized({ value: 3 }).call(token, 1, 2), [token, 3, 1, 2, undefined]), "longer arguments length");
check(same(resized({ get: () => 2 }).call(token, 1, 2, 3), [token, 2, 1, 2]), "accessor arguments length");
try { resized({ get: () => { throw token; } }).call(token, 1); caught = undefined; } catch (error) { caught = error; }
check(caught === token, "throwing arguments length");
function deletedElement(this: unknown, ..._values: unknown[]): unknown[] {
  delete (arguments as unknown as Record<number, unknown>)[0];
  return report.apply(this, arguments as unknown as unknown[]);
}
check(same(deletedElement.call(token, 1, 2), [token, 2, undefined, 2]), "deleted arguments element");
console.log("arguments lists preserved");

function endlessCall(): number { return 1 + endlessCall.call(null); }
function endlessApply(): number { return 1 + endlessApply.apply(null, [1]); }
for (const endless of [endlessCall, endlessApply]) {
  try { endless(); caught = undefined; } catch (error) { caught = error; }
  check(caught instanceof RangeError, "unbounded recursion caught");
}
remaining = depth;
check(one.call(token) === depth, "evaluation after exhaustion");
console.log("call exhaustion caught and recovered");
