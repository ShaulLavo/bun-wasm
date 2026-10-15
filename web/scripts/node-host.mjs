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
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as zlib from "node:zlib";
import { resolve } from "node:path";
import { WASI } from "node:wasi";
import { fileURLToPath } from "node:url";

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
const args = argv.slice(i);
if (Object.keys(preopens).length === 0) {
  preopens[process.cwd()] = process.cwd();
  env.PWD ??= process.cwd();
}

const wasi = new WASI({ version: "preview1", args: ["bun", ...args], env, preopens, returnOnExit: true });
const module = await WebAssembly.compile(readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
const code = wasi.start(instance);
if (!instance.exports.bunwasm_ready || instance.exports.bunwasm_ready() !== 1) process.exit(code);

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
  net: withNet ? createNodeNet({ net, http, https, zlib }) : undefined,
  onExit(exitCode) {
    nodeProcess.exit(exitCode);
  },
});
