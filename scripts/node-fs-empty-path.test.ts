import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("filesystem paths preserve empty input at the native boundary", () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-fs-empty-"));
  try {
    const options = readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_options.ts", import.meta.url), "utf8");
    const generated = join(scratch, "fs-options.js");
    writeFileSync(generated, new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${options}`));
    const result = Bun.spawnSync(["node", new URL("./node-fs-empty-path-source.ts", import.meta.url).pathname, generated], {
      cwd: scratch, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
