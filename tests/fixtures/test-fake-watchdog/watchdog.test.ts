import { afterEach, expect, jest, test } from "bun:test";

afterEach(() => { jest.useRealTimers(); });
test("fake timers do not include the runner watchdog", async () => {
  jest.useFakeTimers({ now: 0 });
  await Promise.resolve();
  expect(jest.getTimerCount()).toBe(0);
});
test.failing("runner timeout remains real", async () => {
  jest.useFakeTimers();
  await new Promise(() => {});
}, 5);
test("a new test sees real time after cleanup", () => {
  expect(jest.isFakeTimers()).toBe(false);
  console.log("real watchdog ok");
});
