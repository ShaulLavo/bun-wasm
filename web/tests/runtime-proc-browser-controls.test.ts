import { expect, test } from "bun:test";
import { resolve } from "node:path";

const driver = resolve(import.meta.dir, "browser-runtime-proc.ts");
function checkControls(overrides: Record<string, string>) {
  // Invalid controls and the deliberately unknown browser fail before scratch, listeners,
  // or browser processes are created. These subprocesses need no browser installation.
  return Bun.spawnSync({
    cmd: [process.execPath, driver, "not-a-browser"],
    env: { ...process.env, RUNTIME_PROC_ITERATIONS: "1", RUNTIME_PROC_MODE: "automatic", RUNTIME_PROC_SCENARIO: "job-wait", ...overrides },
    stdout: "pipe", stderr: "pipe",
  });
}

for (const value of ["0", "1001", "1.5", "NaN", "Infinity"]) test(`runtime_proc stress rejects invalid repeat count ${value} before setup`, () => {
  const result = checkControls({ RUNTIME_PROC_ITERATIONS: value });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("AssertionError: bounded positive repeat count required");
});

for (const [name, message] of [
  ["RUNTIME_PROC_MODE", "known runtime_proc mode required"],
  ["RUNTIME_PROC_SCENARIO", "known runtime_proc scenario required"],
] as const) test(`runtime_proc stress rejects unknown ${name} before setup`, () => {
  const result = checkControls({ [name]: "unknown" });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain(`AssertionError: ${message}`);
});

for (const value of ["1", "1000"]) test(`runtime_proc stress accepts bounded repeat count ${value}`, () => {
  const result = checkControls({ RUNTIME_PROC_ITERATIONS: value });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("unknown browser not-a-browser");
});
