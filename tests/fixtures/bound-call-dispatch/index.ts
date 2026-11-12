// What a call of a bound function must mean however the engine makes it. JavaScriptCore on wasm
// calls the target of a bound function inside its running interpreter loop when bytecode calls
// it, and from C++ when C++ calls it (docs/bun-patches/jsc-bound-call-dispatch.md). Each call route
// a bytecode call can take reaches the bound function: first call, linked, polymorphic, closure,
// spread, apply and tail call.
// Run as a guest TypeScript entry; the Function inputs deliberately build JavaScript.
function check(name: string, actual: unknown, expected: unknown): void {
  const same = Object.is(actual, expected);
  console.log(same ? `ok ${name}` : `FAIL ${name}: ${String(actual)} is not ${String(expected)}`);
}
function thrown(action: () => unknown): string {
  try { action(); } catch (error) { return error instanceof Error ? error.constructor.name : typeof error; }
  return "nothing";
}
type Variadic = (...values: unknown[]) => unknown;

// `this` and argument order with no, one, three and five bound arguments: three fit in the
// bound function itself, more live in a separate store.
function collect(this: unknown, ...values: unknown[]): string {
  return `${String((this as { tag?: string } | undefined)?.tag)}:${values.join(",")}`;
}
const receiver = { tag: "r" };
check("no bound arguments", collect.bind(receiver)("a", "b"), "r:a,b");
check("one bound argument", collect.bind(receiver, 1)("a"), "r:1,a");
check("three bound arguments", collect.bind(receiver, 1, 2, 3)("a", "b"), "r:1,2,3,a,b");
check("five bound arguments", collect.bind(receiver, 1, 2, 3, 4, 5)("a"), "r:1,2,3,4,5,a");
check("five bound arguments and none passed", collect.bind(receiver, 1, 2, 3, 4, 5)(), "r:1,2,3,4,5");

// Strict and sloppy targets: the engine, not the transpiler, decides their strictness.
const strictThis = new Function('"use strict"; return this === undefined ? "undefined" : typeof this;') as () => string;
const sloppyThis = new Function("return this === globalThis ? \"global\" : typeof this;") as () => string;
check("strict target, primitive this", strictThis.bind(5)(), "number");
check("sloppy target, primitive this", sloppyThis.bind(5)(), "object");
check("strict target, undefined this", strictThis.bind(undefined)(), "undefined");
check("sloppy target, undefined this", sloppyThis.bind(undefined)(), "global");

// Arity, `arguments`, `new.target` and the bound function's own properties.
function shape(this: unknown, a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown): string {
  return `${arguments.length} ${[a, b, c, d, e].map(String).join(",")} ${String(new.target)}`;
}
const short = shape.bind(null, 1);
check("arity shortage fills undefined", short(2), "2 1,2,undefined,undefined,undefined undefined");
check("bound length", short.length, 4);
check("bound name", short.name, "bound shape");
const counted = new Function("return arguments.length + ':' + Array.prototype.join.call(arguments, '');") as Variadic;
const manyPassed = Array.from({ length: 5000 }, (_, index) => index % 10);
check("thousands of passed arguments", (counted.bind(null, 7, 7, 7, 7) as Variadic)(...manyPassed), `5004:7777${manyPassed.join("")}`);

// A bound function of a bound function, and native targets.
const twice = collect.bind(receiver, 1).bind({ tag: "ignored" }, 2);
check("bound function of a bound function", twice(3), "r:1,2,3");
check("native target", Math.max.bind(null, 4)(9, 2), 9);
check("native target with this", Array.prototype.join.bind(["x", "y"])("-"), "x-y");
check("bound native target", Math.max.bind(null, 1).bind(null, 8)(3), 8);

// Construction keeps its own path: `new` gives `new.target` the target, and a class target
// refuses a plain call from its own entry.
class Point {
  constructor(readonly x: number, readonly y: number) {}
  get sum(): number { return this.x + this.y; }
}
const BoundPoint = Point.bind(null, 3) as unknown as new (y: number) => Point;
const made = new BoundPoint(4);
check("new on a bound class", made.sum, 7);
check("new on a bound class gives its instance", made instanceof Point, true);
function Target(this: { seen?: unknown }): void { this.seen = new.target === Target; }
const BoundTarget = Target.bind(null) as unknown as new () => { seen: boolean };
check("new.target is the target", new BoundTarget().seen, true);
check("class target without new", thrown(() => (Point.bind(null) as unknown as () => void)()), "TypeError");

// Throws cross the bound frame to the caller's catch, `finally` first, and the stack names the
// target, then its caller, and no bound frame.
class BoundFailure extends Error {}
function explode(this: unknown, reason: string): never { throw new BoundFailure(reason); }
const boundExplode = explode.bind(null, "from target");
function callsBoundExplode(): void { boundExplode(); }
try {
  callsBoundExplode();
  check("throw from a bound target", "returned", "threw");
} catch (error) {
  check("throw reaches the caller's catch", error instanceof BoundFailure && error.message === "from target", true);
  const stack = String((error as Error).stack);
  const targetAt = stack.indexOf("explode");
  check("stack names the target, then its caller", targetAt >= 0 && stack.indexOf("callsBoundExplode") > targetAt, true);
  check("stack hides the bound frame", stack.includes("bound explode"), false);
}
function finallyOrder(): string {
  const order: string[] = [];
  try {
    try { boundExplode(); } finally { order.push("finally"); }
  } catch { order.push("catch"); }
  return order.join(",");
}
check("finally runs before the outer catch", finallyOrder(), "finally,catch");
const relay = (function (this: unknown, inner: () => void): string {
  try { inner(); return "returned"; } catch (error) { return `relay caught ${(error as Error).message}`; }
}).bind(null, boundExplode);
check("a bound function catches its bound callee's throw", relay(), "relay caught from target");

// Call routes. A site run once is unlinked; a site run many times with one callee is linked; a
// site that sees several bound functions shares their one executable (closure); a site that sees
// bound, plain and native callees is polymorphic.
const add = (function (this: { base: number }, value: number): number { return this.base + value; });
const boundAdd = add.bind({ base: 10 });
check("first call of a site", boundAdd(1), 11);
let linked = 0;
for (let index = 0; index < 2000; index++) linked += boundAdd(index);
check("hot linked call", linked, 2000 * 10 + (1999 * 2000) / 2);
const closures = [add.bind({ base: 1 }), add.bind({ base: 2 }), add.bind({ base: 3 }), collect.bind({ tag: "c" }) as unknown as (value: number) => number];
const closureResults: unknown[] = [];
for (let index = 0; index < 400; index++) closureResults.push(closures[index % 4]!(index));
check("closure call over bound functions", closureResults.slice(0, 8).join(" "), "1 3 5 c:3 5 7 9 c:7");
const mixed: Array<(value: number) => unknown> = [boundAdd, (value: number) => value * 2, Math.abs, collect.bind({ tag: "m" }, 0) as unknown as (value: number) => unknown];
const mixedResults: unknown[] = [];
for (let index = 0; index < 400; index++) mixedResults.push(mixed[index % 4]!(-index));
check("polymorphic call", mixedResults.slice(0, 8).join(" "), "10 -2 2 m:0,-3 6 -10 6 m:0,-7");
const spreadArguments = [1, 2, 3];
check("spread call", (collect.bind(receiver, 0) as Variadic)(...spreadArguments), "r:0,1,2,3");
check("apply with an array", collect.bind(receiver, 0).apply(null, ["p", "q"]), "r:0,p,q");
check("call", collect.bind(receiver, 0).call(null, "p"), "r:0,p");
const bouncer = new Function("limit", '"use strict"; let self; function bounce(left) { return left === 0 ? "landed" : self(left - 1); } self = bounce.bind(null); return self(limit);') as (limit: number) => string;
check("tail calls through a bound function", bouncer(1000), "landed");

// Bound functions called from C++: callbacks, comparators, replacers, and a bound getter.
const scale = (function (this: { factor: number }, value: number): number { return value * this.factor; }).bind({ factor: 3 });
check("bound callback from map", [1, 2, 3].map(scale).join(","), "3,6,9");
check("bound comparator", [3, 1, 2].sort((function (this: { sign: number }, a: number, b: number) { return this.sign * (a - b); }).bind({ sign: -1 })).join(","), "3,2,1");
check("bound replacer", JSON.stringify({ a: 1 }, (function (this: unknown, _key: string, value: unknown) { return typeof value === "number" ? value + 1 : value; }).bind(null)), '{"a":2}');
const withBoundGetter = Object.defineProperty({}, "value", { get: (function (this: { tag: string }) { return this.tag; }).bind({ tag: "bound getter" }) }) as { value: string };
check("bound getter", withBoundGetter.value, "bound getter");

// First calls of fresh targets under allocation: each target is compiled by its first call
// through a bound function while the heap grows.
const retained: unknown[] = [];
let compiled = 0;
for (let round = 0; round < 200; round++) {
  for (let fill = 0; fill < 200; fill++) retained.push({ round, fill, text: `${round}-${fill}` });
  const fresh = new Function("a", "b", "c", `return a + b + c + ${round};`) as (a: number, b: number, c: number) => number;
  compiled += (fresh.bind(null, 1, 2) as (c: number) => number)(3) - 6 - round;
}
check("first calls under allocation", compiled === 0 && retained.length === 40000, true);

// A caller with many live registers. BOUND_CALL_WIDE_LOCALS lets a gate ask for the widest
// operand form.
const wideLocals = Number(process.env.BOUND_CALL_WIDE_LOCALS ?? 300);
const wideBody = Array.from({ length: wideLocals }, (_, index) => `let v${index} = ${index};`).join("\n");
const wide = new Function("callee", `${wideBody}\nconst result = callee(v0, v${wideLocals - 1});\nreturn result + v${wideLocals - 1};`) as (callee: (a: number, b: number) => number) => number;
check("caller with many locals", wide(add.bind({ base: 1 }) as unknown as (a: number, b: number) => number), 1 + 0 + (wideLocals - 1));

// Unbounded recursion through a bound function is a catchable RangeError, every level that got
// a value adds one, and bound calls work afterwards.
let returned = 0;
let swallowed = 0;
function deeper(this: unknown, step: number): number {
  try {
    const below = boundDeeper(step);
    returned++;
    return step + below;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    swallowed++;
    return 0;
  }
}
const boundDeeper = deeper.bind(null, 1) as unknown as (step: number) => number;
const reached = boundDeeper(0);
check("overflow caught inside a bound target", reached > 20 && reached === returned && swallowed >= 1, true);
let unboundedRuns = 0;
const unbounded = (function (this: unknown): number { unboundedRuns++; return 1 + unboundedSelf(); });
const unboundedSelf = unbounded.bind(null);
check("unbounded bound recursion", thrown(unboundedSelf), "RangeError");
check("recovery after overflow", unboundedRuns > 20 && boundAdd(5) === 15 && twice(4) === "r:1,2,4", true);
// Room for the passed arguments but not for a second copy with the bound ones: the call is
// refused before the target runs, and the next one works.
let refusedRuns = 0;
const refusedTarget = (function (this: unknown, ...values: unknown[]): number { refusedRuns++; return values.length; }).bind(null, 1, 2, 3, 4) as Variadic;
const crowded = new Array<number>(400_000).fill(1);
check("a bound call without room for its arguments", thrown(() => refusedTarget(...crowded)), "RangeError");
check("the refused target never ran", refusedRuns, 0);
check("a bound call after the refusal", refusedTarget(5), 5);

// Babel's printer (lib/printer.js, @babel/generator 7.29.14): print() calls exactSource() with
// printMethod.bind(this, node, parent), and that callback prints the children. BOUND_CALL_BABEL_DEPTH
// lets a gate ask for more than the printer reached when bound calls reentered the interpreter.
type PrintNode = { type: string; children: PrintNode[] };
class Printer {
  output: string[] = [];
  exactSource(_location: unknown, callback: () => void): void { callback(); }
  print(node: PrintNode, parent: PrintNode | null): void {
    const printMethod = (this as unknown as Record<string, (node: PrintNode, parent: PrintNode | null) => void>)[node.type]!;
    this.exactSource(node, printMethod.bind(this, node, parent));
  }
  Element(node: PrintNode, _parent: PrintNode | null): void {
    this.output.push("<");
    for (const child of node.children) this.print(child, node);
    this.output.push(">");
  }
}
const babelDepth = Number(process.env.BOUND_CALL_BABEL_DEPTH ?? 64);
const document: PrintNode = { type: "Element", children: [] };
let innermost = document;
for (let level = 1; level < babelDepth; level++) {
  const child: PrintNode = { type: "Element", children: [] };
  innermost.children.push(child);
  innermost = child;
}
const printer = new Printer();
printer.print(document, null);
check("nested Babel print through bound callbacks", printer.output.length === 2 * babelDepth && babelDepth >= 64, true);

// A bound function called by async code.
const later = (async function (this: { tag: string }, suffix: string): Promise<string> { await null; return `${this.tag} ${suffix}`; }).bind({ tag: "async" });
later("bound").then(value => {
  check("bound async target", value, "async bound");
  console.log("continued");
});
