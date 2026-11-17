import { describe, expect, test } from "bun:test";

test("registered before the error", () => {});

// An anonymous arrow function cannot name a block.
describe(() => {}, () => {
  test("should NOT run", () => {
    expect(true).toBe(true);
  });
});

test("registered after the error", () => {});
