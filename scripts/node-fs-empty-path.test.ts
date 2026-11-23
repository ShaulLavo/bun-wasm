import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("filesystem paths preserve empty input at the native boundary", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-fs-empty-"));
  try {
    const options = readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_options.ts", import.meta.url), "utf8");
    const generated = join(scratch, "fs-options.js");
    writeFileSync(generated, new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${options}`));
    const buffersReaddir = readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_buffers_readdir.ts", import.meta.url), "utf8");
    const generatedBuffers = join(scratch, "fs-buffers-readdir.js");
    writeFileSync(generatedBuffers, new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${buffersReaddir}`));
    const result = Bun.spawnSync(["node", new URL("./node-fs-empty-path-source.ts", import.meta.url).pathname, generated, generatedBuffers], {
      cwd: scratch, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
