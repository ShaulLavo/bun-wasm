import { readFileSync, writeSync } from "node:fs";
import { WASI } from "node:wasi";

const [binary, certs, entropyMode, ...args] = process.argv.slice(2);
if (!binary || !certs || !["normal", "fail"].includes(entropyMode ?? "")) throw new Error("Usage: tls-probe-wasi.ts WASM CERTS normal|fail [args]");
const wasi = new WASI({ version: "preview1", args: [binary].concat(args), preopens: { "/certs": certs }, returnOnExit: true });
const imports = wasi.wasiImport;
const randomGet = imports.random_get;
if (typeof randomGet !== "function") throw new Error("WASI random_get is absent");
imports.random_get = (...values: number[]) => {
  if (entropyMode === "fail") {
    writeSync(2, "tls-probe entropy-import-failure\n");
    return 29;
  }
  return randomGet(...values);
};
const module = await WebAssembly.compile(readFileSync(binary));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports });
process.exitCode = wasi.start(instance);
