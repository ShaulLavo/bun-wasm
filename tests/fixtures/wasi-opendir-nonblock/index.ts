import { mkdirSync, writeFileSync } from "node:fs";
import { WASI } from "node:wasi";

// Mirror @tailwindcss/oxide-wasm32-wasi: path_open(O_DIRECTORY, FDFLAG_NONBLOCK) + fd_readdir.
mkdirSync("nonblock-dir", { recursive: true });
writeFileSync("nonblock-dir/hello.txt", "hi");
const memoryOnlyWasm = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  5, 3, 1, 0, 1,
  7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0,
]);
const wasi = new WASI({ preopens: { "/sandbox": "." } });
const wasiInstance = new WebAssembly.Instance(new WebAssembly.Module(memoryOnlyWasm), {});
wasi.initialize(wasiInstance);
const memory = wasiInstance.exports.memory as WebAssembly.Memory;
const bytes = new Uint8Array(memory.buffer);
const view = new DataView(memory.buffer);
const subdir = new TextEncoder().encode("nonblock-dir");
bytes.set(subdir, 0);
const imports = wasi.wasiImport as Record<string, (...args: unknown[]) => number>;
const openErrno = imports.path_open!(3, 1, 0, subdir.length, 2, 0xfbffeben, 0xfffffffn, 4, 32);
const wasiDirFd = view.getUint32(32, true);
const readdirErrno = imports.fd_readdir!(wasiDirFd, 64, 512, 0n, 40);
const used = view.getUint32(40, true);
const names: string[] = [];
for (let offset = 64; offset + 24 <= 64 + used;) {
  const nameLen = view.getUint32(offset + 16, true);
  offset += 24;
  if (offset + nameLen > 64 + used) break;
  names.push(new TextDecoder().decode(bytes.subarray(offset, offset + nameLen)));
  offset += nameLen;
}
imports.fd_close!(wasiDirFd);
console.log("wasi nonblock readdir", openErrno, readdirErrno, names.includes("hello.txt"));
