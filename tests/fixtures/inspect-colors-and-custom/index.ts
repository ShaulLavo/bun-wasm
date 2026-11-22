import util from "node:util";

const raw = (text: string) => JSON.stringify(text);
const circular: Record<string, unknown> = { name: "c" };
circular.self = circular;
class Foo {
  a = 1;
}

// Raw escape sequences for each kind of value, exactly as Bun writes them.
const cases: [string, unknown][] = [
  ["nested", { a: { b: [1, "v"] } }],
  ["flat", { a: 1, b: "x", c: null, d: undefined, e: false, f: 2n, g: Symbol("q") }],
  ["keys", { "a-b": 1, [Symbol("k")]: 2, 3: 4 }],
  ["functions", { f() {}, g: class A {}, h: () => 1 }],
  ["strings", ["a", "b"]],
  ["array", [1, "two", null, undefined, true, 3n, Symbol("s")]],
  ["typed", new Uint8Array([1, 2])],
  ["boxed", [new Number(1), new String("s"), new Boolean(true)]],
  ["regexp", /a+/g],
  ["date", [new Date(0)]],
  ["circular", circular],
  ["class", new Foo()],
  ["map", new Map([["a", 1]])],
  ["set", new Set([1, "b"])],
  ["deep", { a: { b: { c: { d: 1 } } } }],
];
for (const [name, value] of cases) console.log(name, raw(Bun.inspect(value, { colors: true })));
console.log("colors false", raw(Bun.inspect({ a: { b: [1, "v"] } }, { colors: false })));

// The second argument is the depth and the third the colors, even when the depth is missing.
const nested = { a: { b: [1, "v"] } };
const inspect = Bun.inspect as (...args: unknown[]) => string;
console.log("undefined depth", raw(inspect(nested, undefined, true)));
console.log("null depth", raw(inspect(nested, null, true)));
console.log("depth and colors", raw(inspect(nested, 1, true)));
console.log("colors only", raw(inspect(nested, true, 2)));

// Depths are read by value.
const deeper = { a: { b: { c: { d: 1 } } } };
for (const depth of [0, 1, -0, Infinity, -Infinity, 2 ** 32, NaN, 1.5, -1]) {
  try {
    console.log("depth", String(depth), raw(Bun.inspect(deeper, { depth })));
  } catch (error) {
    console.log("depth", String(depth), "threw", (error as Error).message);
  }
}

// A custom inspector gets util.inspect, the options and, with colors, Node's stylize.
const custom = Symbol.for("nodejs.util.inspect.custom");
class Custom {
  [custom](depth: number, options: { colors: boolean; stylize(text: string, style: string): string }, inspect: unknown) {
    const styled = options.stylize("x", "string") + options.stylize("y", "invalid") + options.stylize("z", "boolean");
    return `custom depth=${depth} colors=${options.colors} styled=${raw(styled)} util=${inspect === util.inspect}`;
  }
}
console.log(Bun.inspect(new Custom()));
console.log(Bun.inspect(new Custom(), { colors: true }));
console.log(util.inspect(new Custom(), { colors: true }));

// What a custom inspector throws reaches the caller unchanged, whatever it is.
const sentinel = {
  get message(): string {
    throw "message getter";
  },
};
try {
  Bun.inspect({ [custom]: () => { throw sentinel; } });
} catch (error) {
  console.log("rethrown sentinel:", error === sentinel);
}
try {
  Bun.inspect({ [custom]: () => { throw new RangeError("Maximum call stack size exceeded"); } });
} catch (error) {
  console.log("range error kept:", error instanceof RangeError, (error as Error).message);
}

// Nesting far beyond any stack is a RangeError.
let tall: object = { a: 1 };
for (let i = 0; i < 16 * 1024; i++) tall = { a: tall };
try {
  Bun.inspect(tall, { depth: Infinity });
  console.log("tall: no error");
} catch (error) {
  console.log("tall:", error instanceof RangeError, (error as Error).message);
}
