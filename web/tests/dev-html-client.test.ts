import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("hot HTML has a document-owned tree-preserving client", () => {
  expect(existsSync(new URL("../src/dev-html-client.ts", import.meta.url))).toBe(true);
});
