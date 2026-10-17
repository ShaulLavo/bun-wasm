import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { exitProvenance } from "./app-matrix/exit-provenance.ts";

const root = resolve(import.meta.dir, "..");
const launcher = resolve(process.env.CARGO_TARGET_DIR ?? "/work/tmp/bun-wasm-target", "release/bun-wasm");
const cases: [string, string, number][] = [
  ["process.exit", "process.exit(7)", 7],
  ["process.reallyExit", "process.reallyExit(6)", 6],
  ["uncaught-exception", "throw new Error('exit probe')", 1],
  ["unhandled-rejection", "Promise.reject(new Error('rejection probe'))", 1],
  ["event-loop-drained", "setTimeout(() => {}, 1)", 0],
];
for (const engine of ["quickjs", "jsc", "browser"]) {
  for (const [reason, code, exit] of cases) {
    test(`${engine} records ${reason}`, () => {
      const wasm = resolve(root, "dist", engine === "quickjs" ? "bun.wasm" : `bun-${engine}.wasm`);
      const host = engine === "browser" ? ["node", "--no-warnings", resolve(root, "web/scripts/node-host.mjs")] : [launcher];
      const command = host.concat(["--wasm", wasm, "--dir", `${root}::/`, "--env", "BUN_WASM_TRACE_EXIT=1", "--", "-e", code]);
      const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 10000 });
      const parsed = exitProvenance({ code: result.exitCode, output: result.stderr.toString() });
      expect(parsed.exit).toBe(exit);
      expect(parsed.runtimeExits).toHaveLength(1);
      expect(parsed.runtimeExits[0]).toMatchObject({ reason, code: exit });
      expect(parsed.runtimeExits[0]?.stack).toBeString();
      if (reason === "event-loop-drained") expect(parsed.runtimeExits[0]?.loop).toMatchObject({ refedTimers: 0, ticks: 0, pendingIo: 0, networkHandles: 0 });
    });
  }
}
