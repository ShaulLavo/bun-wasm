// Runs in its own worker thread so installing the guest constructor stays out of the test thread.
// Every probe runs once on the native constructor, once on the installed one, and reports a trace.
import { parentPort } from "node:worker_threads";
import { installSharedBufferRealm } from "../../../web/src/shared-objects/realm";

if (!parentPort) throw new Error("Missing native parent port");
const Native = SharedArrayBuffer;
const claims: number[] = [];
const stock = new Map<number, SharedArrayBuffer>([[4, new Native(4)], [8, new Native(8)]]);

type Probe = (Constructor: typeof SharedArrayBuffer, trace: string[]) => unknown;
function outcome(probe: Probe, Constructor: typeof SharedArrayBuffer) {
  const trace: string[] = [];
  try {
    const value = probe(Constructor, trace);
    return { trace, value: value instanceof Native ? { byteLength: value.byteLength, growable: value.growable, maxByteLength: value.maxByteLength, proto: Object.getPrototypeOf(value) === Native.prototype, fixed: value.growable === false } : value };
  } catch (error) { return { trace, error: (error as Error).constructor.name }; }
}
const order: Probe = (C, trace) => {
  const length = { valueOf() { trace.push("length"); return 4; } };
  const options = new Proxy({}, { get(_target, key) { trace.push(`options.${String(key)}`); return undefined; } });
  const target = function () {}.bind(null);
  Object.defineProperty(target, "prototype", { get() { trace.push("prototype"); return Native.prototype; } });
  return Reflect.construct(C, [length, options], target);
};
const orderGrowable: Probe = (C, trace) => {
  const length = { valueOf() { trace.push("length"); return 4; } };
  const options = { get maxByteLength() { trace.push("max"); return { valueOf() { trace.push("maxValue"); return 8; } }; } };
  return new C(length as unknown as number, options as unknown as { maxByteLength: number });
};
const probes: Record<string, Probe> = {
  plain: C => new C(4),
  undefinedLength: C => new C(undefined as unknown as number),
  nullLength: C => new C(null as unknown as number),
  float: C => new C(4.9),
  string: C => new C("8" as unknown as number),
  objectLength: C => new C({ valueOf: () => 4 } as unknown as number),
  optionsNull: C => new C(4, null as unknown as undefined),
  optionsEmpty: C => new C(4, {}),
  optionsUndefinedMax: C => new C(4, { maxByteLength: undefined } as unknown as { maxByteLength: number }),
  negative: C => new C(-1),
  huge: C => new C(2 ** 53),
  bigint: C => new C(1n as unknown as number),
  symbol: C => new C(Symbol() as unknown as number),
  maxBelowLength: C => new C(8, { maxByteLength: 4 }),
  negativeMax: C => new C(4, { maxByteLength: -1 }),
  noNew: C => (C as unknown as (length: number) => unknown)(4),
  order, orderGrowable,
  nullPrototypeTarget: C => {
    function Target() {}
    Target.prototype = null as unknown as object;
    return Object.getPrototypeOf(Reflect.construct(C, [4], Target)) === Native.prototype;
  },
  subclass: C => { class Sub extends C {} const value = new Sub(8); return value instanceof Sub && value instanceof C && value.byteLength === 8; },
  slice: C => new C(8).slice(0, 4).byteLength,
  reflectLength: C => (Reflect.construct(C, [8]) as SharedArrayBuffer).byteLength,
  growable: C => { const value = new C(4, { maxByteLength: 16 }); value.grow(8); return [value.byteLength, value.growable, value.maxByteLength]; },
  growFixed: C => { const value = new C(4); (value as unknown as { grow(n: number): void }).grow(8); return value.byteLength; },
  instanceOf: C => new C(4) instanceof C,
  tag: C => Object.prototype.toString.call(new C(4)),
  constructorIdentity: C => new C(4).constructor === C,
  prototypeIdentity: C => C.prototype === Native.prototype,
  growableGetterNative: () => Object.getOwnPropertyDescriptor(Native.prototype, "growable")!.get === nativeGrowable,
};
const nativeGrowable = Object.getOwnPropertyDescriptor(Native.prototype, "growable")!.get!;
const native = Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, outcome(probe, Native)]));
installSharedBufferRealm(byteLength => {
  claims.push(byteLength);
  const value = stock.get(byteLength);
  stock.delete(byteLength);
  return value ?? null;
});
const Wrapper = globalThis.SharedArrayBuffer;
const wrapped = Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, outcome(probe, Wrapper)]));
parentPort.postMessage({ native, wrapped, claims, globalIsWrapper: Wrapper !== Native, globalDescriptor: Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer")!.writable });
