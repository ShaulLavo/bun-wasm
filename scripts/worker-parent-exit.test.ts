import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/worker-parent-exit.ts", import.meta.url));

async function nativeExit(executable: string, scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-worker-parent-exit-"));
  const file = join(directory, "heartbeat.log");
  const child = spawn(executable, [fixture, "parent", scenario, file], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const status = await closed;
    expect(status.signal).toBeNull();
    expect(status.code).toBe(scenario === "throw" && executable !== "node" ? 1 : 0);
    expect(stderr.includes("exit listener failure")).toBe(scenario === "throw");
    const before = readFileSync(file, "utf8");
    expect(before).toContain("start\n");
    await delay(200);
    expect(readFileSync(file, "utf8")).toBe(before);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const executable of ["node", process.execPath]) {
  for (const scenario of ["throw", "late"]) {
    test(`native worker lifetime after ${scenario} exit listener under ${executable}`, () => nativeExit(executable, scenario), 10000);
  }
}
