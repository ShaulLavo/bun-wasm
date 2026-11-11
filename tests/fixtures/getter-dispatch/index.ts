// What a getter read must mean however the engine calls the getter. JavaScriptCore on wasm
// calls `object.name` and `super.name` getters inside its running interpreter loop, and every
// other read from C++ (docs/bun-patches/jsc-getter-dispatch.md). Each static read below has a
// computed-key twin that takes the other path there.
// Run as a guest TypeScript entry; the eval and Function inputs deliberately build JavaScript.
function check(name: string, actual: unknown, expected: unknown): void {
  const same = Object.is(actual, expected);
  console.log(same ? `ok ${name}` : `FAIL ${name}: ${String(actual)} is not ${String(expected)}`);
}
function thrown(action: () => unknown): string {
  try { action(); } catch (error) { return error instanceof Error ? error.constructor.name : typeof error; }
  return "nothing";
}
// A key the compiler cannot see, so `object[dynamic(key)]` is never compiled as `object.key`.
const dynamic = (key: string): string => [key][0]!;

// Receivers and values.
const plain = { tag: "plain", get self(): unknown { return this; }, get doubled(): string { return this.tag + this.tag; } };
const derived: typeof plain = Object.create(plain, { tag: { value: "derived" } });
check("own getter receiver", plain.self, plain);
check("own getter value", plain.doubled, "plainplain");
check("prototype getter receiver", derived.self, derived);
check("prototype getter value", derived.doubled, "derivedderived");
check("computed own getter receiver", (plain as Record<string, unknown>)[dynamic("self")], plain);
check("computed prototype getter value", (derived as Record<string, unknown>)[dynamic("doubled")], "derivedderived");

// Missing properties and accessors without a getter.
const sparse = { set only(_value: number) {} } as { only: unknown; absent?: unknown };
check("missing property", sparse.absent, undefined);
check("setter without getter", sparse.only, undefined);
check("missing property on a primitive", ("text" as unknown as { absent?: unknown }).absent, undefined);

// A throwing getter: the caller's catch, the stack, and the next read.
class GetterFailure extends Error {}
const thrower = { armed: true, get explodes(): number { if (this.armed) throw new GetterFailure("from getter"); return 7; } };
function readsExplodes(): number { return thrower.explodes; }
try {
  readsExplodes();
  check("throwing getter", "returned", "threw");
} catch (error) {
  check("throwing getter reaches the caller's catch", error instanceof GetterFailure, true);
  const stack = String((error as Error).stack);
  const getterAt = stack.indexOf("explodes");
  check("stack names the getter, then its caller", getterAt >= 0 && stack.indexOf("readsExplodes") > getterAt, true);
}
function finallyOrder(): string {
  const order: string[] = [];
  try {
    try { void thrower.explodes; } finally { order.push("finally"); }
  } catch { order.push("catch"); }
  return order.join(",");
}
check("finally runs before the outer catch", finallyOrder(), "finally,catch");
const relay = {
  get inner(): number { return thrower.explodes; },
  get outer(): string { try { return String(this.inner); } catch (error) { return `outer caught ${(error as Error).message}`; } },
};
check("a getter catches its inner getter's throw", relay.outer, "outer caught from getter");
thrower.armed = false;
check("the same getter after its throw", readsExplodes(), 7);
check("nested getters after the throw", relay.outer, "7");

// Bases that cannot be read.
const nothing = null as unknown as { value: number };
const missing = undefined as unknown as { value: number };
const revocable = Proxy.revocable({ value: 1 }, {});
revocable.revoke();
check("null base", thrown(() => nothing.value), "TypeError");
check("undefined base", thrown(() => missing.value), "TypeError");
check("revoked proxy base", thrown(() => revocable.proxy.value), "TypeError");
check("a read after those errors", plain.doubled, "plainplain");

// Primitive receivers: a strict getter sees the primitive, a sloppy one its wrapper.
// Both come from `Function`, so the engine and not the transpiler decides their strictness.
const strictKind = new Function('"use strict"; return typeof this;') as () => string;
const sloppyKind = new Function("return typeof this;") as () => string;
type Kinds = { strictKind: string; sloppyKind: string };
const primitives: ReadonlyArray<readonly [string, object, unknown]> = [
  ["string", String.prototype, "text"], ["number", Number.prototype, 5], ["boolean", Boolean.prototype, true],
  ["symbol", Symbol.prototype, Symbol.iterator], ["bigint", BigInt.prototype, 10n],
];
for (const [label, prototype, sample] of primitives) {
  Object.defineProperty(prototype, "strictKind", { get: strictKind, configurable: true });
  Object.defineProperty(prototype, "sloppyKind", { get: sloppyKind, configurable: true });
  check(`${label} receiver in a strict getter`, (sample as Kinds).strictKind, label);
  check(`${label} receiver in a sloppy getter`, (sample as Kinds).sloppyKind, "object");
  check(`${label} receiver through a computed key`, (sample as Record<string, unknown>)[dynamic("strictKind")], label);
  delete (prototype as Partial<Kinds>).strictKind;
  delete (prototype as Partial<Kinds>).sloppyKind;
}

// super: the lookup starts at the home object's prototype, the receiver stays `this`.
class Base {
  tag = "base";
  get self(): unknown { return this; }
  get label(): string { return `label:${this.tag}`; }
  static get kind(): string { return `static:${this.name}`; }
}
class Middle extends Base {}
class Derived extends Middle {
  override tag = "derived";
  override get self(): unknown { return super.self; }
  override get label(): string { return `derived ${super.label}`; }
  static override get kind(): string { return `derived ${super.kind}`; }
}
const instance = new Derived();
check("super getter receiver", instance.self, instance);
check("super getter value", instance.label, "derived label:derived");
check("static super getter", Derived.kind, "derived static:Derived");
const home = {
  __proto__: { get viaSuper(): string { return (this as unknown as { tag: string }).tag; }, plainData: "data" },
  tag: "home",
  readGetter(): unknown { return super.viaSuper; },
  readData(): unknown { return super.plainData; },
  readMissing(): unknown { return super.absent; },
  readComputed(): unknown { return super[dynamic("viaSuper")]; },
};
check("object literal super getter", home.readGetter(), "home");
check("super data property", home.readData(), "data");
check("super missing property", home.readMissing(), undefined);
check("super getter through a computed key", home.readComputed(), "home");
const borrowed = { tag: "borrowed", readGetter: home.readGetter };
check("super getter with another receiver", borrowed.readGetter(), "borrowed");

// Getters that are not plain JavaScript functions keep their own call path.
const holder = { tag: "holder" } as Record<string, unknown>;
Object.defineProperty(holder, "bound", { get: function (this: { tag: string }) { return this.tag; }.bind({ tag: "bound this" }) });
Object.defineProperty(holder, "proxied", { get: new Proxy(function (this: unknown) { return this === holder ? "proxied getter" : "wrong receiver"; }, {}) });
Object.defineProperty(holder, "arrow", { get: () => "arrow getter" });
Object.defineProperty(holder, "classGetter", { get: class NotCallable {} });
Object.defineProperty(holder, "generated", { get: function* () { yield "generator getter"; } });
Object.defineProperty(holder, "declared", { get: function (this: unknown, first: unknown, second: unknown) { return `${this === holder} ${first} ${second} ${arguments.length}`; } });
const named = holder as { bound: string; proxied: string; arrow: string; classGetter: unknown; generated: Generator<string>; declared: string };
check("host getter", new Map([[1, 2]]).size, 1);
check("typed array host getter", new Uint8Array(3).byteLength, 3);
check("bound function getter", named.bound, "bound this");
check("callable proxy getter", named.proxied, "proxied getter");
check("arrow function getter", named.arrow, "arrow getter");
check("class constructor getter", thrown(() => named.classGetter), "TypeError");
check("generator function getter", named.generated.next().value, "generator getter");
check("getter that declares parameters", named.declared, "true undefined undefined 0");
check("getter that declares parameters, computed", holder[dynamic("declared")], "true undefined undefined 0");

// Proxies: the read is the proxy's, and a getter on the target sees the right receiver.
const target = { tag: "target", get who(): unknown { return this; }, get label(): string { return `label:${this.tag}`; } };
const transparent = new Proxy(target, {});
const trapping = new Proxy(target, { get: (object, key, receiver) => (key === "label" ? "trapped" : Reflect.get(object, key, receiver)) });
const inheritor: typeof target = Object.create(transparent, { tag: { value: "inheritor" } });
check("getter on a proxy target", transparent.who, transparent);
check("proxy get trap", trapping.label, "trapped");
check("proxy get trap passes other getters through", trapping.who, trapping);
check("getter inherited through a proxy", inheritor.label, "label:inheritor");

// One read site that sees data, accessors, prototype changes and removal in turn.
function readP(object: { p?: unknown }): unknown { return object.p; }
const changing: { p?: unknown } = { p: "own data" };
const seen: unknown[] = [];
for (let pass = 0; pass < 4; pass++) seen.push(readP(changing));
Object.defineProperty(changing, "p", { get: () => "own accessor", configurable: true });
seen.push(readP(changing));
Object.defineProperty(changing, "p", { value: "data again", configurable: true });
seen.push(readP(changing));
const parent: { p?: unknown } = { p: "inherited data" };
const child: { p?: unknown } = Object.create(parent);
for (let pass = 0; pass < 24; pass++) readP(child);
seen.push(readP(child));
Object.defineProperty(parent, "p", { get(this: unknown) { return this === child ? "inherited accessor" : "wrong receiver"; }, configurable: true });
seen.push(readP(child));
Object.setPrototypeOf(child, { get p() { return "new prototype"; } });
seen.push(readP(child));
Object.setPrototypeOf(child, {});
seen.push(readP(child));
check("one site across property changes", seen.join("|"),
  "own data|own data|own data|own data|own accessor|data again|inherited data|inherited accessor|new prototype|");
let computations = 0;
const lazy = {
  get cached(): number {
    const value = ++computations;
    Object.defineProperty(this, "cached", { value });
    return value;
  },
};
const lazyReads = [0, 1, 2].map(() => lazy.cached);
check("a getter that replaces itself with data", `${lazyReads.join(",")} after ${computations} computation`, "1,1,1 after 1 computation");

// Nested returns, and a hot site whose frames must all be given back.
const chain = {
  get first(): string { return `first(${this.second})`; },
  get second(): string { return `second(${this.third})`; },
  get third(): string { return "third"; },
};
check("nested getter returns", `<${chain.first}>`, "<first(second(third))>");
const counter = { count: 0, get next(): number { return ++this.count; } };
let total = 0;
for (let pass = 0; pass < 100000; pass++) total += counter.next;
check("a hot getter site", total, 5000050000);
let depth = 0;
const nested = { get down(): number { return ++depth === 48 ? 0 : 1 + nested.down; } };
check("48 nested getters", nested.down, 47);
function* yielding(): Generator<unknown> { yield plain.doubled; yield instance.label; }
check("getters read by a generator", Array.from(yielding()).join(","), "plainplain,derived label:derived");

// A caller with many live registers: the getter's frame must sit below all of them.
function manyLocals(count: number, read: string, context = ""): string {
  const names = Array.from({ length: count }, (_, index) => `v${index}`);
  return `${context}${names.map((name, index) => `let ${name} = ${index};`).join("")}let sum = ${read};${names.map(name => `sum += ${name};`).join("")}return sum;`;
}
const busy = { get value(): number { const a = 1; const b = [a, 2, 3]; return chain.first.length + b.length + a; } };
const localSum = (count: number): number => (count * (count - 1)) / 2 + busy.value;
// GETTER_DISPATCH_WIDE_LOCALS lets a gate ask for enough locals to need the widest operand form.
const widest = Number(process.env.GETTER_DISPATCH_WIDE_LOCALS ?? 300);
for (const [label, count] of [["8", 8], ["200", 200], ["2000", 2000], ["the most", widest]] as const) {
  const reader = new Function("holder", manyLocals(count, "holder.value")) as (holder: typeof busy) => number;
  check(`getter read with ${label} live locals`, reader(busy), localSum(count));
  const SuperReader = (0, eval)(`(Parent => class extends Parent { read() { ${manyLocals(count, "super.value")} } })`)(
    class { get value(): number { return busy.value; } }) as new () => { read(): number };
  check(`super getter read with ${label} live locals`, new SuperReader().read(), localSum(count));
  check(`throwing getter read with ${label} live locals`, thrown(() => reader({ get value(): number { throw new GetterFailure("busy"); } })), "GetterFailure");
}

// First calls of getters that were never compiled, with garbage between them.
let lazyFailures = 0;
for (let index = 0; index < 400; index++) {
  const fresh = (0, eval)(`({ id: ${index}, get value() { const filler = new Array(64).fill(${index}); return this.id * 2 + filler.length; } })`) as { value: number };
  void new Array(512).fill(String(index));
  if (fresh.value !== index * 2 + 64) lazyFailures++;
}
check("first calls of fresh getters under allocation", lazyFailures, 0);

// Unbounded getter recursion is a catchable error, and reads work afterwards.
const endless = { get again(): number { return endless.again + 1; } };
class EndlessBase { get again(): number { return (this as unknown as EndlessDerived).again + 1; } }
class EndlessDerived extends EndlessBase { override get again(): number { return super.again + 1; } }
const endlessKey = { get again(): number { return (endlessKey as Record<string, number>)[dynamic("again")]! + 1; } };
check("unbounded getter recursion", thrown(() => endless.again), "RangeError");
check("unbounded super getter recursion", thrown(() => new EndlessDerived().again), "RangeError");
check("unbounded computed getter recursion", thrown(() => endlessKey.again), "RangeError");
check("reads after the overflows", `${plain.doubled} ${instance.label} ${chain.first}`, "plainplain derived label:derived first(second(third))");

// First calls of never-compiled getters with almost no native stack left: each one returns its
// value or throws a RangeError, and all of them work once the stack is back.
const deepBody = `${"[".repeat(40)}7${"]".repeat(40)}${"[0]".repeat(40)}`;
const untouched = Array.from({ length: 32 }, (_, index) =>
  (0, eval)(`({ get value() { return ${deepBody} + ${index}; } })`) as { value: number });
const nearLimit: string[] = [];
function descend(): void {
  try { descend.call(undefined); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const next = untouched[nearLimit.length];
  if (!next) return;
  try { nearLimit.push(next.value === 7 + nearLimit.length ? "value" : "wrong value"); } catch (error) {
    nearLimit.push(error instanceof RangeError ? "RangeError" : `unexpected ${String(error)}`);
  }
}
descend();
check("first calls near the stack limit return or throw RangeError",
  nearLimit.length === untouched.length && nearLimit.every(outcome => outcome === "value" || outcome === "RangeError"), true);
check("the same getters with the stack back", untouched.every((object, index) => object.value === 7 + index), true);

// The names walk of Ajv 8.17.1's code generator (lib/compile/codegen/index.ts), reduced to its
// recursion. Angular's schema registry nests about 64 `if` nodes; GETTER_DISPATCH_AJV_DEPTH
// lets a gate ask for more.
type Names = Record<string, number>;
const addNames = (names: Names, from: Names): Names => {
  for (const name in from) names[name] = (names[name] ?? 0) + from[name]!;
  return names;
};
class Node { get names(): Names { return {}; } }
class ParentNode extends Node {
  constructor(readonly nodes: Node[] = []) { super(); }
  override get names(): Names { return this.nodes.reduce((names: Names, node) => addNames(names, node.names), {}); }
}
class BlockNode extends ParentNode {}
class If extends BlockNode {
  constructor(readonly condition: string) { super(); }
  override get names(): Names {
    const names = super.names;
    names[this.condition] = (names[this.condition] ?? 0) + 1;
    return names;
  }
}
const ajvDepth = Number(process.env.GETTER_DISPATCH_AJV_DEPTH ?? 64);
const root = new ParentNode();
let last: ParentNode = root;
for (let level = 0; level < ajvDepth; level++) {
  const next = new If(`c${level % 8}`);
  last.nodes.push(next);
  last = next;
}
const counted = Object.values(root.names).reduce((sum, count) => sum + count, 0);
check("nested Ajv names walk", counted === ajvDepth && ajvDepth >= 64, true);
console.log("continued");
