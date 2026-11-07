import { expect, test } from "bun:test";
import { assertProductionBrowserEvents, finishProduction } from "./next-production-controls";

test("production acceptance rejects React hydration console errors", () => {
  expect(() => assertProductionBrowserEvents(["preview error: Hydration failed because the server rendered HTML did not match the client."])).toThrow();
});

test("production acceptance rejects failed JavaScript requests even with successful assets", () => {
  expect(() => assertProductionBrowserEvents(["preview requestfailed: http://preview/_next/static/page.js net::ERR_FAILED"])).toThrow();
});

test("a pending terminal read cannot prevent foreground and session cleanup", async () => {
  const terminal = Promise.withResolvers<string>();
  const calls: string[] = [];
  const done = finishProduction({
    readTerminal: () => terminal.promise,
    writeTerminal: () => calls.push("terminal"),
    stopForeground: async () => { calls.push("stop"); },
    close: async () => { calls.push("close"); },
    readTimeoutMs: 1,
  }).catch((error: unknown) => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toEqual(["stop", "close"]);
  } finally {
    terminal.resolve("late transcript");
    expect(await done).toMatchObject({ message: "Production terminal read timed out" });
  }
});

test("production acceptance keeps ordinary console output and warnings", () => {
  expect(() => assertProductionBrowserEvents(["preview log: this text contains error: but is not an error", "preview warning: diagnostic"])).not.toThrow();
});

for (const event of ["playground error: bootstrap failed", "preview pageerror: TypeError", "preview assert: failed assertion"]) {
  test(`production acceptance rejects ${event}`, () => {
    expect(() => assertProductionBrowserEvents([event])).toThrow();
  });
}

test("failed foreground cleanup still closes the browser and preserves the first error", async () => {
  const first = new Error("transcript failed");
  const calls: string[] = [];
  await expect(finishProduction({
    readTerminal: async () => { throw first; },
    writeTerminal: () => calls.push("terminal"),
    stopForeground: async () => { calls.push("stop"); throw new Error("stop failed"); },
    close: async () => { calls.push("close"); },
  })).rejects.toBe(first);
  expect(calls).toEqual(["stop", "close"]);
});

test("normal production teardown records the transcript before stopping and closing", async () => {
  const calls: string[] = [];
  await finishProduction({
    readTerminal: async () => "transcript",
    writeTerminal: text => calls.push(text),
    stopForeground: async () => { calls.push("stop"); },
    close: async () => { calls.push("close"); },
  });
  expect(calls).toEqual(["transcript", "stop", "close"]);
});
