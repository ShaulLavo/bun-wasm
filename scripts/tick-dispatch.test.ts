import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Control = {
  run(probes: number, cached: number, mode: number): number;
  allocations(): number;
  frees(): number;
  calls(): number;
};

function control(module: WebAssembly.Module): Control {
  const { exports } = new WebAssembly.Instance(module);
  const { run, allocations, frees, calls } = exports;
  if (typeof run !== "function" || typeof allocations !== "function"
    || typeof frees !== "function" || typeof calls !== "function") throw new Error("Missing control exports");
  return {
    run: (probes, cached, mode) => Number(run(probes, cached, mode)),
    allocations: () => Number(allocations()),
    frees: () => Number(frees()),
    calls: () => Number(calls()),
  };
}

test("tick packet reuses allocations while preserving every dispatch and consumed boolean", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ticks-"));
  try {
    const wasm = join(scratch, "control.wasm");
    const compile = Bun.spawnSync(["rustc", "--edition=2024", "--target=wasm32-unknown-unknown",
      "--crate-type=cdylib", "-O", "-D", "warnings", "tests/controls/tick-dispatch.rs", "-o", wasm],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(compile.stderr.toString()).toBe("");
    expect(compile.exitCode).toBe(0);
    const module = new WebAssembly.Module(readFileSync(wasm));
    const probes = 10_000;
    const baseline = control(module), cached = control(module);
    expect(baseline.run(probes, 0, 0)).toBe(3334);
    expect(cached.run(probes, 1, 0)).toBe(3334);
    expect([baseline.calls(), cached.calls()]).toEqual([probes, probes]);
    expect([baseline.allocations(), cached.allocations()]).toEqual([2 * probes, 2]);
    expect([baseline.frees(), cached.frees()]).toEqual([3 * probes, probes + 2]);
    expect(cached.run(0, 1, 0)).toBe(0);
    expect([cached.allocations(), cached.frees(), cached.calls()]).toEqual([0, 0, 0]);
    verifyFailures(module);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

function verifyFailures(module: WebAssembly.Module): void {
  for (const mode of [1, 2, 3]) {
    const baseline = control(module), cached = control(module);
    expect(() => baseline.run(1, 0, mode)).toThrow();
    expect(() => cached.run(1, 1, mode)).toThrow();
    expect([baseline.calls(), cached.calls()]).toEqual([1, 1]);
  }
}
