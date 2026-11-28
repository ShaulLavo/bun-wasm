import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { join } from "node:path";

test("preserves BUN_OPTIONS and forks cleanly", async () => {
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
});
