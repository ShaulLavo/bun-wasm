// Runs a wasm32-wasip1 binary under the browser shim, from the command line, to compare against wasmtime.
//   bun scripts/run.ts <file.wasm> [args…]
// The guest sees the same seeded in-memory filesystem as the playground (cwd /home/user).
// WASI_TRACE=1 logs every syscall to stderr.
import { readFileSync } from "node:fs";
import { HOME, examples } from "../src/examples";
import { MemFS } from "../src/fs";
import { Wasi } from "../src/wasi";

const [wasmPath, ...args] = process.argv.slice(2);
if (!wasmPath) {
  console.error("usage: bun scripts/run.ts <file.wasm> [args…]");
  process.exit(2);
}
const fs = new MemFS();
fs.mkdirp("/tmp");
for (const [name, source] of Object.entries(examples)) fs.writeFile(`${HOME}/${name}`, source);

const cell = new Int32Array(new SharedArrayBuffer(4));
const module = new WebAssembly.Module(readFileSync(wasmPath));
const wasi = new Wasi({
  args: ["bun", ...args],
  env: { HOME, PWD: HOME, USER: "user", TERM: "xterm-256color", TMPDIR: "/tmp" },
  fs,
  preopens: { "/": "/" },
  stdout: (data) => process.stdout.write(data),
  stderr: (data) => process.stderr.write(data),
  sleep: (ms) => void Atomics.wait(cell, 0, 0, ms),
  trace: process.env.WASI_TRACE ? (line) => process.stderr.write(`[wasi] ${line}\n`) : undefined,
});
const code = wasi.start(new WebAssembly.Instance(module, wasi.imports(module)));
process.exit(code);
