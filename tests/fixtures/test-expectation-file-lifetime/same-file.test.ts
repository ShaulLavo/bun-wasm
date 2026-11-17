import { beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
const outside = expect(1);
let all: ReturnType<typeof expect>;
let hook: ReturnType<typeof expect>;
let cached: ReturnType<typeof expect>;
beforeAll(() => { all = expect(1); });
beforeEach(() => { hook = expect(1); });
afterEach(() => { hook.toMatchInlineSnapshot(`1`); });
test("cached and hook expectations across asynchronous turns", async () => {
  cached = expect(1);
  cached.toMatchInlineSnapshot(`1`);
  cached.toMatchInlineSnapshot(`1`);
  hook.toMatchInlineSnapshot(`1`);
  all.toMatchInlineSnapshot(`1`);
  outside.toMatchInlineSnapshot(`1`);
  await Promise.resolve();
  cached.toMatchInlineSnapshot(`1`);
  await new Promise(resolve => setTimeout(resolve, 1));
  cached.toMatchInlineSnapshot(`1`);
});
test("cached expectation across same-file tests", () => {
  cached.toBe(1);
  cached.toMatchInlineSnapshot(`1`);
});

test("negation before snapshot reservation", () => {
  expect.assertions(4);
  expect(() => expect(1).not.toMatchSnapshot("counter")).toThrow("Snapshot matchers cannot be used with not");
  expect(1).toMatchSnapshot("counter");
});
