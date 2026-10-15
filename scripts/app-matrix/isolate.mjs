import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recorderErrorHeader } from "./registry.mjs";

const scratch = mkdtempSync("/work/tmp/bun-wasm-app-matrix-isolate-");
let child;
let broker;
const cleanup = () => rmSync(scratch, { recursive: true, force: true });
process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child ? child.kill(signal) : process.exit(130));
try {
  const socket = join(scratch, "recorder.sock");
  if (process.argv.slice(2).some(arg => arg.split("=")[0] === "--record")) {
    broker = Bun.serve({
      unix: socket,
      async fetch(request) {
        try {
          const path = new URL(request.url).pathname;
          const url = new URL(path, "https://registry.npmjs.org");
          if (url.origin !== "https://registry.npmjs.org") throw new Error("Invalid recorder origin");
          return await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" }, redirect: "error", signal: AbortSignal.timeout(60000) });
        } catch (error) { return new Response(String(error), { status: 502, headers: { [recorderErrorHeader]: "1" } }); }
      },
    });
  }
  const runner = join(import.meta.dir, "run.mjs");
  child = spawn("unshare", ["-Urn", "--", "sh", "-ec", 'ip link set lo up; exec "$@"', "matrix", process.execPath, runner].concat(process.argv.slice(2)), {
    stdio: "inherit", env: { ...process.env, TMPDIR: scratch, MATRIX_RECORDER_SOCKET: broker ? socket : "" },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 130)); });
} finally {
  await broker?.stop(true);
  cleanup();
}
