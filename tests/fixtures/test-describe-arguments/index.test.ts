import { describe, expect, test } from "bun:test";

// A sole function is the callback, even a named one, and adds no name.
describe(() => {
  test("an arrow callback alone", () => {
    expect(true).toBe(true);
  });
});
describe(function namedBlock() {
  test("a named function callback alone", () => {});
});

// A function followed by options is the callback.
describe(() => {
  test("callback then options", () => {});
}, { timeout: 5 } as never);

// Otherwise the first argument names the block.
describe("string", () => {
  test("string name", () => {});
});
describe("options before the callback", { timeout: 5 } as never, () => {
  test("three arguments", () => {});
});
describe(42, () => {
  test("number name", () => {});
});
describe(class Rectangle {}, () => {
  test("named class", () => {});
});
describe(class {}, () => {
  test("anonymous class", () => {});
});
describe(function add() {}, () => {
  test("named function", () => {});
});

test("after the blocks", () => {});
