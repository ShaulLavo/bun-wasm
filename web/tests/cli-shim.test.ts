import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliShimFixture } from "./cli-shim-fixture";

for (const mode of ["exit", "signal"] as const) {
  test(`CLI shim links runtime_proc and preserves ${mode}`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-cli-shim-"));
    try {
      const path = join(scratch, "guest.wasm");
      await writeFile(path, cliShimFixture(mode));
      const child = Bun.spawn(["node", "../scripts/run-with-timeout.mts", "10", "bun", "scripts/run.ts", path], {
        cwd: join(import.meta.dir, ".."), env: { ...process.env, NET: "0" }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout, stderr }).toEqual({ code: mode === "signal" ? 130 : 0, stdout: mode === "signal" ? "" : "cli-shim-ok\n", stderr: "" });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 20_000);
}
