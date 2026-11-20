import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { runFixturePhases } from "./fixture-phases";

function captureStderr() {
  const lines: string[] = [];
  const spy = spyOn(fs, "writeSync").mockImplementation(((fd: number, text: string) => {
    if (fd === 2) lines.push(text.trimEnd());
    return text.length;
  }) as typeof fs.writeSync);
  return { lines, restore: () => spy.mockRestore() };
}

test("a body failure is written with its phase before awaited shutdown starts, then rethrown", async () => {
  const output = captureStderr();
  const failure = new Error("click never landed");
  let shutdownSawFailure = false;
  try {
    const run = runFixturePhases("fixture", async enter => {
      enter("trusted-click");
      throw failure;
    }, async enter => {
      shutdownSawFailure = output.lines.some(line => line.includes("failed in trusted-click") && line.includes("click never landed"));
      enter("browser-close");
    });
    await expect(run).rejects.toBe(failure);
  } finally { output.restore(); }
  expect(shutdownSawFailure).toBe(true);
  expect(output.lines.at(-1)).toBe("[fixture fixture] shutdown-end");
});

test("a passing body records each phase and a shutdown failure names its phase", async () => {
  const output = captureStderr();
  const failure = new Error("close stuck");
  try {
    const run = runFixturePhases("fixture", async enter => { enter("launch"); }, async enter => {
      enter("browser-close");
      throw failure;
    });
    await expect(run).rejects.toBe(failure);
  } finally { output.restore(); }
  expect(output.lines.slice(0, 4)).toEqual(["[fixture fixture] start", "[fixture fixture] launch", "[fixture fixture] body-passed", "[fixture fixture] shutdown-start"]);
  expect(output.lines.at(-1)).toStartWith("[fixture fixture] shutdown failed in browser-close: Error: close stuck");
});
