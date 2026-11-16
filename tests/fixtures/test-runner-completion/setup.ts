import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from "bun:test";

console.log("preload evaluated");
beforeAll(() => console.log("global setup"));
afterAll(() => console.log("global teardown"));
beforeEach(() => console.log("before each"));
afterEach(() => console.log("after each"));
for (const [name, register] of [["test", test], ["describe", describe]] as const) {
  try {
    register("forbidden preload declaration", () => {});
    throw new Error("preload declaration was accepted");
  } catch (error) {
    console.log(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
