import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runCheck } from "./test-checks.ts";

export const ordinaryFixtures: readonly string[] = [
  "cli-eval", "engine-modules", "esm-async-dependency-reimport", "cjs-interop",
  "net-serve", "self-spawn", "async-local-storage", "errors-rejection",
  "promise-rejection-identity", "host-gc-capture", "array-buffer-sink-detached", "stack-overflow", "stack-statement-nesting",
  "require-esm-caught-failure", "rejection-inspect-still-unhandled",
  "require-esm-after-lowered-import", "require-esm-after-native-import",
  "require-esm-failure-cache", "require-esm-limit-recovery",
  "stack-callsite-predicates", "stack-getter-loop", "ts-stack-trace",
];

// test.sh owns each 60s TERM / 5s KILL deadline and every output/exit assertion.
export const ordinaryFixtureTimeout = ordinaryFixtures.length * 65_000 + 30_000;

export function ordinaryFixtureCommand(repository: string, env: NodeJS.ProcessEnv, tier: "interp" | "pbl"): string[] {
  for (const name of ["SPIDERMONKEY_WASM", "BUN_WASM_LAUNCHER", "BUN_WASM_SHELL", "BUN_WASM_ENV_UTILITY"]) {
    const path = env[name];
    assert(path && isAbsolute(path), `Ordinary SpiderMonkey requires absolute ${name}`);
    accessSync(path, name === "BUN_WASM_LAUNCHER" ? constants.X_OK : constants.R_OK);
  }
  const core = env.SPIDERMONKEY_WASM;
  assert(core);
  return ["bash", join(repository, "scripts/test.sh"), "--engine", "spidermonkey", "--wasm", core, "--tier", tier].concat(ordinaryFixtures);
}

export function runAdapterControls(repository: string, env = process.env): void {
  const controls = runCheck(["bash", join(repository, "scripts/spidermonkey-engine-semantics.sh")], env);
  assert.equal(controls, 0, "SpiderMonkey engine-semantic controls failed");
}

export function runOrdinaryFixtures(repository: string, tier: "interp" | "pbl", env = process.env): void {
  const status = runCheck(ordinaryFixtureCommand(repository, env, tier), env);
  assert.equal(status, 0, `Ordinary SpiderMonkey ${tier} fixtures failed`);
}
