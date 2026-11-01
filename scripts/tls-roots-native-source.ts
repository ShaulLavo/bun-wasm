import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This emits Rust type metadata only. It never links or executes crypto or a guest.
export function checkTlsRustSource() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const native = readFileSync(join(root, "crates/bunwasm-runtime/src/natives.rs"), "utf8");
  const start = native.indexOf("#[derive(Default)]\npub struct Table");
  const end = native.indexOf("/// Node's (code, negative Linux errno", start);
  if (start < 0 || end < 0) throw new Error("Cannot locate the canonical data-native Table declaration");
  const table = native.slice(start, end);
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-tls-metadata-"));
  const crypto = join(root, "crates/bunwasm-crypto-sys/src/lib.rs");
  const runtime = join(scratch, "runtime.rs");
  const commands: string[][] = [];
  try {
    writeFileSync(runtime, `#[path = ${JSON.stringify(join(root, "crates/bunwasm-runtime/src/data.rs"))}] pub mod data;
#[path = ${JSON.stringify(join(root, "crates/bunwasm-runtime/src/tls.rs"))}] pub mod tls;
pub mod natives {
use std::rc::Rc;
use crate::data::{Args, DataFn, NativeResult, Val};
${table}
}
pub fn wire(table: &mut natives::Table, startup: tls::StartupExtras) { tls::install(table, startup); }
`);
    const run = (arguments_: readonly string[]) => {
      commands.push(["rustc"].concat(arguments_));
      return execFileSync("rustc", arguments_, { cwd: root, timeout: 60_000, stdio: "pipe" });
    };
    const targets = ["host", "wasm32-wasip1"];
    for (const target of targets) checkTarget(target, { scratch, crypto, runtime, run });
    return { targets, libraryMetadata: "passed", testMetadata: "passed", nativeLinked: false, nativeExecuted: false, commands, scratchRemoved: true };
  } catch (error) {
    if (error instanceof Error && "stderr" in error && Buffer.isBuffer(error.stderr)) process.stderr.write(error.stderr);
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checkTarget(target: string, context: { scratch: string; crypto: string; runtime: string; run: (args: readonly string[]) => Buffer }) {
  const { scratch, crypto, runtime, run } = context;
  const targetFlags = target === "host" ? [] : ["--target", target];
  for (const test of [false, true]) {
    const suffix = `${target}-${test ? "test" : "library"}`;
    const library = join(scratch, `libbunwasm_crypto_sys_${suffix}.rmeta`);
    const flags = targetFlags.concat(test ? ["--cfg", "test"] : []);
    const common = ["--edition=2024", "--deny=warnings", "--crate-type=lib", "--emit=metadata", "--cfg", 'feature="engine-host"'];
    run(common.concat(flags, ["--crate-name=bunwasm_crypto_sys", crypto, "-o", library]));
    run(common.concat(targetFlags, test ? ["--test"] : [], ["--crate-name=tls_source", runtime, "--extern", `bunwasm_crypto_sys=${library}`, "-o", join(scratch, `${suffix}.rmeta`)]));
  }
}

if (import.meta.main) console.log(JSON.stringify(checkTlsRustSource(), null, 2));
