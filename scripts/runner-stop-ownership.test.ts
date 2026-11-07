import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

for (const mode of ["synchronous", "delayed", "rejected"]) test(`logical root exit retains ${mode} physical-stop ownership through page disposal`, () => {
  const result = spawnSync(process.execPath, [new URL("../web/tests/fixtures/runner-stop-probe.ts", import.meta.url).pathname, mode], { encoding: "utf8", timeout: 3000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`PASS manual root stop ${mode}`);
});
