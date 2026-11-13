import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("provider quota bridge rejects a native write, resets and propagates host errors", async () => {
  const child = Bun.spawn([
    "node", resolve(import.meta.dir, "run-with-timeout.mts"), "25",
    process.execPath, resolve(import.meta.dir, "../web/tests/browser-persistence.ts"), "chromium",
  ], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, PERSIST_QUOTA_CONTROL: "1", PERSIST_SMOKE: "1", PERSISTENCE_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(status, `${stdout}\n${stderr}`).toBe(0);
}, 40_000);
