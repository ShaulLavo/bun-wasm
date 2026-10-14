console.log({ a: 1, b: "str", c: [1, 2, 3], d: { e: { f: { g: 1 } } } });
console.log([1, "a", { x: 1 }], [], {}, [[]], [undefined, null]);
console.log(new Map([["a", 1]]), new Set([1, "two"]), new Map(), new Set());
console.log("str", 1, -0, NaN, true, 1.5, 1e21, 10n, Symbol("s"), undefined, null);
console.log(function named() {}, () => {}, class Foo {});
console.log(new Uint8Array([1, 2, 3]), new Date(0), /re/g);
class P {
  constructor() {
    this.x = 1;
  }
}
console.log(new P(), Object.create(null), [1, , 3]);
console.log(Array.from({ length: 30 }, (_, i) => i));
const circ = { name: "c" };
circ.self = circ;
console.log(circ);
console.log("%s is %d years, %i, %f, %j, %%", "Bob", 42.5, 42.5, 1.5, { j: 1 });
console.log({ "key-dash": 1, nested: [{ deep: [1, [2, [3, [4]]]] }] });
console.log(["a\nb", 'q"uote'], "plain\nstring");
console.log({ fn() {}, get g() { return 1; } });
console.error("to stderr");
console.info("info"), console.debug("debug");
console.group("group");
console.log("indented");
console.groupEnd();
console.log("dedented");
console.count();
console.count();
console.count("x");
console.assert(true, "nope");
console.table([{ a: 1, b: "two" }, { a: 3 }]);
console.log(Promise.resolve(1), new Promise(() => {}));
console.log(Buffer.from("hi"));
console.log([1.5, -2], { long: "x".repeat(70), other: 1 });
console.log(new Error("logged error").message);
