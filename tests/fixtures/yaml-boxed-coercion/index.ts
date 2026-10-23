import assert from "node:assert/strict";
import { YAML } from "bun";

for (const Wrapper of [String, Number]) {
  const sentinel = new Error("coercion");
  const value = Object.assign(new Wrapper(1), { [Symbol.toPrimitive]() { throw sentinel; } });
  assert.throws(() => YAML.stringify(value), error => error === sentinel);
  assert.throws(() => YAML.stringify({ value }), error => error === sentinel);
  assert.throws(() => YAML.stringify({}, null, value), error => error === sentinel);
  const invalid = Object.assign(new Wrapper(1), { [Symbol.toPrimitive]() { return Wrapper; } });
  assert.throws(() => YAML.stringify(invalid), { name: "TypeError", message: "Symbol.toPrimitive returned an object" });
}
const hints: string[] = [];
const text = Object.assign(new String("old"), { [Symbol.toPrimitive](hint: string) { hints.push(hint); return "new"; } });
const number = Object.assign(new Number(1), { [Symbol.toPrimitive](hint: string) { hints.push(hint); return "7"; } });
const boolean = Object.assign(new Boolean(true), { [Symbol.toPrimitive]() { throw new Error("not consulted"); } });
assert.deepEqual(YAML.parse(YAML.stringify({ text, number, boolean })), { text: "new", number: 7, boolean: true });
assert.deepEqual(hints, ["string", "number", "string", "number"]);
console.log("YAML boxed coercion errors, hints and boolean value");
