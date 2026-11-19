import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sccache keys each Rust compile by its working directory and every CARGO_* variable, including
// CARGO_TARGET_DIR. A random mkdtemp target therefore never hits the compiler cache, so checks
// that run Cargo use one fixed, emptied directory per check name instead. Do not run two copies
// of the same check at once in one runner temp directory.
export function stableScratch(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid stable scratch name: ${name}`);
  const scratch = join(process.env.RUNNER_TEMP || tmpdir(), "bun-wasm-stable-scratch", name);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  return scratch;
}
