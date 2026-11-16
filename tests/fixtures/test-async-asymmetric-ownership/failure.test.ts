import { expect, test } from "bun:test";
import { assertion, consumers, matcher } from "./consumers";

let completed = 0;
const reason = new Error("owned matcher reason");
expect.extend({ eventual() {
  return Promise.resolve().then(() => {
    completed++;
    if (process.env.REJECT_MATCHER === "1") throw reason;
    return { pass: false };
  });
} });

for (const mode of ["normal", "resolves", "rejects"]) {
  for (const [name, value, apply] of consumers(matcher())) {
    // The throw assertion's promise modifier already defines the thrown value.
    if (name === "throw" && mode !== "normal") continue;
    test(`${mode} ${name}`, () => { apply(assertion(mode, value)); });
  }
}

test("next invocation stays clean", () => {
  expect.assertions(1);
  expect(completed).toBe(49);
});
