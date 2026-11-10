import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export async function installFixture(directory: string, base: string, args: string[] = [], expected = 0, archives = false, environment: string[] = []) {
  const engine = process.env.INSTALL_ENGINE ?? "quickjs";
  const wasm = resolve(process.env.BUN_WASM ?? join(root, "dist", engine === "quickjs" ? "bun.wasm" : `bun-${engine}.wasm`));
  const guest = ["--wasm", wasm, "--dir", `${directory}::/`, "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${base}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache"].concat(environment.flatMap(value => ["--env", value]), ["--", "install"], archives ? [] : ["--lockfile-only"], args);
  const launcher = process.env.BUN_WASM_LAUNCHER ?? join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "release/bun-wasm");
  const child = spawn(engine === "browser" ? "node" : launcher, engine === "browser" ? ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(guest) : guest, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    assert.equal(code, expected, output);
    return output;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

