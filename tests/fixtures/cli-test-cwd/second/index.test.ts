import { expect, test } from "bun:test";
import { basename } from "node:path";

test("runs only inside requested cwd", () => {
  expect(basename(process.cwd())).toBe("second");
});
