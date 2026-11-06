import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxProcess } from "../process-owner.mts";
import { runSubreaperProbe } from "../test-subreaper-command.ts";

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
      const result = runSubreaperProbe(["test", "--preload", probe, join(import.meta.dir, suite)]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 30000);
}

async function waitGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && linuxProcess(pid); attempt++) await Bun.sleep(25);
}

test.skipIf(process.platform !== "linux")("a timed-out probe drains its detached descendants", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "subreaper-timeout-"));
  const marker = join(scratch, "child.pid");
  let child: ReturnType<typeof linuxProcess>;
  try {
    const code = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(code)}], { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000);`;
    const result = runSubreaperProbe(["-e", parent], 2000);
    expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
    expect(existsSync(marker)).toBe(true);
    const pid = Number(readFileSync(marker, "utf8"));
    child = linuxProcess(pid);
    await waitGone(pid);
    expect(linuxProcess(pid), "probe left a detached descendant after timeout").toBeUndefined();
  } finally {
    const current = child && linuxProcess(child.pid);
    if (child && current?.birth === child.birth && current.state !== "Z") process.kill(child.pid, "SIGKILL");
    if (child) await waitGone(child.pid);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 10000);

test.skipIf(process.platform !== "linux")("probe supervision preserves an ordinary nonzero status", () => {
  const result = runSubreaperProbe(["-e", "process.exit(7)"]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(7);
});
