import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memorySampler } from "./memory";

async function waitForBrowserChild(pid: number): Promise<void> {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const command = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    const pss = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+) kB$/m)?.[1];
    if (command === "headless_shell" && pss && Number(pss) > 0) return;
    await Bun.sleep(1);
  }
  throw new Error("Child did not become a sampleable browser process");
}

test("memory sampler retains a sampled child peak until take and resets it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-memory-"));
  const executable = join(directory, "headless_shell");
  symlinkSync("/usr/bin/sleep", executable);
  const child = spawn(executable, ["60"]);
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const setInterval = spyOn(globalThis, "setInterval");
  const sampler = memorySampler(process.pid, 60_000);
  try {
    await once(child, "spawn");
    if (child.pid === undefined) throw new Error("Child has no process ID");
    await waitForBrowserChild(child.pid);
    const sample = setInterval.mock.calls[0]?.[0];
    if (typeof sample !== "function") throw new Error("Sampler did not schedule a callback");
    sample();
    child.kill();
    await closed;
    expect(sampler.take()).toBeGreaterThan(0);
    expect(sampler.take()).toBe(0);
  } finally {
    sampler.stop();
    setInterval.mockRestore();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("memory sampler stop clears its own interval", () => {
  const setInterval = spyOn(globalThis, "setInterval");
  const clearInterval = spyOn(globalThis, "clearInterval");
  const sampler = memorySampler(process.pid, 60_000);
  try {
    sampler.stop();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(setInterval.mock.results[0]?.value);
  } finally {
    sampler.stop();
    setInterval.mockRestore();
    clearInterval.mockRestore();
  }
});
