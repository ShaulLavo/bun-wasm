import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

test("installed SpiderMonkey quotas and overflow recovery on both tiers and member bounds", () => {
  const build = process.env.SPIDERMONKEY_BUILD_DIR;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  assert(build && isAbsolute(build), "Set SPIDERMONKEY_BUILD_DIR to the ordinary native build");
  assert(sysroot && isAbsolute(sysroot), "Source env.sh before the quota check");
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sm-quota-"));
  try {
    symlinkSync(join(build, "libspidermonkey_bunwasm.a"), join(scratch, "libspidermonkey_g2.a"));
    const env = {
      ...process.env,
      SPIDERMONKEY_G2_DIR: scratch,
      CARGO_TARGET_DIR: join(scratch, "target"),
      BUN_WASM_PROGRAM_PROFILE: "split",
      CXXFLAGS_wasm32_wasip1: `--sysroot=${sysroot} -fPIC -fno-exceptions`,
      CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: `-C relocation-model=pic -C panic=abort -C link-self-contained=no -L native=${sysroot}/lib/wasm32-wasip1`,
    };
    execFileSync("timeout", ["--kill-after=5s", "180s", "cargo", "build", "--locked", "--release", "-j", "2",
      "--target", "wasm32-wasip1", "-p", "bunwasm-spidermonkey", "--features", "standalone", "--example", "smoke"],
    { cwd: resolve(import.meta.dir, ".."), env, stdio: "pipe" });
    const smoke = join(env.CARGO_TARGET_DIR, "wasm32-wasip1/release/examples/smoke.wasm");
    for (const args of [["interp"], ["pbl"], ["interp", "--relocated-stack"], ["pbl", "--relocated-stack"]]) {
      const stdout = execFileSync("timeout", ["--kill-after=5s", "60s", "wasmtime", "run", "-W", "max-wasm-stack=16777216", smoke].concat(args),
        { env, encoding: "utf8" });
      expect(stdout).toContain(`ok init tier=${args[0]}`);
      expect(stdout).toContain("ok catchable stack overflow RangeError");
      expect(stdout).toContain("ok evaluation and second recursion after caught overflow");
      expect(stdout).toContain("ok nested compile limits and recovery");
      expect(stdout).toContain("ok uncatchable interrupt inside finally; catch=0 finally=0");
      expect(stdout).toContain("ok counted reentrant recursion");
      expect(stdout).toContain("ok named getter frame storage and recovery");
      expect(stdout).toContain("ok call and apply frame storage and recovery");
      expect(stdout).toContain("ok tier evidence");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 440_000);
