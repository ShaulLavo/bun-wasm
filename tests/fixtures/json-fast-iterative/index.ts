import assert from "node:assert/strict";

type Shape = "object" | "array" | "mixed";
function chain(depth: number, shape: Shape, leaf: unknown = 0): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = shape === "array" || (shape === "mixed" && i % 2) ? [value] : { a: value };
  return value;
}

function outcome(value: unknown, general: boolean, gap?: number | string): unknown {
  try { return { text: JSON.stringify(value, general ? (_key, item) => item : undefined, gap) }; }
  catch (error) {
    assert.ok(error instanceof Error);
    return { name: error.name, message: error.message };
  }
}

function compare(value: unknown, gap?: number | string) {
  assert.deepEqual(outcome(value, false, gap), outcome(value, true, gap));
}

const deleted = { before: 1, a: { child: 2 }, after: 3, end: 4 };
Reflect.deleteProperty(deleted, "before");
Reflect.deleteProperty(deleted, "after");
const dictionary: Record<string, unknown> = { child: { a: 1 } };
for (let i = 0; i < 400; i++) dictionary[`p${i}`] = i;
for (let i = 0; i < 400; i += 2) Reflect.deleteProperty(dictionary, `p${i}`);
const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`p${i}`, i === 150 ? { a: 1 } : i]));
const hidden = Object.defineProperty({ a: { b: 0 } }, "hidden", { value: 1 });
const shared = { a: 1 };
const sparse = new Array(300);
sparse[299] = { a: 1 };
const corpus: unknown[] = [
  {}, [], [1, 2, 3], [1.5, 2.25], [{ a: 0 }, "x"], [1, , 3], sparse,
  deleted, dictionary, wide, hidden, { a: shared, b: shared },
  { undefined, symbol: Symbol("s"), fn() {} }, [undefined, Symbol("s"), () => {}],
  { 'a"\\\n': "\u0000\t\n\"\\" }, { a: "é" }, { a: "漢" }, { 漢: 1 },
];
for (const value of corpus) for (const gap of [undefined, 2, "\t"]) compare(value, gap);
for (const depth of [1, 2, 64]) {
  for (const gap of [undefined, 2, "\t"]) compare(chain(depth, "mixed"), gap);
}

function exactChain(depth: number, shape: Shape) {
  const bound = depth * 6 + 1;
  assert.ok(bound < 8 * 1024 * 1024, "bound before constructing the graph");
  const value = chain(depth, shape);
  const text = JSON.stringify(value);
  assert.equal(typeof text, "string", `${shape} ${depth} succeeds`);
  let arrays = shape === "array" ? depth : 0;
  if (shape === "mixed") arrays = Math.floor(depth / 2);
  assert.equal(text.length, (depth - arrays) * 6 + arrays * 2 + 1);
  assert.equal(text[0], shape === "array" || (shape === "mixed" && (depth - 1) % 2) ? "[" : "{");
  assert.equal(text.at(-1), text[0] === "[" ? "]" : "}");
  assert.equal(text, JSON.stringify(value, (_key, item) => item));
}
for (const shape of ["object", "array", "mixed"] satisfies Shape[]) {
  for (const depth of [4094, 4095, 4096, 4097, 39999]) exactChain(depth, shape);
}
for (const leaf of ["漢", "x".repeat(20000), { 漢: "é" }]) compare(chain(1000, "mixed", leaf));

function effectGraph(depth: number, position: number, log: string[]) {
  const proxy = new Proxy({ end: 0 }, {
    get(target, key, receiver) { log.push(`get ${String(key)}`); return Reflect.get(target, key, receiver); },
    ownKeys(target) { log.push("keys"); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { log.push(`descriptor ${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const json = { toJSON() { log.push("toJSON"); return proxy; } };
  const getter = { get a() { log.push("getter"); return json; } };
  return chain(position, "object", chain(depth - position, "object", getter));
}
for (const position of [30, 4100]) {
  const fastLog: string[] = [];
  const generalLog: string[] = [];
  const fast = JSON.stringify(effectGraph(4200, position, fastLog));
  const general = JSON.stringify(effectGraph(4200, position, generalLog), (_key, item) => item);
  assert.equal(fast, general);
  assert.deepEqual(fastLog, generalLog);
  assert.equal(fastLog.filter(item => item === "getter").length, 1);
  assert.equal(fastLog.filter(item => item === "toJSON").length, 1);
}
const rootCycle: Record<string, unknown> = {};
rootCycle.a = rootCycle;
const interior: Record<string, unknown> = {};
interior.a = { b: interior };
for (const cycle of [rootCycle, interior]) {
  assert.throws(() => JSON.stringify(cycle), TypeError);
  compare(cycle);
}
assert.equal(JSON.stringify({ recovered: true }), '{"recovered":true}');
console.log("JSON differential, depth, effects, cycles and recovery passed");
