const { test, expect } = require("bun:test");
test("cjs", () => { expect(2).toBeGreaterThan(1); });
