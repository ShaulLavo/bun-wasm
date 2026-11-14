import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { standaloneSmoke } from "./spidermonkey-smoke.ts";

test("installed SpiderMonkey quotas and overflow recovery on both tiers and member bounds", () => {
  const { smoke, env } = standaloneSmoke();
  for (const args of [["interp"], ["pbl"], ["interp", "--relocated-stack"], ["pbl", "--relocated-stack"]]) {
    const stdout = execFileSync("timeout", ["--kill-after=5s", "60s", "wasmtime", "run", "-W", "max-wasm-stack=16777216", smoke].concat(args),
      { env, encoding: "utf8" });
    expect(stdout).toContain(`ok init tier=${args[0]}`);
    expect(stdout).toContain("ok catchable stack overflow RangeError");
    expect(stdout).toContain("ok evaluation and second recursion after caught overflow");
    expect(stdout).toContain("ok nested compile limits and recovery");
    expect(stdout).toContain("ok uncatchable interrupt inside finally; catch=0 finally=0");
    expect(stdout).toContain("ok counted reentrant recursion");
    expect(stdout).toContain("ok tier evidence");
  }
}, 440_000);
