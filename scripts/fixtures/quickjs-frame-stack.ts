// Call semantics that moving ordinary frames off the C stack must keep.
// scripts/check-quickjs-frame-stack.ts strips the types and runs this on the bare QuickJS
// engine. quickjs-frame-stack.expected.txt holds what the engine printed before the change.
declare function print(...values: unknown[]): void;
declare function gc(): void;
declare function callWith(fn: unknown, receiver: unknown, ...args: unknown[]): unknown;
declare function otherRealm(source: string): unknown;

function show(label: string, action: () => unknown): void {
  let result: string;
  try { result = String(action()); } catch (error) { result = `threw ${(error as Error).name}: ${(error as Error).message}`; }
  print(label, "=>", result);
}

// Arguments: the actual ones, not the padded formal slots.
// oxlint-disable-next-line no-eval -- Sloppy-mode argument mapping needs non-module source.
const sloppy = (0, eval)(`({
  counts: function (a, b, c) { return [arguments.length, a, b, c].join(); },
  none: function () { return [arguments.length, arguments[0], arguments[2]].join(); },
  mapped: function (a, b) { var before = a; arguments[0] = "changed"; var seen = this.child(a); b = "set"; return [before, a, seen, arguments[1], arguments.length].join(); },
  child: function (value) { arguments[0] = "inner"; return value; },
  rest: function (first, ...others) { return [first, others.length, others.join("+")].join(); },
  escape: function (a, b) { return [function () { return a; }, function () { return arguments.length + ":" + b; }, function (next) { a = next; }]; },
  later: function () { var args = arguments; return function () { return Array.prototype.join.call(args); }; },
})`);
show("fewer arguments", () => sloppy.counts(1));
show("equal arguments", () => sloppy.counts(1, 2, 3));
show("extra arguments", () => sloppy.counts(1, 2, 3, 4, 5));
show("zero formals with extras", () => sloppy.none("x", "y", "z"));
show("mapped arguments across a child call", () => sloppy.mapped("first", "second"));
show("mapped arguments with one actual", () => sloppy.mapped("only"));
show("rest", () => [sloppy.rest(), sloppy.rest(1), sloppy.rest(1, 2, 3)].join(" | "));
show("escaping argument closures", () => { const [get, count, set] = sloppy.escape("a", "b"); set("changed"); return [get(), count(7, 8)].join(); });
show("arguments object outlives its frame", () => sloppy.later(4, 5, 6)());
show("C caller with extra arguments", () => callWith(sloppy.counts, null, 1, 2, 3, 4, 5, 6));
show("C caller with fewer arguments", () => callWith(sloppy.counts, null, 1));
show("C caller and mapped arguments", () => callWith(sloppy.mapped, sloppy, "c-first", "c-second", "c-third"));
show("C caller and rest", () => callWith(sloppy.rest, null, 9, 8, 7));

// Receivers, home objects, super and new.target.
class Base {
  value = "base";
  name(): string { return `Base.name(${this.value})`; }
  static create(this: new () => Base): Base { return new this(); }
}
class Derived extends Base {
  override value = "derived";
  override name(): string { return `Derived>${super.name()}`; }
  viaArrow(): string { const inner = () => super.name(); return inner(); }
}
function Target(this: { made: string }): void { this.made = new.target === Target ? "new" : String(new.target); }
show("method receiver", () => new Derived().name());
show("super through an arrow", () => new Derived().viaArrow());
show("static receiver", () => Derived.create().name());
show("detached method", () => { const { name } = new Derived(); return name.call({ value: "borrowed" }); });
show("new.target", () => [new (Target as unknown as new () => { made: string })().made, (() => { const o = { made: "" }; Target.call(o); return o.made; })()].join());
show("class called without new", () => (Derived as unknown as () => unknown)());
show("receiver from a C caller", () => callWith(function (this: unknown) { return String(this); }, "receiver"));
show("bound function", () => (function (this: { v: number }, a: number, b: number) { return this.v + a + b; }).bind({ v: 1 }, 2)(3));

// Exceptions through several frames, with finally and native reentry.
function level(depth: number, log: string[]): number {
  try {
    if (depth === 0) throw new RangeError("bottom");
    return level(depth - 1, log) + 1;
  } finally { log.push(`f${depth}`); }
}
show("exception through frames", () => { const log: string[] = []; try { level(4, log); } catch (error) { return `${(error as Error).name} ${log.join()}`; } return "no throw"; });
show("exception through a native callback", () => { try { [1, 2, 3].map(value => { if (value === 2) throw new TypeError(`item ${value}`); return value; }); } catch (error) { return (error as Error).message; } return "no throw"; });
show("finally overrides", () => (() => { try { return "try"; } finally { void 0; } })());
show("rethrow keeps identity", () => { const original = new Error("same"); try { try { throw original; } finally { void 0; } } catch (error) { return error === original; } return false; });
function frames(): string {
  const stack = String(new Error("trace").stack).split("\n").slice(0, 4);
  return stack.map(line => line.trim().replace(/\(.*[\\/]/, "(")).join(" < ");
}
function outer(): string { return [1].map(() => inner())[0]!; }
function inner(): string { return frames(); }
show("stack frames through native reentry", outer);
show("function metadata", () => [level.name, level.length, sloppy.counts.length, sloppy.rest.length, inner.toString().length > 0].join());

// Generators and async functions calling, and called by, ordinary functions.
function* counter(limit: number): Generator<number, string, number | undefined> {
  let total = 0;
  for (let i = 0; i < limit; i++) {
    const sent = yield plain(i);
    total += sent ?? 0;
    gcInside(2);
  }
  return `done ${total}`;
}
function plain(value: number): number { return value * 10; }
function gcInside(depth: number): void { if (depth === 0) gc(); else gcInside(depth - 1); }
show("generator", () => { const g = counter(3); return [g.next().value, g.next(5).value, g.next(6).value, g.next(7).value, g.next().done].join(); });
show("generator throw and return", () => {
  const log: string[] = [];
  function* guarded(): Generator<number, void, void> { try { yield 1; yield 2; } catch (error) { log.push(`caught ${(error as Error).message}`); yield 3; } finally { log.push("finally"); } }
  const g = guarded();
  g.next();
  log.push(String(g.throw(new Error("in")).value));
  log.push(String(g.return().done));
  return log.join();
});
show("suspended generator keeps captured locals", () => {
  function* holder(): Generator<() => number, void, void> { let local = 1; yield () => local++; yield () => local * 100; }
  const g = holder();
  const first = g.next().value as () => number;
  first();
  gc();
  const second = g.next().value as () => number;
  return [first(), second()].join();
});
show("ordinary function resumes a generator at depth", () => { const g = counter(2); const drive = (depth: number): unknown => (depth === 0 ? g.next(1).value : drive(depth - 1)); return [drive(5), drive(9), drive(3)].join(); });

// Two contexts in one runtime: an error belongs to the realm of the function that raised it.
show("error realm of a foreign function", () => {
  const foreign = otherRealm("(function (value) { return value.missing.deeper; })") as (value: unknown) => unknown;
  const foreignType = otherRealm("TypeError.prototype");
  try { foreign({}); } catch (error) { return [error instanceof TypeError, Object.getPrototypeOf(error) === foreignType].join(); }
  return "no throw";
});
show("foreign function calling back", () => {
  const foreign = otherRealm("(function (callback) { return callback(1) + callback(2); })") as (callback: (n: number) => number) => number;
  return foreign(value => plain(value));
});
show("foreign constructor", () => {
  const Foreign = otherRealm("(function Made() { this.kind = new.target === undefined ? 'call' : 'new'; })") as new () => { kind: string };
  return [new Foreign().kind, Object.getPrototypeOf(new Foreign()) === Foreign.prototype].join();
});

// Many frames, closures made at every level, then storage reused and collected.
show("closures across reused frame storage", () => {
  const made: (() => number)[] = [];
  const build = (depth: number): void => { const local = depth * 3; made.push(() => local + made.length); if (depth > 0) build(depth - 1); };
  build(600);
  const churn = (depth: number): number => (depth === 0 ? 0 : 1 + churn(depth - 1));
  churn(900);
  gc();
  churn(300);
  return [made.length, made[0]!(), made[300]!(), made[600]!()].join();
});
show("large frame with captured locals", () => {
  let source = "";
  for (let i = 0; i < 5300; i++) source += `var v${i} = ${i};`;
  source += "return [function () { return v0 + v2650 + v5299; }, function () { v0 = 7; v5299 = 9; }];";
  const [read, write] = new Function(source)() as [() => number, () => void];
  const before = read();
  write();
  gc();
  return [before, read()].join();
});
show("mapped arguments across reused frame storage", () => {
  const holders: (() => string)[] = [];
  // oxlint-disable-next-line no-eval -- Sloppy-mode argument mapping needs non-module source.
  const make = (0, eval)("(function (a, b) { var args = arguments; a = a + 1; return function () { return args[0] + ':' + args.length + ':' + b; }; })") as (...args: unknown[]) => () => string;
  const dig = (depth: number): void => { holders.push(make(depth, "x", "extra")); if (depth > 0) dig(depth - 1); };
  dig(400);
  gc();
  return [holders[0]!(), holders[200]!(), holders[400]!()].join(" ");
});

// Ordinary functions calling ordinary functions: every call opcode, with the caller's state
// read again after the callee returns.
// oxlint-disable-next-line no-eval -- Sloppy-mode argument mapping and tail positions need non-module source.
const chain = (0, eval)(`(function () { var chain = {
  count: function (n) { return n === 0 ? 0 : 1 + this.count(n - 1); },
  tail: function (n, total) { "use strict"; return n === 0 ? total : chain.tail(n - 1, total + n); },
  plainTail: function (n, total) { return n === 0 ? total : plainTail(n - 1, total + n); },
  after: function (a, b) { var seen = this.write(a, b); return [a, b, seen, arguments.length, arguments[0], this === chain, new.target === undefined].join(); },
  write: function (x, y) { x = "x!"; y = "y!"; arguments[0] = "mapped"; return x + y; },
  padded: function (a, b, c) { return [a, b, c, arguments.length].join(); },
  callPadded: function () { return [this.padded(), this.padded(1), this.padded(1, 2, 3, 4)].join(" | "); },
  rest: function () { return (function (first, ...others) { return first + ":" + others.join("+"); })(1, 2, 3); },
  defaults: function (a = this.count(3), b = a + this.count(2)) { return [a, b].join(); },
  receiver: function () { "use strict"; return [typeof (function () { return this; })(), (function () { return this; }).call(7), typeof free()].join(); },
  sloppyReceiver: function () { return [(function () { return this === globalThis; })(), typeof Object(free.call(5))].join(); },
  build: function (n) { return n === 0 ? new Made(0) : new Made(this.build(n - 1).depth + 1); },
  accessor: { get value() { return chain.count(4); }, set value(next) { chain.stored = chain.count(next); } },
  mutual: function (n) { return n === 0 ? "even" : odd(n - 1); },
  trace: function () { return one(); },
}; function plainTail(n, total) { return n === 0 ? total : plainTail(n - 1, total + n); }
function free() { return this; } function Made(depth) { this.depth = depth; }
function odd(n) { return n === 0 ? "odd" : chain.mutual(n - 1); }
function one() { return two(1); } function two(a) { return three(a, 2); }
function three(a, b) { return String(new Error("inline").stack).split("\\n").slice(0, 5).map(function (line) { return line.trim().replace(/\\(.*[\\\\/]/, "("); }).join(" < "); }
return chain; })()`);
show("method chain", () => [chain.count(0), chain.count(1), chain.count(2500)].join());
show("tail calls", () => [chain.tail(2500, 0), chain.plainTail(2500, 0)].join());
show("caller state after an inline callee", () => chain.after("a", "b"));
show("padded formals from an inline caller", () => chain.callPadded());
show("rest from an inline caller", () => chain.rest());
show("default parameters calling inline", () => [chain.defaults(), chain.defaults(10), chain.defaults(1, 2)].join(" | "));
show("receivers of plain calls", () => [chain.receiver(), chain.sloppyReceiver()].join(" | "));
show("constructors between inline frames", () => chain.build(40).depth);
show("accessors between inline frames", () => { chain.accessor.value = 6; return [chain.accessor.value, chain.stored].join(); });
show("mutual recursion", () => [chain.mutual(2500), chain.mutual(2501)].join());
show("stack frames through inline calls", () => chain.trace());
show("exception through deep inline frames", () => { const log: string[] = []; try { level(1500, log); } catch (error) { return [(error as Error).message, log.length, log[0], log[1500]].join(); } return "no throw"; });
show("throwing callee leaves the caller's operands", () => {
  const thrower = (value: number): number => { if (value > 2) throw new Error(`stop ${value}`); return value; };
  const sum = (a: number, b: number, c: number): number => a + b + c;
  let total = 0;
  for (let i = 0; i < 4; i++) { try { total += sum(thrower(i), thrower(i + 1), thrower(i + 2)); } catch (error) { total += (error as Error).message.length * 100; } }
  return total;
});
show("class called from an inline caller", () => {
  class Local { tag = "local"; }
  const viaCall = (): unknown => (Local as unknown as () => unknown)();
  const holder = { Local, viaMethod(): unknown { return (this.Local as unknown as () => unknown)(); } };
  const results: string[] = [];
  for (const attempt of [viaCall, () => holder.viaMethod()]) { try { attempt(); results.push("returned"); } catch (error) { results.push(`${(error as Error).name}: ${(error as Error).message}`); } }
  return results.join(" | ");
});
show("error realm of a foreign class called without new", () => {
  const Foreign = otherRealm("(class Foreign {})") as unknown as () => unknown;
  const foreignType = otherRealm("TypeError.prototype");
  try { Foreign(); } catch (error) { return [error instanceof TypeError, Object.getPrototypeOf(error) === foreignType].join(); }
  return "no throw";
});
show("foreign function between inline frames", () => {
  const foreign = otherRealm("(function (callback, n) { return n === 0 ? callback(0) : callback(n) + 1; })") as (callback: (n: number) => number, n: number) => number;
  const back = (n: number): number => (n === 0 ? 100 : foreign(back, n - 1));
  return back(200);
});
show("generator driven through inline frames with collection", () => {
  const g = counter(4);
  const drive = (depth: number, sent: number): unknown => { if (depth === 0) { gc(); return g.next(sent).value; } return drive(depth - 1, sent); };
  return [drive(50, 0), drive(700, 2), drive(5, 3), drive(1200, 4), drive(1, 5)].join();
});
show("closures made by inline callees are closed at return", () => {
  const cell = (start: number): [() => number, () => void] => { let value = start; return [() => value, () => { value += 1; }]; };
  const pairs: [() => number, () => void][] = [];
  const fill = (depth: number): void => { pairs.push(cell(depth)); if (depth > 0) fill(depth - 1); };
  fill(800);
  for (const [, bump] of pairs) bump();
  gc();
  return [pairs.length, pairs[0]![0](), pairs[800]![0]()].join();
});

// Asynchronous functions.
async function asynchronous(): Promise<void> {
  const log: string[] = [];
  const step = async (value: number): Promise<number> => { await null; return plain(value); };
  async function* stream(): AsyncGenerator<number, void, void> { try { yield await step(1); gcInside(3); yield await step(2); } finally { log.push("closed"); } }
  for await (const value of stream()) { log.push(String(value)); if (value === 20) break; }
  try { await (async () => { await null; level(2, log); })(); } catch (error) { log.push((error as Error).message); }
  print("async", "=>", log.join());
}
asynchronous().catch(error => print("async failed", String(error)));
