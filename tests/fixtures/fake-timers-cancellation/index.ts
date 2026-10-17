import { expect, jest, vi } from "bun:test";

type Cancellation = "numeric" | "handle" | "all";
const modes: Cancellation[] = ["numeric", "handle", "all"];

for (const mode of modes) {
  jest.useFakeTimers({ now: 0 });
  let count = 0;
  let otherRan = false;
  if (mode === "all") setTimeout(() => { otherRan = true; }, 10);
  const timer = setInterval(() => {
    count++;
    if (mode === "numeric") clearInterval(Number(timer));
    else if (mode === "handle") clearInterval(timer);
    else vi.clearAllTimers();
  }, 1);
  vi.advanceTimersByTime(1);
  expect(count).toBe(1);
  expect(jest.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(20);
  expect(count).toBe(1);
  expect(otherRan).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
  timer.refresh();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
}

for (const nestedMode of ["numeric", "all"]) {
  jest.useFakeTimers({ now: 0 });
  let outerCount = 0;
  let innerCount = 0;
  const outer = setInterval(() => {
    outerCount++;
    const inner = setInterval(() => {
      innerCount++;
      if (nestedMode === "all") vi.clearAllTimers();
      else {
        clearInterval(Number(outer));
        clearInterval(Number(inner));
      }
    }, 1);
    vi.advanceTimersByTime(1);
  }, 1);
  vi.advanceTimersByTime(1);
  expect(outerCount).toBe(1);
  expect(innerCount).toBe(1);
  expect(jest.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(10);
  expect(outerCount).toBe(1);
  expect(innerCount).toBe(1);
  jest.useRealTimers();
}
console.log("running timer cancellation ok");
