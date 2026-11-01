import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
const path = process.argv[2];
assert(path, "usage: check-oom.ts smoke.wasm");
const module = new WebAssembly.Module(readFileSync(path));
for (const tier of ["interp", "pbl"]) {
  const wasi = new WASI({ version: "preview1", args: [path, tier, "--oom"], returnOnExit: true });
  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport });
  assert.equal(wasi.start(instance), 134, `${tier} infallible VM allocation must exit 134`);
  process.stdout.write(`ok fatal OOM tier=${tier} exit=134\n`);
}
