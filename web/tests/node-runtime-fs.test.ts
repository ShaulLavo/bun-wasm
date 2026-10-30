import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("the Node host links runtime_fs watches and answers as Waffle does for an unwatchable filesystem", () => {
  // The fixture owns and removes its scratch directory under this root.
  const root = process.env.BUN_WASM_SCRATCH_ROOT ?? tmpdir();
  const result = spawnSync("node", ["--no-warnings", new URL("./fixtures/node-runtime-fs.ts", import.meta.url).pathname, root], {
    cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("Node runtime_fs links, answers Waffle's unwatchable-filesystem errnos and releases unstarted hosts\n");
});
