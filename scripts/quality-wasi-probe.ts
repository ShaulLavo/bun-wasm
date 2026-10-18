import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function diagnostic(command: string[], env: NodeJS.ProcessEnv): Promise<string> {
  console.log(`\n> WASI warning rejection probe: ${command.join(" ")}`);
  const child = spawn(command[0]!, command.slice(1), { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => { if (child.pid) process.kill(-child.pid, "SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  try {
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", resolveStatus);
    });
    console.log(output);
    if (status !== 101) throw new Error(`Expected Clippy rejection, got ${status}`);
    return output;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function verifyWasiLint(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
  // This crate is cfg(wasi); host Clippy cannot see this actual production path.
  const file = resolve(import.meta.dir, "../crates/bunwasm-posix/src/lib.rs");
  const original = readFileSync(file);
  const probe = "\npub fn quality_wasi_lint_probe(value: bool) -> bool { if value { true } else { false } }\n";
  try {
    writeFileSync(file, Buffer.concat([original, Buffer.from(probe)]));
    const output = await diagnostic(command, env);
    if (!output.includes("clippy::needless_bool") || !output.includes("crates/bunwasm-posix/src/lib.rs")) {
      throw new Error("Clippy did not reject the authored WASI needless_bool probe");
    }
  } finally {
    writeFileSync(file, original);
  }
  console.log("WASI-only authored lint warning rejected; original source restored");
}
