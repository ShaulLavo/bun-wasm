import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function netAddressSource(): string {
  if (cached !== undefined) return cached;
  const root = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = mkdtempSync(join(root, "bun-wasm-net-address-"));
  try {
    const output = join(scratch, "net_address.js");
    const compiled = Bun.spawnSync([
      "node", "--no-warnings", fileURLToPath(new URL("./transpile-runtime.ts", import.meta.url)),
      fileURLToPath(new URL("../crates/bunwasm-runtime/src/js/net_address.ts", import.meta.url)), output,
    ]);
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
    cached = readFileSync(output, "utf8");
    return cached;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
