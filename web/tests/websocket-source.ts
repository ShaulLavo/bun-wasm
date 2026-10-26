import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function websocketSource(): string {
  const root = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = mkdtempSync(join(root, "bun-wasm-websocket-"));
  try {
    const output = join(scratch, "websocket.js");
    const compiled = Bun.spawnSync([
      "node", "--no-warnings", fileURLToPath(new URL("../../scripts/transpile-runtime.ts", import.meta.url)),
      fileURLToPath(new URL("../../crates/bunwasm-runtime/src/js/websocket.ts", import.meta.url)), output,
    ]);
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
    return readFileSync(output, "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
