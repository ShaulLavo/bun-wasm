import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definition } from "./spidermonkey-native-controls.ts";
import { discoverChecks, selectChecks } from "./test-checks.ts";

test("the actual Rust selector defaults to PBL and preserves explicit environment values", () => {
  const adapter = readFileSync("crates/bunwasm-engine-spidermonkey/src/vm.rs", "utf8");
  const selector = definition(adapter, "tier: match ").slice("tier: ".length);
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-tier-"));
  try {
    const input = join(root, "selector.rs");
    const output = join(root, "selector");
    writeFileSync(input, `fn main() { println!("{}", ${selector}); }\n`);
    const build = Bun.spawnSync(["rustup", "run", "stable", "rustc", "--edition=2024", input, "-o", output]);
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);
    for (const [value, expected] of [[undefined, 1], ["pbl", 1], ["interp", 0], ["", 0], ["PBL", 0], ["unknown", 0]] as const) {
      const env = { ...process.env };
      delete env.BUN_WASM_SPIDERMONKEY_TIER;
      if (value !== undefined) env.BUN_WASM_SPIDERMONKEY_TIER = value;
      const run = Bun.spawnSync([output], { env });
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toBe(`${expected}\n`);
    }
    if (process.platform === "win32") return;
    const invalid = Bun.spawnSync(["python3", "-c", "import os, sys; os.environb[b'BUN_WASM_SPIDERMONKEY_TIER'] = b'\\xff'; os.execv(sys.argv[1], [sys.argv[1]])", output]);
    expect(invalid.stderr.toString()).toBe("");
    expect(invalid.exitCode).toBe(0);
    expect(invalid.stdout.toString()).toBe("0\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("default activation has one blocking runtime owner without adding a local build", () => {
  const checks = discoverChecks();
  const path = "scripts/spidermonkey-pbl-activation.test.ts";
  expect(checks.filter(check => check.path === path)).toHaveLength(1);
  expect(selectChecks("runtime", checks)).toContain(path);
  expect(selectChecks("quality", checks)).not.toContain(path);
  expect(selectChecks("local-runtime", checks)).not.toContain(path);
});
