import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = new URL("./fixtures/node-executable-cleanup-host.ts", import.meta.url).pathname;
const prefix = "bun-wasm-node-executables-";
const runtimes = [process.execPath].concat(Bun.which("node") ?? []);

function deadPid() {
  const exited = Bun.spawnSync(["true"]);
  expect(exited.exitCode).toBe(0);
  return exited.pid;
}

for (const runtime of runtimes) for (const ending of ["0", "3", "throw"]) {
  test(`${runtime.endsWith("node") ? "Node" : "Bun"} host ending with ${ending} leaves no executable files and sweeps dead hosts' files`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-node-executable-cleanup-"));
    try {
      const dead = join(scratch, `${prefix}${deadPid()}-killed`);
      const live = join(scratch, `${prefix}${process.pid}-running`);
      mkdirSync(join(dead, "bin"), { recursive: true });
      mkdirSync(join(live, "bin"), { recursive: true });
      const host = Bun.spawnSync([runtime, fixture, ending], { env: { ...process.env, BUN_WASM_SCRATCH_ROOT: scratch }, stderr: "pipe" });
      const root = host.stdout.toString().trim();
      expect(host.exitCode, host.stderr.toString()).toBe(ending === "throw" ? 1 : Number(ending));
      expect(root.startsWith(join(scratch, prefix))).toBe(true);
      expect(existsSync(root)).toBe(false);
      expect(readdirSync(scratch)).toEqual([`${prefix}${process.pid}-running`]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
