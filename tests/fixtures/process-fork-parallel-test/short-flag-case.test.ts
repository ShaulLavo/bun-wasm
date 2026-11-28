import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { join } from "node:path";

test("does not strip --parallel=2 when it is a short flag value", async () => {
  expect(process.env.BUN_OPTIONS).toBe("-u --parallel=2");
  const message = await new Promise<{ execArgv: string[]; argv: string[]; bunOptions: string | null }>((resolve, reject) => {
    const child = fork(join(import.meta.dir, "child.ts"), ["short-ok"]);
    child.on("message", payload => resolve(payload as { execArgv: string[]; argv: string[]; bunOptions: string | null }));
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) reject(new Error(`fork exited with ${code}`));
    });
  });
  expect(message).toEqual({
    execArgv: ["-u", "--parallel=2", "-u", "--parallel=2"],
    argv: ["short-ok"],
    bunOptions: "-u --parallel=2",
  });
});
