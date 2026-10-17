import { expect, jest, vi } from "bun:test";

vi.useFakeTimers({ now: 0 });
let count = 0;
let depth = 0;
let maxDepth = 0;
const interval = setInterval(() => {
  count++;
  depth++;
  maxDepth = Math.max(maxDepth, depth);
  expect(jest.getTimerCount()).toBe(0);
  if (count === 1) vi.advanceTimersByTime(5);
  depth--;
}, 5);
vi.advanceTimersByTime(5);
expect(count).toBe(1);
expect(maxDepth).toBe(1);
expect(Date.now()).toBe(10);
vi.advanceTimersByTime(0);
clearInterval(interval);
expect(count).toBe(2);
expect(maxDepth).toBe(1);
expect(jest.getTimerCount()).toBe(0);

const order: string[] = [];
const orderedInterval = setInterval(() => {
  order.push("interval");
  if (order.length === 1) setTimeout(() => order.push("timeout"), 5);
  else clearInterval(orderedInterval);
}, 5);
vi.advanceTimersByTime(10);
expect(order).toEqual(["interval", "timeout", "interval"]);
expect(jest.getTimerCount()).toBe(0);

let refreshCount = 0;
const refreshedInterval = setInterval(() => {
  refreshCount++;
  if (refreshCount === 1) {
    vi.advanceTimersByTime(2);
    refreshedInterval.refresh();
  } else clearInterval(refreshedInterval);
}, 5);
const refreshStart = Date.now();
vi.advanceTimersByTime(5);
expect(refreshCount).toBe(1);
expect(jest.getTimerCount()).toBe(1);
vi.advanceTimersByTime(4);
expect(refreshCount).toBe(1);
vi.advanceTimersByTime(1);
expect(refreshCount).toBe(2);
expect(Date.now()).toBe(refreshStart + 12);
expect(jest.getTimerCount()).toBe(0);

let secondRan = false;
setTimeout(() => process.nextTick(() => clearTimeout(second)), 1);
const second = setTimeout(() => { secondRan = true; }, 1);
vi.runAllTimers();
expect(secondRan).toBe(false);
expect(jest.getTimerCount()).toBe(0);

const errors: unknown[] = [];
const error = new Error("handled fake timer error");
const onUncaught = (value: unknown) => errors.push(value);
process.on("uncaughtException", onUncaught);
const throwStart = Date.now();
let laterRan = false;
try {
  setTimeout(() => { throw error; }, 1);
  setTimeout(() => { throw 0; }, 2);
  setTimeout(() => { laterRan = true; }, 3);
  vi.advanceTimersByTime(4);
  expect(errors.length).toBe(2);
  expect(errors[0]).toBe(error);
  expect(errors[1]).toBe(0);
  expect(laterRan).toBe(true);
  expect(Date.now()).toBe(throwStart + 4);
  expect(jest.getTimerCount()).toBe(0);
} finally {
  process.removeListener("uncaughtException", onUncaught);
}

vi.useFakeTimers({ now: 0 });
const reactivated: number[] = [];
setTimeout(() => reactivated.push(Date.now()), 10);
const cancelled = setTimeout(() => { throw new Error("cancelled reactivated timer"); }, 20);
vi.useFakeTimers({ now: 100 });
clearTimeout(Number(cancelled));
expect(jest.getTimerCount()).toBe(1);
vi.runAllTimers();
expect(reactivated).toEqual([110]);

vi.useFakeTimers({ now: 0 });
setTimeout(() => reactivated.push(Date.now()), 10);
vi.advanceTimersByTime(3);
vi.useFakeTimers({ now: 200 });
vi.runAllTimers();
expect(reactivated).toEqual([110, 210]);
vi.useRealTimers();
console.log("fake timer review regressions ok");
