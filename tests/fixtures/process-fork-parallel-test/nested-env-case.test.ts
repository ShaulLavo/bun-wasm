import { expect, test } from "bun:test";

test("nested bun test still receives inherited BUN_OPTIONS", () => {
  expect(process.env.BUN_OPTIONS).toBe("--parallel=2");
});
