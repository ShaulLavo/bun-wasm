import { test, afterAll } from "bun:test";
test("pending rejection affects exit status", () => {
  setInterval(() => {}, 1000);
});
afterAll(async () => {
  await Bun.sleep(5);
  console.log("cleanup");
  queueMicrotask(() => Promise.reject(new Error("shutdown rejection")));
});
