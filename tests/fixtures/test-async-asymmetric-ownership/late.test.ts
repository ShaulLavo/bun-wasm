import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

const resolvers: ((value: { pass: boolean }) => void)[] = [];
const object = { value: 1 };
expect.extend({ later() { return new Promise(resolve => resolvers.push(resolve)); } });
const factory: unknown = Reflect.get(expect, "later");
if (typeof factory !== "function") throw new Error("missing later matcher");
const later = () => Reflect.apply(factory, expect, []);

test("snapshot times out in its originating invocation", () => {
  expect(object).toMatchSnapshot({ value: later() });
  expect(object).toMatchInlineSnapshot({ value: later() });
  expect(new Promise(resolve => resolvers.push(resolve))).resolves.toEqual(1);
}, 50);

test("late continuations leave the next case untouched", async () => {
  expect.assertions(3);
  expect(resolvers.length).toBe(3);
  for (const resolve of resolvers) resolve({ pass: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(object.value).toBe(1);
  expect(existsSync("__snapshots__/late.test.ts.snap")).toBe(false);
});
