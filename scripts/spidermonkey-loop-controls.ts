import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { interpreterFrames } from "./spidermonkey-interpreter-frames.ts";

function interpreterCommand(build: string): { directory: string; args: string[] } {
  const commands: unknown = JSON.parse(readFileSync(join(build, "compile_commands.json"), "utf8"));
  assert(Array.isArray(commands), "missing native compile commands");
  const entry: unknown = commands.find(command => command?.file === join(build, "firefox/js/src/vm/Interpreter.cpp"));
  assert(entry && typeof entry === "object" && "directory" in entry && typeof entry.directory === "string" && "arguments" in entry);
  assert(Array.isArray(entry.arguments));
  const args = Array.from(entry.arguments, arg => { assert.equal(typeof arg, "string"); return String(arg); });
  return { directory: entry.directory, args };
}

export function runLoopControls(): void {
  const build = process.env.SPIDERMONKEY_BUILD_DIR;
  const native = process.env.SPIDERMONKEY_NATIVE_DIR;
  const sdk = process.env.WASI_SDK_PATH;
  const sysroot = process.env.BUN_WASM_SYSROOT;
  const side = process.env.SPIDERMONKEY_ENGINE_BUILD_DIR;
  assert(build && native && sdk && sysroot && side, "source env.sh and set ordinary SpiderMonkey producer directories");
  console.log(JSON.stringify({ frames: interpreterFrames(readFileSync(join(side, "engine.wasm"))) }));
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sm-loop-controls-"));
  try {
    const command = interpreterCommand(build);
    const output = command.args.indexOf("-o");
    assert(output >= 0 && command.args[output + 1] === "/dev/null", "unexpected compile database output");
    command.args[output + 1] = join(scratch, "Interpreter.o");
    const compiler = command.args.shift();
    assert(compiler);
    execFileSync(compiler, ["-DBUNWASM_INTERPRETER_CONTROLS=1"].concat(command.args), { cwd: command.directory, stdio: "inherit" });
    const library = join(scratch, "libspidermonkey_g2.a");
    copyFileSync(join(native, "libspidermonkey_g2.a"), library);
    execFileSync(join(sdk, "bin/llvm-ar"), ["r", library, join(scratch, "Interpreter.o")], { stdio: "inherit" });
    symlinkSync(join(native, "include"), join(scratch, "include"));
    symlinkSync(join(native, "js-confdefs.h"), join(scratch, "js-confdefs.h"));
    const env = {
      ...process.env,
      SPIDERMONKEY_NATIVE_DIR: scratch,
      CARGO_TARGET_DIR: join(scratch, "target"),
      CXXFLAGS_wasm32_wasip1: `--sysroot=${sysroot} -fPIC -fno-exceptions`,
      CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: `-C relocation-model=pic -C panic=abort -C link-self-contained=no -L native=${sysroot}/lib/wasm32-wasip1`,
    };
    execFileSync("cargo", ["build", "--locked", "--offline", "-Zbuild-std=std,panic_abort", "--release", "--target", "wasm32-wasip1", "-j", "2", "-p", "bunwasm-spidermonkey", "--features", "loop-controls", "--example", "engine-semantics"], { cwd: resolve(import.meta.dir, ".."), env, stdio: "inherit" });
    const wasm = join(env.CARGO_TARGET_DIR, "wasm32-wasip1/release/examples/engine-semantics.wasm");
    for (const tier of ["interp", "pbl"]) {
      execFileSync("timeout", ["--kill-after=5s", "180s", "wasmtime", "run", "-W", "max-wasm-stack=16777216", "--env", `BUN_WASM_SPIDERMONKEY_TIER=${tier}`, wasm], { env, stdio: "inherit" });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) runLoopControls();
