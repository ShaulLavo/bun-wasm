import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { join } from "node:path";

test("fork succeeds under bun --parallel=2 test", async () => {
  const message = await new Promise<{ execArgv: string[]; argv: string[] }>((resolve, reject) => {
    const child = fork(join(import.meta.dir, "child.ts"), ["ok"]);
    child.on("message", payload => resolve(payload as { execArgv: string[]; argv: string[] }));
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) reject(new Error(`fork exited with ${code}`));
    });
  });
  expect(message).toEqual({ execArgv: [], argv: ["ok"] });
});
