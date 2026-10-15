// Language basics and console formatting.
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };
const area = (s: Shape): number => (s.kind === "circle" ? Math.PI * s.r ** 2 : s.w * s.h);
console.log(area({ kind: "circle", r: 2 }).toFixed(3), area({ kind: "rect", w: 3, h: 4 }));

function* fib(): Generator<number> {
  let [a, b] = [0, 1];
  for (;;) { yield a; [a, b] = [b, a + b]; }
}
const first: number[] = [];
for (const n of fib()) { if (first.length === 10) break; first.push(n); }
console.log(first);

class Counter {
  #count = 0;
  static instances = 0;
  constructor(public label: string) { Counter.instances++; }
  inc() { return ++this.#count; }
  get value() { return this.#count; }
}
const c = new Counter("clicks");
c.inc(); c.inc();
console.log(c.label, c.value, Counter.instances);

const { a, ...rest } = { a: 1, b: 2, c: [3, 4] };
console.log(a, rest);
console.log(new Map<string, number>([["x", 1], ["y", 2]]), new Set([1, "two", 3n]));
console.log([1, 2, 3].map((x) => x * 2), { nested: { deep: { deeper: { deepest: 1 } } } });
console.log("%s is %d years and %o", "bun", 3, { ok: true });
console.log(typeof Symbol.iterator, 0.1 + 0.2, 2 ** 53 + 1, -0, [undefined, null]);
const tagged = (s: TemplateStringsArray, ...v: unknown[]) => s.raw.join("|") + v.join(",");
console.log(tagged`a${1}b${2}c`);
console.log([..."héllo"].reverse().join(""), "abc".padStart(6, "-"), "x".repeat(3));
label: for (const i of [1, 2, 3]) { for (const j of [1, 2]) { if (i * j === 4) break label; console.log(i, j); } }
