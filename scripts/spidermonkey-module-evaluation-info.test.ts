import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

test("native module evaluation query preserves state and error classification on both tiers", () => {
  const build = process.env.SPIDERMONKEY_BUILD_DIR;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  const sdk = process.env.WASI_SDK_PATH;
  assert(build && isAbsolute(build), "Set SPIDERMONKEY_BUILD_DIR to the ordinary native build");
  assert(sysroot && sdk, "Source env.sh before native query controls");
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sm-module-info-"));
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
      "--target", "wasm32-wasip1", "-p", "bunwasm-spidermonkey", "--features", "standalone", "--lib"],
    { cwd: resolve(import.meta.dir, ".."), env, stdio: "pipe" });
    const compiler = join(sdk, "bin/clang++");
    const flags = [`--sysroot=${sysroot}`, "-std=c++20", "-fno-exceptions", "-fno-rtti", "-Os",
      "-include", join(build, "obj/js/src/js-confdefs.h"), "-I", join(build, "obj/dist/include")];
    const declaration = join(scratch, "declaration.cpp");
    writeFileSync(declaration, '#include "js/Modules.h"\nauto query = &JS::GetModuleEvaluationInfo;\n');
    execFileSync(compiler, flags.concat(["-DBUNWASM_EMBED=1", "-fsyntax-only", declaration]), { env, stdio: "pipe" });
    const hidden = spawnSync(compiler, flags.concat(["-UBUNWASM_EMBED", "-fsyntax-only", declaration]), { env, encoding: "utf8" });
    assert.equal(hidden.error, undefined);
    assert.notEqual(hidden.status, 0, "ordinary WASI headers must not export the embed query");
    assert.match(hidden.stderr, /GetModuleEvaluationInfo/);
    const output = join(scratch, "module-info.wasm");
    execFileSync(compiler, flags.concat(["-DBUNWASM_EMBED=1", "-ffunction-sections", "-fdata-sections",
      "crates/bunwasm-spidermonkey/tests/module-evaluation-info.cpp",
      join(env.CARGO_TARGET_DIR, "wasm32-wasip1/release/libbunwasm_spidermonkey.a"),
      "-L", join(sysroot, "lib/wasm32-wasip1/noeh"), "-lc++", "-lc++abi",
      "-lwasi-emulated-signal", "-lwasi-emulated-getpid", "-lwasi-emulated-process-clocks",
      "-Wl,-z,stack-size=8388608", "-Wl,--gc-sections", "-o", output]), { env, stdio: "pipe" });
    for (const tier of ["interp", "pbl"]) {
      const result = spawnSync("timeout", ["--kill-after=5s", "60s", "wasmtime", "run", "-W", "max-wasm-stack=16777216", output, tier],
        { env, encoding: "utf8" });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, `module evaluation info passed tier=${tier}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 330_000);
