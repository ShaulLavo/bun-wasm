import { expect, test } from "bun:test";
test("conventional package script", () => { expect(42).toBe(42); console.log("test once"); });
test("forwarded filter excludes this", () => { throw new Error("test filter was lost"); });
