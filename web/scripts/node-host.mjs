// Run bun-browser.wasm with the host engine on Node (V8), headless: the
// runtime's polyfills and user code run on Node's JS engine, the wasm does
// transpiling, resolution, bun build, sqlite and the natives. Used by
// `scripts/test.sh --engine browser`. See docs/engine-browser.md.
//
//   node web/scripts/node-host.mjs [--wasm dist/bun-browser.wasm] [--net] [--dir HOST::GUEST]... [--env K=V]... -- <bun args>
//
// --net gives the program fetch, Bun.serve, node:http and node:net on real
// sockets, like crates/bunwasm-host; without it, network APIs are missing as
// under plain wasmtime (fetch still works, through Node's fetch).
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { resolve, posix } from "node:path";
import { WASI } from "node:wasi";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, workerData } from "node:worker_threads";
import { installCliFetch } from "./node-install-net.mjs";
import { memoryViews } from "../src/memory-views.js";
import { SubprocessHost, childTransport } from "../src/subprocess.js";

// V8's default stack limit (about 984 KB) also bounds wasm frames. Run once more with a larger
// one, as the native launcher does, so deep guest recursion has room; Linux and macOS give the
// main thread 8 MiB. Workers get Node's default 4 MB. The guest's stack budget fits both
// (docs/stack-limits.md). An explicit --stack-size is kept.
const STACK_KB = 4000;
const GUEST_STACK_KIB = "1024";
if (isMainThread && !process.execArgv.some((arg) => arg.startsWith("--stack-size"))) {
  const rerun = [`--stack-size=${STACK_KB}`].concat(process.execArgv, [fileURLToPath(import.meta.url)], process.argv.slice(2));
  const result = spawnSync(process.execPath, rerun, { stdio: "inherit" });
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

// The runtime replaces globalThis.process with its own; keep Node's.
const nodeProcess = process;
const here = fileURLToPath(new URL(".", import.meta.url));
let wasmPath = resolve(here, "../../dist/bun-browser.wasm");
let withNet = false;
const preopens = {};
const env = {};
const argv = process.argv.slice(2);
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") {
    i++;
    break;
  }
  if (a === "--wasm") wasmPath = argv[++i];
  else if (a === "--net") withNet = true;
  else if (a === "--dir") {
    const [hostDir, guest = hostDir] = argv[++i].split("::");
    preopens[guest] = hostDir;
  } else if (a === "--env") {
    const kv = argv[++i];
    const eq = kv.indexOf("=");
    env[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else break;
}
let args = argv.slice(i);
if (workerData?.bunwasmChild) {
  args = workerData.meta.argv.slice(1);
  Object.assign(preopens, workerData.preopens);
  Object.assign(env, workerData.meta.env, { PWD: workerData.meta.cwd || "/" });
  withNet = workerData.withNet;
}
if (Object.keys(preopens).length === 0) {
  preopens[process.cwd()] = process.cwd();
  env.PWD ??= process.cwd();
}
env.BUN_WASM_STACK_KIB ??= GUEST_STACK_KIB;

const child = workerData?.bunwasmChild ? childTransport(workerData.transport) : null;
let subprocess;
let cliFetch;
function finish(code) {
  cliFetch?.dispose();
  subprocess?.dispose();
  child?.finish(code);
  nodeProcess.exit(code);
}

function installChildStdio(imports, getInstance) {
  const originalRead = imports.wasi_snapshot_preview1.fd_read;
  const originalWrite = imports.wasi_snapshot_preview1.fd_write;
  let memory;
  const views = () => (memory ??= memoryViews(getInstance().exports.memory));
  const vectors = (ptr, count) => {
    const view = views().view();
    return Array.from({ length: count }, (_, i) => {
      const start = view.getUint32(ptr + i * 8, true);
      return views().range(start, view.getUint32(ptr + i * 8 + 4, true));
    });
  };
  imports.wasi_snapshot_preview1.fd_read = (fd, ptr, count, result) => {
    if (fd !== 0 || workerData.meta.stdin === "inherit" && !workerData.transport.inheritedStdin) return originalRead(fd, ptr, count, result);
    const chunks = vectors(ptr, count);
    const bytes = child.stdin.readBlocking(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      if (typeof bytes === "number") break;
      const n = Math.min(chunk.length, bytes.length - at);
      chunk.set(bytes.subarray(at, at + n));
      at += n;
    }
    views().view().setUint32(result, at, true);
    return 0;
  };
  imports.wasi_snapshot_preview1.fd_write = (fd, ptr, count, result) => {
    if (fd !== 1 && fd !== 2) return originalWrite(fd, ptr, count, result);
    const chunks = vectors(ptr, count);
    for (const chunk of chunks) child[fd === 2 ? "stderr" : "stdout"].writeAll(chunk);
    views().view().setUint32(result, chunks.reduce((n, chunk) => n + chunk.length, 0), true);
    return 0;
  };
}

function validateCwd(cwd) {
  const path = posix.resolve("/", cwd || "/");
  const mounts = Object.entries(preopens).sort(([a], [b]) => b.length - a.length);
  const mount = mounts.find(([guest]) => guest === "/" || path === guest || path.startsWith(`${guest}/`));
  if (!mount) throw Object.assign(new Error(`spawn: cwd does not exist: ${path}`), { code: "ENOENT" });
  const [guest, host] = mount;
  const directory = resolve(host, `.${path.slice(guest === "/" ? 0 : guest.length)}`);
  if (!statSync(directory).isDirectory()) throw Object.assign(new Error(`spawn: cwd is not a directory: ${path}`), { code: "ENOTDIR" });
}

async function run() {
  const module = workerData?.module || await WebAssembly.compile(readFileSync(wasmPath));
  subprocess = new SubprocessHost({
    budget: workerData?.transport?.budget,
    slot: workerData?.transport?.slot,
    token: workerData?.transport?.token,
    stdin: child && (workerData.meta.stdin !== "inherit" || workerData.transport.inheritedStdin) ? workerData.transport.pipes[0] : undefined,
    output: (fd, bytes) => {
      if (child) child[fd === 2 ? "stderr" : "stdout"].writeAll(bytes);
      else (fd === 2 ? nodeProcess.stderr : nodeProcess.stdout).write(bytes);
    },
    launch: (meta, transport, onError) => {
      validateCwd(meta.cwd);
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { bunwasmChild: true, module, preopens, meta, transport, withNet },
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      });
      worker.on("error", onError);
      return worker;
    },
  });
  const wasi = new WASI({ version: "preview1", args: ["bun"].concat(args), env, preopens, returnOnExit: true });
  const imports = wasi.getImportObject();
  let instance;
  if (child) installChildStdio(imports, () => instance);
  if (withNet) cliFetch = installCliFetch(imports, () => instance);
  instance = await WebAssembly.instantiate(module, imports);
  cliFetch?.install();
  const code = wasi.start(instance);
  if (!instance.exports.bunwasm_ready || instance.exports.bunwasm_ready() !== 1) finish(code);

  // Load Node's fetch (undici) now: it is loaded lazily and reads globals the
  // runtime's polyfills replace (Blob, TextEncoder, streams).
  await globalThis.fetch("data:,").catch(() => {});
  const nodeFetch = globalThis.fetch.bind(globalThis);

  // The program's ES modules: named bunwasm: URLs served from memory by
  // in-thread module hooks, so imports can form cycles (see engine-host.js).
  const PREFIX = "bunwasm:/m/";
  const sources = new Map();
  registerHooks({
    resolve: (specifier, context, next) => (specifier.startsWith(PREFIX) ? { url: specifier, shortCircuit: true } : next(specifier, context)),
    load: (url, context, next) => (url.startsWith(PREFIX) ? { format: "module", source: sources.get(url), shortCircuit: true } : next(url, context)),
  });
  const modules = {
    url: (key) => PREFIX + encodeURIComponent(key),
    put: (url, source) => void sources.set(url, source),
  };
  const { createNodeNet } = await import("./node-net.mjs");
  const { startEngineHost } = await import("../src/engine-host.js");
  await startEngineHost({
    instance,
    moduleUrls: "data",
    modules,
    fetch: nodeFetch,
    net: subprocess.engineNet(withNet ? createNodeNet({ net, http, https, zlib }) : undefined),
    onExit(exitCode) {
      finish(exitCode);
    },
  });
}
run().catch((error) => {
  if (child) child.stderr.writeAll(new TextEncoder().encode(`${error.stack || error}\n`));
  else nodeProcess.stderr.write(`${error.stack || error}\n`);
  finish(1);
});
