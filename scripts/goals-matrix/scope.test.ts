import { expect, test } from "bun:test";
import { admit, awaitWithin, Scope, within } from "./scope";

test("elapsed and closed scopes retain their exact reason before timer delivery", async () => {
  const scope = Scope.open(0);
  try {
    expect(scope.signal.aborted).toBe(false);
    expect(() => admit(scope)).toThrow("Phase timed out after 0 ms");
    await expect(scope.run(async () => { throw new Error("must not run"); })).rejects.toBe(scope.expiryReason);
    scope.close(new Error("ended"));
    await expect(scope.run(async () => { throw new Error("must not run"); })).rejects.toThrow("ended");
  } finally { scope.close(); }
});

test("narrowed awaits expire while their parent stays live", async () => {
  const scope = Scope.open(1000);
  const reason = new Error("narrowed expiry");
  const work = Promise.withResolvers<void>();
  try {
    await expect(awaitWithin(work.promise, within(scope, 10, reason))).rejects.toBe(reason);
    expect(scope.signal.aborted).toBe(false);
    work.reject(new Error("late rejection is handled"));
    await Promise.resolve();
    expect(within(scope, 2000, reason)).toBe(scope);
  } finally { scope.close(); }
});

test("parent cancellation and earlier deadlines retain their reasons", async () => {
  const parent = Scope.open(1000);
  const child = Scope.open(2000, parent);
  const reason = new Error("parent stopped");
  try {
    expect(child.deadline).toBe(parent.deadline);
    expect(child.expiryReason).toBe(parent.expiryReason);
    const result = child.run(() => new Promise<void>(() => {}));
    parent.close(reason);
    await expect(result).rejects.toBe(reason);
  } finally { child.close(); parent.close(); }
});

test("already elapsed plain admissions reject without an aborted signal", async () => {
  const scope = Scope.open(1000);
  const reason = new Error("already elapsed");
  try {
    await expect(awaitWithin(Promise.resolve(1), { signal: scope.signal, deadline: Date.now() - 1, expiryReason: reason })).rejects.toBe(reason);
    expect(scope.signal.aborted).toBe(false);
  } finally { scope.close(); }
});

test("settlement observes elapsed time even before the deadline timer can run", async () => {
  const scope = Scope.open(1);
  try {
    const waiting = awaitWithin(Promise.resolve(1), scope);
    while (Date.now() <= scope.deadline) { /* Hold this turn so the timer has not run. */ }
    expect(scope.signal.aborted).toBe(false);
    await expect(waiting).rejects.toBe(scope.expiryReason);
  } finally { scope.close(); }
});
