// Runs a wasm32-wasip1 binary under the browser shim, from the command line, to compare against wasmtime.
//   bun scripts/run.ts <file.wasm> [args…]
// The guest sees the same seeded in-memory filesystem as the playground (cwd /home/user).
// WASI_TRACE=1 logs every syscall to stderr. NET=0 leaves out the networking slots (fetch, Bun.serve);
// SLOTS=imports installs them as calls through the WASI import (the playground's ?slots=imports).
// Guest servers are served on real 127.0.0.1 ports by the helper worker (scripts/net-helper.ts).
import { readFileSync } from "node:fs";
import { HOME, examples } from "../src/examples";
import { MemFS } from "../src/fs";
import { NetHost } from "../src/net/host";
import { createRing } from "../src/net/ring";
import { HOST_CALL_FD, installHostSlots, installHostSlotsViaImport } from "../src/net/trampoline";
import { Wasi } from "@bun-wasm/runtime/core";

const [wasmPath, ...args] = process.argv.slice(2);
if (!wasmPath) {
  console.error("usage: bun scripts/run.ts <file.wasm> [args…]");
  process.exit(2);
}
const fs = new MemFS();
fs.mkdirp("/tmp");
for (const [name, source] of Object.entries(examples)) fs.writeFile(`${HOME}/${name}`, source);

function testEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0].startsWith("TEST_") && e[1] !== undefined));
}

const cell = new Int32Array(new SharedArrayBuffer(4));
const module = new WebAssembly.Module(readFileSync(wasmPath));
const wasi = new Wasi({
  hostCallFd: HOST_CALL_FD,
  args: ["bun", ...args],
  // TEST_* variables pass through (TEST_SERVER for the network fixtures).
  env: { HOME, PWD: HOME, USER: "user", TERM: "xterm-256color", TMPDIR: "/tmp", ...testEnv() },
  fs,
  preopens: { "/": "/" },
  stdout: (data) => process.stdout.write(data),
  stderr: (data) => process.stderr.write(data),
  sleep: (ms) => void Atomics.wait(cell, 0, 0, ms),
  trace: process.env.WASI_TRACE ? (line) => process.stderr.write(`[wasi] ${line}\n`) : undefined,
});
const instance = new WebAssembly.Instance(module, wasi.imports(module));
if (process.env.NET !== "0") {
  // The helper needs its own thread: this one blocks inside bun.wasm until it exits.
  const ring = createRing();
  const helper = new Worker(new URL("./net-helper.ts", import.meta.url).href);
  helper.postMessage({ type: "init", ring });
  const host = new NetHost(ring, (req, transfer = []) => helper.postMessage(req, transfer));
  host.attach(instance.exports.memory as WebAssembly.Memory);
  if (process.env.SLOTS === "imports") wasi.hostCall = installHostSlotsViaImport(instance, host.slots());
  else installHostSlots(instance, host.slots());
}
const code = wasi.start(instance);
process.exit(code);
