import { test, expect } from "bun:test";

// Bun's test runner takes uncaught exceptions itself: the program's own listener and monitor
// never run, and the error fails the test that was running.
process.on("uncaughtException", e => console.log("user listener", String(e)));
process.on("uncaughtExceptionMonitor", e => console.log("monitor", String(e)));

test("throws later", async () => {
  setTimeout(() => { throw new Error("from timer"); }, 1);
  await Bun.sleep(20);
});

test("after", () => expect(1).toBe(1));
