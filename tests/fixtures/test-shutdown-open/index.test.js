import { test, afterAll, expect } from "bun:test";
let cleaned = false;
test("referenced handles do not keep the test command alive", () => {
  Bun.serve({ port: 0, fetch() { return new Response("ok"); } });
  setInterval(() => { throw new Error("interval should not run after the report"); }, 1000);
  expect(true).toBe(true);
});
afterAll(async () => {
  await Bun.sleep(5);
  cleaned = true;
  console.log("cleanup", cleaned);
});
