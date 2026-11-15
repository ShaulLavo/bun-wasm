import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

test("JSAPI preserves suppressed error operand identity on explicit interpreter and PBL tiers", () => {
  const native = process.env.SPIDERMONKEY_NATIVE_DIR;
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  assert(native && sdk && sysroot, "source env.sh and set the private native output directory");
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sm-disposal-"));
  try {
    const target = process.env.SPIDERMONKEY_CONTROLS_TARGET_DIR ?? join(scratch, "target");
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: target,
      CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: `-C relocation-model=pic -C panic=abort -C link-self-contained=no -L native=${sysroot}/lib/wasm32-wasip1`,
      CXXFLAGS_wasm32_wasip1: `--sysroot=${sysroot} -fPIC -fno-exceptions`,
    };
    execFileSync("cargo", [
      "build", "--locked", "--offline", "-Zbuild-std=std,panic_abort", "--release",
      "--target", "wasm32-wasip1", "-j", "4", "-p", "bunwasm-spidermonkey",
      "--features", "controls", "--lib",
    ], { env, stdio: "inherit" });
    const fixture = readFileSync("tests/fixtures/suppressed-error-order/index.ts", "utf8");
    assert(!fixture.includes(')DISPOSAL"'), "raw string delimiter");
    writeFileSync(join(scratch, "suppressed-error-source.h"), `const char* source = R"DISPOSAL(var console = { log(message) { return message; } };\n${fixture})DISPOSAL";\n`);
    const wasm = join(scratch, "suppressed-error.wasm");
    execFileSync(join(sdk, "bin/clang++"), [
      "--target=wasm32-wasip1", `--sysroot=${sysroot}`, "-std=c++20", "-O2", "-fPIC",
      "-fno-exceptions", "-fno-rtti", "-DBUNWASM_EMBED=1",
      "-D_WASI_EMULATED_PROCESS_CLOCKS", "-D_WASI_EMULATED_GETPID",
      "-I", scratch, "-I", join(native, "include"), "-include", join(native, "js-confdefs.h"),
      "crates/bunwasm-spidermonkey/tests/suppressed-error-jsapi.cpp",
      join(native, "libspidermonkey_bunwasm.a"),
      join(target, "wasm32-wasip1/release/libbunwasm_spidermonkey.a"),
      "-Wl,-z,stack-size=8388608", "-Wl,--max-memory=1073741824",
      "-Wl,--export=__stack_low", "-Wl,--export=__stack_high", "-Wl,--export=__stack_pointer",
      "-lwasi-emulated-process-clocks", "-lwasi-emulated-getpid", "-lwasi-emulated-signal",
      "-o", wasm,
    ], { stdio: "inherit" });
    for (const tier of ["interp", "pbl"]) {
      execFileSync("timeout", ["--kill-after=5s", "360s", "wasmtime", "run", "-W", "max-wasm-stack=16777216", wasm, tier], { stdio: "inherit" });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 600_000);
