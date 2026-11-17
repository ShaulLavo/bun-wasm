import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// Each tick resolves after one timer turn, in the order the ticks were requested.
const waiting: (() => void)[] = [];
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  waiting.push(resolve);
  setTimeout(() => waiting.shift()?.(), 0);
  return promise;
}

test("serial 1", async () => {
  console.log("start serial 1");
  await tick();
  console.log("end serial 1");
});
test.concurrent("concurrent 2", async () => {
  console.log("start concurrent 2");
  await tick();
  console.log("end concurrent 2");
});
test.concurrent("concurrent 3", async () => {
  console.log("start concurrent 3");
  await tick();
  console.log("end concurrent 3");
});
test.serial("serial 4", () => {
  console.log("serial 4 runs alone");
});
test.concurrent("concurrent 5", async () => {
  console.log("start concurrent 5");
  await tick();
  await tick();
  console.log("end concurrent 5");
});
// A concurrent describe joins the group, and each test runs its own beforeEach.
describe.concurrent("group", () => {
  beforeEach(async () => {
    console.log("start beforeEach");
    await tick();
    console.log("end beforeEach");
  });
  test("concurrent 6", async () => {
    console.log("start concurrent 6");
    await tick();
    console.log("end concurrent 6");
  });
  test.serial("serial 7 opts out", () => {
    console.log("serial 7 runs alone");
  });
});
// beforeAll ends a group: these two run together, after it.
describe("with beforeAll", () => {
  beforeAll(() => {
    console.log("beforeAll runs alone");
  });
  afterAll(() => {
    console.log("afterAll runs alone");
  });
  test.concurrent("concurrent 8", async () => {
    console.log("start concurrent 8");
    await tick();
    console.log("end concurrent 8");
  });
  test.concurrent("concurrent 9", async () => {
    console.log("start concurrent 9");
    await tick();
    console.log("end concurrent 9");
  });
});

// Assertions after an await still belong to their own test.
describe("attribution", () => {
  test.concurrent("a failing assertion fails its own test", async () => {
    await tick();
    await tick();
    expect(1).toBe(2);
  });
  test.concurrent("an inline snapshot after an await", async () => {
    await tick();
    expect({ value: 1 }).toMatchInlineSnapshot(`
{
  "value": 1,
}
`);
  });
  test.concurrent.failing("concurrent failing", async () => {
    await tick();
    throw new Error("expected failure");
  });
});

test("a serial test ends the attribution group", () => {});

// At most 20 tests run at once by default; each beforeEach logs how many are running.
let running = 0;
const peaks: number[] = [];
describe("default limit", () => {
  beforeEach(() => {
    running++;
    peaks.push(running);
  });
  afterEach(() => {
    running--;
  });
  test.concurrent.each(Array.from({ length: 25 }, (_, i) => i))("limited %d", async () => {
    await tick();
  });
});
test("peaks", () => {
  console.log(`peaks ${JSON.stringify(peaks)}`);
});

// Concurrent tests that never wait run one after another, each with its hooks.
describe("immediate", () => {
  beforeEach(() => {
    console.log("immediate beforeEach");
  });
  afterEach(async () => {
    console.log("immediate afterEach");
  });
  test.concurrent("immediate 1", () => {
    console.log("immediate 1");
  });
  test.concurrent("immediate 2", async () => {
    console.log("immediate 2");
  });
});

test("modifier variants are the same function on every access", () => {
  expect(test.concurrent).toBe(test.concurrent);
  expect(test.failing).toBe(test.failing);
  expect(describe.serial).toBe(describe.serial);
});
