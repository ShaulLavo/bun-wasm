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
    const cases = Array.from(engines.keys()).flatMap(name => [[name, "natural"], [name, "explicit"], [name, "gc"]])
      .concat(["reallyExit", "abort", "kill", "uncaught"].map(exit => ["browser", exit]));
    for (const [name, exit] of cases) {
      if (exit === "gc") rmSync(`${scratch}/gc-tree`, { recursive: true, force: true });
      const source = exit === "gc" ? readFileSync(`${root}/tests/fixtures/fs-opendir-gc/index.js`, "utf8") : `const fs = require('node:fs');
          globalThis.heldDirectories = Array.from({length: 10}, () => fs.opendirSync('/retained-tree'));
          process.on('exit', () => { globalThis.lastDirectory = fs.opendirSync('/retained-tree'); });
          ${exit === "explicit" ? "process.exit(0);" : ""}`;
      const hardExit = new Map([
        ["reallyExit", "process.reallyExit(0);"],
        ["abort", "process.abort();"],
        ["kill", "process.kill(process.pid);"],
        ["uncaught", "setTimeout(() => { throw new Error('fatal directory test'); }, 0);"],
      ]).get(exit) || "";
      writeFileSync(`${scratch}/index.js`, `
        globalThis.directoryCountForTest = require('bun:internal-for-testing').directoryCount;
        globalThis.reopenDirectoryForTest = () => {
          const d = require('node:fs').opendirSync('/retained-tree');
          d.closeSync();
        };
        ${source}
        ${hardExit}`);
      const result = spawnSync(nodeProcess.execPath, ["--expose-gc", "--no-warnings", import.meta.filename, name, exit, scratch], { encoding: "utf8", timeout: 60000 });
      if (result.status !== 0) failures.push(`${name} ${exit}\n${result.stdout}\n${result.stderr}`);
      nodeProcess.stdout.write(result.stdout);
    }
    assert.deepEqual(failures, []);
  } finally {
    rmSync(scratch, { recursive: true });
  }
} else {
  observe().then(() => nodeProcess.exit(0), error => {
    nodeProcess.stderr.write(`${error}\n${error.stack || ""}\n`);
    nodeProcess.exit(1);
  });
}

async function observe() {
  const wasi = new WASI({ version: "preview1", args: ["bun", "run", "/index.js"], env: { PWD: "/" }, preopens: { "/": directory }, returnOnExit: true });
  const imports = wasi.getImportObject();
  const live = new Set<number>();
  let opened = 0;
  const descriptors: number[] = [];
  let collectedDescriptorsReleased = false;
  const target = mode === "gc" ? "gc-tree" : "retained-tree";
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
    if (result === 0 && name.endsWith(target)) {
      if (mode === "gc" && opened === 21) {
        assert.equal(live.size, 0, "collection and held-owner close released all twenty-one descriptors before exit");
        collectedDescriptorsReleased = true;
      }
      const descriptor = new DataView(memory()).getUint32(out, true);
      live.add(descriptor);
      descriptors.push(descriptor);
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
  const expectedCode = new Map([["abort", 134], ["kill", 143], ["uncaught", 1]]).get(mode) || 0;
  const code = wasi.start(instance);
  if (engine === "browser") {
    await globalThis.fetch("data:,");
    let exitSnapshot;
    const exitCode = await startEngineHost({ instance, moduleUrls: "data", onExit() {
      exitSnapshot = { cursors: globalThis.directoryCountForTest(), descriptors: live.size };
    } });
    assert.equal(exitCode, expectedCode);
    assert.deepEqual(exitSnapshot, { cursors: 0, descriptors: 0 }, "host exit notification observes no cursors or descriptors");
  } else assert.equal(code, expectedCode);
  const expected = mode === "gc" ? 22 : ["natural", "explicit"].includes(mode) ? 11 : 10;
  assert.equal(opened, expected, "guest owners opened real WASI descriptors");
  if (mode === "gc") assert(collectedDescriptorsReleased);
  assert.equal(live.size, 0, "guest exit closes every descriptor while its wasm instance is retained");
  assert(memory().byteLength > 0);
  if (engine === "browser" && mode !== "gc") {
    globalThis.reopenDirectoryForTest();
    assert.equal(opened, expected + 1);
    assert(descriptors.slice(0, -1).includes(descriptors.at(-1)), "retained instance reuses a released directory descriptor");
    assert.equal(globalThis.directoryCountForTest(), 0);
    assert.equal(live.size, 0);
  }
  nodeProcess.stdout.write(`PASS directory descriptors ${engine} ${mode}: ${opened} opens, ${opened} closes, retained instance\n`);
}
