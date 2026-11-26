// Unit cases for the Bun API probe's results table (scripts/bun-api-probe.ts).
import { expect, test } from "bun:test";
import { cell, table, type EngineResult } from "./bun-api-probe.ts";

test("table cells escape a literal pipe and newlines", () => {
  expect(cell("expected a | b")).toBe("expected a \\| b");
  expect(cell("one\ntwo")).toBe("one two");
  expect(cell("one\r\ntwo\rthree")).toBe("one two three");
  expect(cell("already \\| escaped")).toBe("already \\\\\\| escaped");
});

test("a stop reason with a pipe stays in its cell", () => {
  const result: EngineResult = {
    engine: "quickjs", bootMs: 10, status: "failed: expected a | b", helloMs: [1],
    cases: [{ name: "bun-probe-utils", code: 1, ms: 5, output: "", checks: [{ name: "x | y", verdict: "pass" }] }],
  };
  const lines = table([result]).split("\n");
  expect(lines).toContain("| quickjs | 10 | 1 | 1/1 (failed: expected a \\| b) |");
  expect(lines).toContain("| utils | x \\| y | pass |");
});
