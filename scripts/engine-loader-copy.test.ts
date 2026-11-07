import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("build-qualified streaming engines reuse one source snapshot for declarations and verified cache storage", () => {
  const result = spawnSync(process.execPath, [new URL("../web/tests/fixtures/engine-loader-copy-probe.ts", import.meta.url).pathname], { encoding: "utf8", timeout: 3000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain("PASS one owned engine source snapshot");
});
