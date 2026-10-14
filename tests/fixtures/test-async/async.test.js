import { test, expect } from "bun:test";

test("async pass", async () => {
  await Bun.sleep(2);
  expect(await Promise.resolve(5)).toBe(5);
});
test("resolves and rejects pass", async () => {
  await expect(Promise.resolve({ a: 1 })).resolves.toEqual({ a: 1 });
  await expect(Promise.reject(new Error("bad"))).rejects.toThrow("bad");
  await expect(Promise.resolve(2)).resolves.not.toBe(3);
});
test("resolves", async () => {
  await expect(Promise.resolve(1)).resolves.toBe(2);
});
test("rejects", async () => {
  await expect(Promise.reject(new Error("x"))).rejects.toThrow("y");
});
test("rejects on resolve", async () => {
  await expect(Promise.resolve(1)).rejects.toBe(1);
});
test("resolves on reject", async () => {
  await expect(Promise.reject(1)).resolves.toBe(1);
});
test("assertions", () => {
  expect.assertions(2);
  expect(1).toBe(1);
});
test("hasAssertions", () => {
  expect.hasAssertions();
});
test("async rejection fails", async () => {
  await Bun.sleep(1);
  expect("late").toBe("early");
});
test("timeout", async () => {
  await new Promise((r) => setTimeout(r, 200));
}, 20);
test("done timeout", (done) => {}, 20);
test("done pass", (done) => {
  setTimeout(() => done(), 5);
});
test("timeout option object", async () => {
  await Bun.sleep(5);
}, { timeout: 1000 });
test("after timeouts", () => {
  expect(true).toBeTruthy();
});
