import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sccache keys each Rust compile by its working directory and every CARGO_* variable, including
// CARGO_TARGET_DIR. A random mkdtemp target therefore never hits the compiler cache, so checks
// that run Cargo in GitHub Actions (RUNNER_TEMP is set, one job per runner) use one fixed, emptied directory
// per check name instead. Do not run two copies of the same check at once in one runner temp
// directory.
//
// Everywhere else (a developer machine, several lanes on one host) there is no sccache to hit, and
// a fixed path makes concurrent runs delete each other's Cargo target. There every call gets its
// own fresh directory, removed when the process exits.
export function stableScratch(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid stable scratch name: ${name}`);
  const runnerTemp = process.env.RUNNER_TEMP;
  // RUNNER_TEMP alone is not proof of CI: a developer can export it locally.
  if (runnerTemp && process.env.GITHUB_ACTIONS === "true") {
    const scratch = join(runnerTemp, "bun-wasm-stable-scratch", name);
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    return scratch;
  }
  const scratch = mkdtempSync(join(tmpdir(), `bun-wasm-scratch-${name}-`));
  // Callers remove the directory in their own cleanup; this covers a failure or an exit before it.
  process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));
  return scratch;
}
