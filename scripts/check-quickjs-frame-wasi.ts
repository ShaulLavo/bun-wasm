// wasm32 contract for what the frame stack's default bound declares about the product's
// allocator: builds scripts/fixtures/quickjs-frame-wasi.c with the bare QuickJS engine for
// wasm32-wasip1 against the split-profile sysroot and runs it under wasmtime, where every
// request's growth of linear memory is compared with the bound declared for it.
// Needs the environment of env.sh: WASI_SDK_PATH, BUN_WASM_SYSROOT and wasmtime on PATH.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeCheck } from "./quickjs-native-check.ts";

const { root, engine, scratch, cleanup } = nativeCheck("bun-wasm-quickjs-frame-wasi-", process.argv[2]);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run source env.sh first`);
  return value;
}

function run(command: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  process.stderr.write(result.stderr ?? "");
  return { status: result.status ?? 1, output: result.stdout ?? "" };
}

try {
  const sysroot = required("BUN_WASM_SYSROOT");
  // The bound is declared for the split profile's libc. The shared-group sysroot has its own provider.
  const receipt = JSON.parse(readFileSync(join(sysroot, "bun-wasm-sysroot.json"), "utf8")) as { profile?: string };
  if (receipt.profile !== undefined) throw new Error(`Expected the split-profile sysroot, found profile ${receipt.profile}`);
  const module = join(scratch, "quickjs-frame-wasi.wasm");
  const sources = ["quickjs.c", "libregexp.c", "libunicode.c", "dtoa.c"].map(name => join(engine, name));
  // The defines are the ones third_party/rquickjs-sys/build.rs passes for a WASI target.
  const compiled = run(join(required("WASI_SDK_PATH"), "bin/clang"), ["--target=wasm32-wasip1", `--sysroot=${sysroot}`,
    "-D_GNU_SOURCE", "-DEMSCRIPTEN=1", "-DFE_DOWNWARD=0", "-DFE_UPWARD=0", "-std=gnu11", "-O2", "-I", engine,
    join(root, "scripts/fixtures/quickjs-frame-wasi.c")].concat(sources, ["-lm", "-Wl,-z,stack-size=4194304", "-o", module]));
  if (compiled.status !== 0) throw new Error(`wasm32 QuickJS compilation exited ${compiled.status}`);
  const observed = run("wasmtime", ["run", module]);
  process.stdout.write(observed.output);
  const passed = observed.status === 0;
  console.log(`${passed ? "ok" : "FAIL"} linear memory never grows by more than the bound declared for a request, and 4 MiB holds the plain-recursion floor`);
  process.exitCode = passed ? 0 : 1;
} finally {
  cleanup();
  console.log(JSON.stringify({ cleanup: scratch, removed: true }));
}
