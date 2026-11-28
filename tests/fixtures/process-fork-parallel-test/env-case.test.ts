import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

test("preserves BUN_OPTIONS, nested bun test, and explicit env while forking and starting workers cleanly", async () => {
  expect(process.env.BUN_OPTIONS).toBe("--parallel=2");
  const message = await new Promise<{ execArgv: string[]; argv: string[]; bunOptions: string | null }>((resolve, reject) => {
    const child = fork(join(import.meta.dir, "child.ts"), ["env-ok"]);
    child.on("message", payload => resolve(payload as { execArgv: string[]; argv: string[]; bunOptions: string | null }));
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) reject(new Error(`fork exited with ${code}`));
    });
  });
  expect(message).toEqual({ execArgv: [], argv: ["env-ok"], bunOptions: null });

  const workerResult = await new Promise<{ ok: boolean; bunOptions: string | null }>((resolve, reject) => {
    const worker = new Worker(join(import.meta.dir, "worker-child.ts"));
    worker.on("message", payload => resolve(payload as { ok: boolean; bunOptions: string | null }));
    worker.on("error", reject);
    worker.on("exit", code => {
      if (code !== 0) reject(new Error(`worker exited with ${code}`));
    });
  });
  expect(workerResult).toEqual({ ok: true, bunOptions: null });

  const dashDash = Bun.spawnSync([process.execPath, "--", "test"], {
    cwd: join(import.meta.dir, "dashdash"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(dashDash.exitCode).toBe(0);
  expect(dashDash.stdout.toString().trim()).toBe("dashdash-test-ok");

  const nested = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "nested-env-case.test.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(nested.exitCode).toBe(0);

  const explicit = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "nested-env-case.test.ts")], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(explicit.exitCode).toBe(0);
});
