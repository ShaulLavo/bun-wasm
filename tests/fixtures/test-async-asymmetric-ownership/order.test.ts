import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const resolvers: (() => void)[] = [];
expect.extend({ ordered() {
  return new Promise(resolve => resolvers.push(() => resolve({ pass: true })));
} });
const factory: unknown = Reflect.get(expect, "ordered");
if (typeof factory !== "function") throw new Error("missing ordered matcher");

test("snapshot call order", () => {
  expect({ value: 1 }).toMatchSnapshot({ value: Reflect.apply(factory, expect, [1]) });
  expect({ value: 2 }).toMatchSnapshot({ value: Reflect.apply(factory, expect, [2]) });
  resolvers[1]();
  resolvers[0]();
});

test("snapshot names preserve call order", () => {
  const text = readFileSync("__snapshots__/order.test.ts.snap", "utf8");
  // Files flush after the entire suite. Existing snapshots pin the names before any write.
  expect(text).toContain('exports[`snapshot call order 1`] = `\n{\n  "value": ordered(1),');
  expect(text).toContain('exports[`snapshot call order 2`] = `\n{\n  "value": ordered(2),');
});
