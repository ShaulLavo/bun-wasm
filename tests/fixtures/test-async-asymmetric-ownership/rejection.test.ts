import { expect, test } from "bun:test";

const reason = new Error("owned Error rejection");
expect.extend({ rejectedError() { return Promise.reject(reason); }, thrownError() { throw reason; } });

function matcher(name: string) {
  const factory: unknown = Reflect.get(expect, name);
  if (typeof factory !== "function") throw new Error(`missing ${name}`);
  return Reflect.apply(factory, expect, []);
}

test("actual rejected Error gets a different wrapper without cause", async () => {
  let caught: unknown;
  try { await expect(1).toEqual(matcher("rejectedError")); } catch (error) { caught = error; }
  if (!(caught instanceof Error)) throw new Error("missing rejection wrapper");
  expect(caught).not.toBe(reason);
  expect(caught.message).toBe("Matcher `rejectedError` returned a promise that rejected");
  expect("cause" in caught).toBe(false);
});

test("direct thrown Error retains its identity", () => {
  let caught: unknown;
  try { expect(1).toEqual(matcher("thrownError")); } catch (error) { caught = error; }
  expect(caught).toBe(reason);
});
