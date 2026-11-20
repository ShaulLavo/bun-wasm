import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { engineStackBudgetKey, spiderMonkeyWebKitStackKib } from "../web/src/engine-stack-budget.ts";
import { buildStandaloneSmoke } from "./spidermonkey-smoke.ts";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("installed SpiderMonkey quotas and overflow recovery on both tiers and member bounds", () => {
  const { smoke, env, remove } = buildStandaloneSmoke();
  try {
    for (const args of [["interp"], ["pbl"], ["interp", "--relocated-stack"], ["pbl", "--relocated-stack"]]) {
      // A QuickJS-sized budget is not SpiderMonkey's: the full quota still applies.
      const stdout = execFileSync("timeout", ["--kill-after=5s", "60s", "wasmtime", "run", "-W", "max-wasm-stack=16777216",
        "--env", "BUN_WASM_STACK_KIB=32", smoke].concat(args), { env, encoding: "utf8" });
      expect(stdout).toContain(`ok init tier=${args[0]}`);
      expect(stdout).toContain("ok catchable stack overflow RangeError");
      expect(stdout).toContain("ok evaluation and second recursion after caught overflow");
      expect(stdout).toContain("ok nested compile limits and recovery");
      expect(stdout).toContain("ok uncatchable interrupt inside finally; catch=0 finally=0");
      expect(stdout).toContain("ok uncatchable interrupt inside regexp; catch=0 finally=0");
      expect(stdout).toContain("ok counted reentrant recursion");
      expect(stdout).toContain("ok named getter frame storage and recovery");
      expect(stdout).toContain("ok call and apply frame storage and recovery");
      expect(stdout).toContain("ok tier evidence");
    }
    // The budget WebKit hosts pass: every reserved path is caught by the quota, then recovers.
    // A QuickJS-sized BUN_WASM_STACK_KIB alongside it must change nothing.
    for (const tier of ["interp", "pbl"]) {
      const stdout = execFileSync("timeout", ["--kill-after=5s", "60s", "wasmtime", "run", "-W", "max-wasm-stack=16777216",
        "--env", `${engineStackBudgetKey("spidermonkey")}=${spiderMonkeyWebKitStackKib}`, "--env", "BUN_WASM_STACK_KIB=32", smoke, tier],
      { env, encoding: "utf8" });
      expect(stdout).toContain(`ok init tier=${tier}`);
      expect(stdout).toContain("ok budget recursion caught and recovered on every reserved path");
    }
  } finally {
    remove();
  }
}, 440_000);
