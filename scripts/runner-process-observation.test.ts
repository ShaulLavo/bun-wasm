import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

for (const mode of ["held", "void", "fulfilled", "throw", "reject", "reject-falsy", "reentrant"]) test(`real CPU root observes native return: ${mode}`, () => {
  const result = spawnSync(process.execPath, [new URL("../web/tests/fixtures/runner-observation-probe.ts", import.meta.url).pathname, mode], { encoding: "utf8", timeout: 5000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`PASS CPU root observation ${mode}`);
});
