import { test, describe, beforeEach, beforeAll, afterEach, expect } from "bun:test";
describe("be", () => {
  beforeEach(() => { expect(1).toBe(2); });
  test("t1", () => {});
  test("t2", () => {});
});
describe("ba", () => {
  beforeAll(() => { expect("all").toBe("boom"); });
  test("t3", () => {});
});
describe("ae", () => {
  afterEach(() => { expect("after").toBe("boom"); });
  test("t4", () => {});
});
test("match me", () => {});
