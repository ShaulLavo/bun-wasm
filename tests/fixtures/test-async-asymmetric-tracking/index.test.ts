import { expect, test } from "bun:test";

let completed = 0;
// A primitive diagnostic avoids engine-specific stack text; Error identity is covered by the comparison fixture.
const reason = "owned asymmetric rejection";
expect.extend({
  eventual(value) {
    return new Promise(resolve => setTimeout(() => {
      completed++;
      resolve({ pass: value === 1 });
    }, 0));
  },
  rejected() { return Promise.reject(reason); },
});

function matcher(name: string): unknown {
  const fn: unknown = Reflect.get(expect, name);
  if (typeof fn !== "function") throw new Error(`missing ${name}`);
  return Reflect.apply(fn, expect, []);
}

test("waits for an unawaited nested asymmetric assertion", () => {
  expect({ value: 1 }).toEqual({ value: matcher("eventual") });
});
test("keeps the completed assertion in its invocation", () => {
  expect(completed).toBe(1);
  expect(Promise.resolve({ value: 1 })).resolves.toEqual({ value: matcher("eventual") });
});
test("tracks promise modifier assertions", async () => {
  expect(completed).toBe(2);
  let caught: unknown;
  try { await expect({ value: 1 }).toEqual({ value: matcher("rejected") }); } catch (error) { caught = error; }
  if (!(caught instanceof Error)) throw new Error("missing matcher rejection wrapper");
  expect(caught.message).toBe("Matcher `rejected` returned a promise that rejected");
});
