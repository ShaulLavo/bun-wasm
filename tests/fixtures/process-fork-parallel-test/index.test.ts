import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { join } from "node:path";

test("fork succeeds under bun --parallel=2 test", async () => {
  const message = await new Promise<{ execArgv: string[]; argv: string[]; bunOptions: string | null }>((resolve, reject) => {
    const child = fork(join(import.meta.dir, "child.ts"), ["ok"]);
    child.on("message", payload => resolve(payload as { execArgv: string[]; argv: string[]; bunOptions: string | null }));
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) reject(new Error(`fork exited with ${code}`));
    });
  });
  expect(message).toEqual({ execArgv: [], argv: ["ok"], bunOptions: null });
});

test("BUN_OPTIONS=--parallel=2 stays readable in test and forks cleanly", () => {
  const result = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "env-case.test.ts")], {
    env: { ...process.env, BUN_OPTIONS: "--parallel=2" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
});
