import { test, expect } from "bun:test";

// Bun's test runner takes uncaught exceptions itself: the program's own listener and monitor
// never run, and the error fails the test that was running.
process.on("uncaughtException", e => console.log("user listener", String(e)));
process.on("uncaughtExceptionMonitor", e => console.log("monitor", String(e)));

test("throws later", async () => {
  // A failed expect, which every engine reports at the same source position.
  setTimeout(() => {
    expect("from timer").toBe("caught");
  }, 1);
  await Bun.sleep(20);
});

test("after", () => expect(1).toBe(1));
