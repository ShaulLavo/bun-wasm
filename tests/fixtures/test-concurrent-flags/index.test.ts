import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Run with --concurrent --max-concurrency 3: tests are concurrent unless marked serial, and at
// most three run at once.
const waiting: (() => void)[] = [];
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  waiting.push(resolve);
  setTimeout(() => waiting.shift()?.(), 0);
  return promise;
}

let running = 0;
const peaks: number[] = [];
describe("limited", () => {
  beforeEach(() => {
    running++;
    peaks.push(running);
  });
  afterEach(() => {
    running--;
  });
  test.each(Array.from({ length: 6 }, (_, i) => i))("default concurrent %d", async () => {
    await tick();
  });
});

test.serial("serial runs alone", () => {
  expect(running).toBe(0);
  console.log(`peaks ${JSON.stringify(peaks)}`);
});

test("a", async () => {
  console.log("start a");
  await tick();
  console.log("end a");
});
test("b", async () => {
  console.log("start b");
  await tick();
  console.log("end b");
});
