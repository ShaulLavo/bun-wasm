import { maxMemoryBytes } from "../scripts/src/program-profile.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [side, output] = process.argv.slice(2);
assert(side && output);
const sdk = process.env.WASI_SDK_PATH;
const sysroot = process.env.BUN_WASM_SYSROOT;
assert(sdk && sysroot);
const module = new WebAssembly.Module(readFileSync(side));
const own = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
const provided = new Set(["memory", "__memory_base", "__table_base", "__indirect_function_table"]);
const names = Array.from(new Set(WebAssembly.Module.imports(module)
  .filter(entry => entry.module !== "wasi_snapshot_preview1" && !provided.has(entry.name) && !own.has(entry.name))
  .map(entry => entry.name)));
const maximum = maxMemoryBytes();
const args = ["--sysroot=" + sysroot, "-O2", join(root, "tests/linker/spidermonkey/core.c"), "-o", output,
  "-Wl,--export=__stack_pointer", "-Wl,--export=bun_core_alloc", "-Wl,--export-table", "-Wl,--growable-table", "-Wl,--export=__wasm_call_ctors", "-Wl,-z,stack-size=8388608",
  "-Wl,--max-memory=" + maximum, "-lwasi-emulated-process-clocks", "-lwasi-emulated-getpid", "-lwasi-emulated-signal"]
  .concat(names.map(name => "-Wl,--export=" + name));
writeFileSync(output + ".command.json", JSON.stringify(args, null, 2) + "\n");
execFileSync(join(sdk, "bin/clang"), args, { stdio: "inherit" });
const bytes = readFileSync(output);
const name = Buffer.from("bun-wasm-engine");
const tag = Buffer.from("spidermonkey-g2");
const payload = Buffer.concat([Buffer.from([name.length]), name, tag]);
assert(payload.length < 128);
writeFileSync(output, Buffer.concat([bytes, Buffer.from([0, payload.length]), payload]));
