import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probeSource = (enabled: boolean) => `import { afterAll, expect } from "bun:test";
import { dlopen, ptr } from "bun:ffi";
const libc = dlopen("libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } });
function state() {
  const value = new Int32Array(1);
  if (libc.symbols.prctl(37, ptr(value), 0, 0, 0) !== 0) throw new Error("cannot read child subreaping");
  return value[0];
}
if (libc.symbols.prctl(36, ${Number(enabled)}, 0, 0, 0) !== 0) throw new Error("cannot set initial child subreaping");
const initial = state();
afterAll(() => {
  const final = state();
  libc.close();
  expect(final, "test suite leaked child subreaping").toBe(initial);
});
`;

const suites = ["controller.test.ts", "process.test.ts", "../runtime-js-controls.test.ts"];
const cases = suites.flatMap(suite => [false, true].map(enabled => ({ suite, enabled })));
for (const { suite, enabled } of cases) {
  test.skipIf(process.platform !== "linux")(`${suite} preserves child subreaping ${Number(enabled)}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "subreaper-probe-"));
    try {
      const probe = join(scratch, "probe.ts");
      writeFileSync(probe, probeSource(enabled));
      const result = spawnSync(process.execPath, ["test", "--preload", probe, join(import.meta.dir, suite)], { encoding: "utf8", timeout: 30000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 30000);
}
