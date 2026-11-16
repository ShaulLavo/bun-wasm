import { expect, test } from "bun:test";
import { assertion, consumers, matcher } from "./consumers";

let completed = 0;
expect.extend({ eventual() {
  return new Promise(resolve => setTimeout(() => { completed++; resolve({ pass: true }); }, 0));
} });

for (const mode of ["normal", "resolves", "rejects"]) {
  for (const [name, value, apply] of consumers(matcher())) {
    if (name === "throw" && mode !== "normal") continue;
    test(`${mode} ${name}`, () => { apply(assertion(mode, value)); });
  }
}

test("all unawaited successes settled", () => {
  expect.assertions(1);
  expect(completed).toBe(49);
});
