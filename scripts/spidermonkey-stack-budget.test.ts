import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("SpiderMonkey stack settings stay positive and inside member bounds", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sm-budget-"));
  try {
    const root = resolve(import.meta.dir, "../crates/bunwasm-spidermonkey");
    const executable = join(scratch, "stack-budget");
    execFileSync("c++", ["-std=c++17", "-O2", "-I", join(root, "cpp"), join(root, "tests/stack-budget.cpp"), "-o", executable]);
    expect(execFileSync(executable, { encoding: "utf8" })).toContain("ok positive decimal quotas");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
