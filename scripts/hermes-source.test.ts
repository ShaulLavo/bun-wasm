import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Hermes VM resolves the sibling adapter file", () => {
  const source = readFileSync(resolve(import.meta.dir, "../crates/bunwasm-engine-hermes/src/vm.rs"), "utf8");
  expect(/#\[path = "source\.rs"\]\s*mod source;/.test(source)).toBe(true);
});
