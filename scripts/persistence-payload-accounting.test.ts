import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("persistence fixture distinguishes IndexedDB metadata from byte-bearing records", async () => {
  const result = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../web/tests/browser-persistence.ts"),
    "chromium",
  ], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      PERSIST_PAYLOAD_ACCOUNTING: "1",
      PERSIST_SMOKE: "1",
      PERSIST_STORAGE: "indexeddb",
      PERSISTENCE_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    result.exited,
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
  ]);
  expect(status, `${stdout}\n${stderr}`).toBe(0);
});
