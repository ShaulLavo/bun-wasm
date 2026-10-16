import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { WASI } from "node:wasi";
import { startEngineHost } from "../web/src/engine-host.js";

const nodeProcess = process;
const root = resolve(import.meta.dirname, "..");
const engines = new Map([["quickjs", "bun.wasm"], ["jsc", "bun-jsc.wasm"], ["browser", "bun-browser.wasm"]]);
const [engine, mode, directory] = nodeProcess.argv.slice(2);
if (!directory) {
  const scratch = mkdtempSync("/work/tmp/bun-wasm-directory-descriptors-");
  try {
    mkdirSync(`${scratch}/retained-tree`);
    const failures: string[] = [];
    for (const [name, exit] of Array.from(engines.keys()).flatMap(name => [[name, "natural"], [name, "explicit"]])) {
      writeFileSync(`${scratch}/index.js`, `const fs = require('node:fs');
          globalThis.heldDirectories = Array.from({length: 10}, () => fs.opendirSync('/retained-tree'));
          process.on('exit', () => { globalThis.lastDirectory = fs.opendirSync('/retained-tree'); });
          ${exit === "explicit" ? "process.exit(0);" : ""}`);
      const result = spawnSync(nodeProcess.execPath, ["--no-warnings", import.meta.filename, name, exit, scratch], { encoding: "utf8", timeout: 60000 });
      if (result.status !== 0) failures.push(`${name} ${exit}\n${result.stdout}\n${result.stderr}`);
      nodeProcess.stdout.write(result.stdout);
    }
    assert.deepEqual(failures, []);
  } finally {
    rmSync(scratch, { recursive: true });
  }
} else {
  observe().then(() => nodeProcess.exit(0), error => {
    nodeProcess.stderr.write(`${error.stack || error}\n`);
    nodeProcess.exit(1);
  });
}

async function observe() {
  const wasi = new WASI({ version: "preview1", args: ["bun", "run", "/index.js"], env: { PWD: "/" }, preopens: { "/": directory }, returnOnExit: true });
  const imports = wasi.getImportObject();
  const live = new Set<number>();
  let opened = 0;
  let instance: WebAssembly.Instance;
  function memory() {
    const value = instance.exports.memory;
    assert(value instanceof WebAssembly.Memory);
    return value.buffer;
  }
  const originalOpen = imports.wasi_snapshot_preview1.path_open;
  const originalClose = imports.wasi_snapshot_preview1.fd_close;
  imports.wasi_snapshot_preview1.path_open = (fd: number, flags: number, ptr: number, length: number, oflags: number, base: bigint, inheriting: bigint, fdflags: number, out: number) => {
    const name = new TextDecoder().decode(new Uint8Array(memory(), ptr, length));
    const result = originalOpen(fd, flags, ptr, length, oflags, base, inheriting, fdflags, out);
    if (result === 0 && name.endsWith("retained-tree")) {
      live.add(new DataView(memory()).getUint32(out, true));
      opened++;
    }
    return result;
  };
  imports.wasi_snapshot_preview1.fd_close = (fd: number) => {
    const result = originalClose(fd);
    if (result === 0) live.delete(fd);
    return result;
  };
  const artifact = engines.get(engine);
  assert(artifact, `unknown engine ${engine}`);
  const module = await WebAssembly.compile(readFileSync(resolve(root, "dist", artifact)));
  instance = await WebAssembly.instantiate(module, imports);
  const code = wasi.start(instance);
  if (engine === "browser") {
    await globalThis.fetch("data:,");
    const exitCode = await startEngineHost({ instance, moduleUrls: "data" });
    assert.equal(exitCode, 0);
  } else assert.equal(code, 0);
  assert.equal(opened, 11, "ten held owners and one exit-listener owner opened real WASI descriptors");
  assert.equal(live.size, 0, "guest exit closes every descriptor while its wasm instance is retained");
  assert(memory().byteLength > 0);
  nodeProcess.stdout.write(`PASS directory descriptors ${engine} ${mode}: 11 opens, 11 closes, retained instance\n`);
}
