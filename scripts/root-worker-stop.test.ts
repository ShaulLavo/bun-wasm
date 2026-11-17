import { expect, test } from "bun:test";
import { physicalStop } from "../web/src/runner.ts";

for (const mode of ["void", "fulfilled", "rejected", "throw"] as const) test(`root stop signals an attempted native termination before its join: ${mode}`, async () => {
  const events: string[] = [];
  const joined = Promise.withResolvers<void>();
  const failure = new Error("native stop failed");
  const worker = { terminate() {
    expect(this).toBe(worker);
    events.push("native");
    if (mode === "throw") throw failure;
    if (mode === "void") return;
    return joined.promise;
  } };
  const result = physicalStop(worker, () => events.push("terminating"), () => events.push("returned"), () => events.push("stopped"));
  // Attach the rejection consumer before releasing the native join.
  const outcome = result.then(() => undefined, error => error);
  if (mode === "void") {
    expect(events).toEqual(["native", "terminating", "returned", "stopped"]);
    expect(await outcome).toBeUndefined();
    return;
  }
  expect(events).toEqual(["native", "terminating"]);
  if (mode === "rejected") joined.reject(failure);
  else joined.resolve();
  expect(await outcome).toBe(mode === "fulfilled" ? undefined : failure);
  expect(events).toEqual(mode === "fulfilled" ? ["native", "terminating", "returned", "stopped"] : ["native", "terminating"]);
});

test("an unattempted native stop does not signal termination", () => {
  const events: string[] = [];
  const failure = new Error("native stop lookup failed");
  const worker = { get terminate(): () => void { throw failure; } };
  expect(() => physicalStop(worker, () => events.push("terminating"), () => events.push("returned"), () => events.push("stopped"))).toThrow(failure);
  expect(events).toEqual([]);
});
