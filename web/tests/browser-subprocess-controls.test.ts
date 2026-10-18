import { expect, test } from "bun:test";
import { resolve } from "node:path";

const driver = resolve(import.meta.dir, "browser-subprocess.ts");

for (const repeat of ["0", "-1", "1.5", "NaN", "Infinity", "1001"]) {
  test(`subprocess driver rejects repeat ${repeat} before browser setup`, () => {
    const result = Bun.spawnSync([process.execPath, driver, `--repeat=${repeat}`]);
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("--repeat must be an integer from 1 to 1000");
  });
}

test("subprocess driver rejects an unknown engine before browser setup", () => {
  const result = Bun.spawnSync([process.execPath, driver, "--engine=unknown"]);
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("--engine must be quickjs, jsc or browser");
});

test("subprocess driver rejects an unknown browser before browser setup", () => {
  const result = Bun.spawnSync([process.execPath, driver, "unknown"]);
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("unsupported browser: unknown");
});
