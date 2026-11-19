import { describe, test } from "bun:test";

// A callback that awaits only settled promises never really waits, so the next concurrent
// test starts only after it finishes, as in Bun.
describe("settled awaits", () => {
  for (const name of ["e", "f"]) {
    test.concurrent(name, async () => {
      console.log(`${name}1`);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      console.log(`${name}2`);
    });
  }
});
