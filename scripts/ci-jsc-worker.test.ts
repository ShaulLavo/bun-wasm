import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const linuxTest = process.platform === "linux" ? test : test.skip;

for (const scenario of ["success", "build-failure", "early-failure", "intervening-failure", "cancellation", "cancellation-int", "startup-race", "stale-pid", "never-started", "stubborn-descendant"] as const) {
  linuxTest(`JSC Cargo worker ${scenario} uses the extracted workflow and leaves no processes`, async () => {
    const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-jsc-worker-"));
    try {
      const child = Bun.spawn(["node", join(import.meta.dir, "run-with-timeout.mts"), "20", "bun", join(import.meta.dir, "fixtures/ci-jsc-worker-scenario.ts"), scenario, scratch], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain(`${scenario}: passed`);
      process.stdout.write(stdout);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 30000);
}
