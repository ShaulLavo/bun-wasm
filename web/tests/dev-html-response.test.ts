import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

const adapter = new URL("../../crates/bunwasm-runtime/src/js/dev_html.ts", import.meta.url);
test("generic hot responses have a guest-owned enrollment adapter", () => {
  expect(existsSync(adapter)).toBe(true);
});
