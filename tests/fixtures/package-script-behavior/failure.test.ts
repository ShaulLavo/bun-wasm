import { expect, test } from "bun:test";
test("failure reaches the package script exit status", () => { expect(1).toBe(2); });
