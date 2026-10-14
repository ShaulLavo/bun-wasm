import { test, expect } from "bun:test";
test("rejection", async () => {
  Promise.reject(new Error("stray"));
  await Bun.sleep(5);
});
test("next", () => {});
test("timer error", async () => {
  setTimeout(() => {
    expect("timer").toBe("callback");
  }, 1);
  await Bun.sleep(20);
});
