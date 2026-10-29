import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";

const smoke = process.argv[2];
assert(smoke, "usage: node hermes/check-fatal.ts smoke.wasm");
const wasi = new WASI({ version: "preview1", args: [smoke, "--oom"], returnOnExit: true });
const module = new WebAssembly.Module(readFileSync(smoke));
const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport });
assert.equal(wasi.start(instance), 134, "heap exhaustion must call the embedder fatal boundary");
process.stdout.write("ok   heap exhaustion: fatal callback, guest exit 134\n");
