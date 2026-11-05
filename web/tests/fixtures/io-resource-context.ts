import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as nodePath from "node:path";
import * as nodeUtil from "node:util";
import { createContext, runInContext, type Context } from "node:vm";
import { createScriptEvaluation } from "../../src/script-evaluation.ts";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../../src/buffer-transfer.ts";
import { createNodeAsyncContext } from "../../scripts/async-context.ts";
import { builtinsSource, engineHostSource } from "./engine-host-context.ts";
import { CASES, RETIREMENT } from "./io-resource-scenarios.ts";

// Pump-driven resource callbacks (fs.watch, child IPC, Bun.spawn, process.stdin, Bun.serve) on
// the maintained modules, net.js's scheduler, events.ts and the shipped stream core, over
// engine-host.js with bootstrap.js's context, timers and ticks. The host's own pump enters each
// turn at the root frame. Only the native ABI is a fixture: watch records, descriptor reads and
// writes, process start and wait, and one accepted HTTP connection.
//
// Modes: `hooks` (the host's frame slot) and `native` (a native continuation provider, which the
// root entry leaves alone). Each case registers in frame A, then switches the ambient frame to
// "unrelated" before the host pumps. Hooks mode also checks, with --expose-gc, whether a retired
// resource still holds its frame.

const MODULES = [
  "resource_frame", "events", "http_common", "net_port", "net_listener", "net_address", "net_hostname", "tls_transport", "http_response",
  "serve_request_lifetime", "net", "fs_options", "fs_watch", "child_ipc", "spawn", "node_stream_core", "process_stdin",
];
const runtime = new URL("../../../crates/bunwasm-runtime/src/js/", import.meta.url);
const JAVASCRIPT = new Set(["net", "node_stream_core"]);

// bootstrap.js from runInContext through its timer, immediate and tick queues.
function bootstrapSource(): string {
  const bootstrap = readFileSync(new URL("bootstrap.js", runtime), "utf8");
  const start = bootstrap.indexOf("  function runInContext(context, fn, thisArg, args) {");
  const end = bootstrap.indexOf("  function queueMicrotask(callback) {", start);
  assert(start >= 0 && end > start);
  return `${bootstrap.slice(start, end)}
    internal.realTimers = { setImmediate: realSetImmediate, clearImmediate: realClearImmediate, setTimeout: realSetTimeout, clearTimeout: realClearTimeout };\n`;
}

function hostContext(native: boolean): Context {
  const context = createContext({
    assert, TextEncoder, TextDecoder, URL, Blob, MessageChannel, AbortSignal, AbortController, setTimeout, clearTimeout,
    queueMicrotask, createScriptEvaluation, isWasmMemoryBuffer, transferArrayBuffers, SLOT_NAMES: [], memoryViews: () => ({}),
    EventEmitter, Buffer, nodePath, nodeUtil, Request, Response, Headers, ReadableStream, DOMException, structuredClone, WeakRef,
    provider: native ? createNodeAsyncContext() : undefined,
  });
  runInContext(`${engineHostSource()}
    const host = new EngineHost({ instance: { exports: {} }, asyncContext: provider }, () => {});
    host.pendingAsync = 1; host.schedule = () => {}; host.uncaught = error => { throw error; };
    // Watch records for the first watcher opened; watches[n] for the nth.
    const state = { reads: [], watch: [], closed: [], writable: false, fd: 10, started: 0, exited: false, accepted: [8], input: [] };
    state.watches = [];
    const native = Object.assign(host.valueNatives(), {
      hostCaps: { proc_spawn: true }, now: () => Date.now(), flushOutput() {}, wake() {},
      platformInfo: { version: "control" }, domainToASCII: value => value,
      isatty: () => false, cwd: () => "/work", stat: () => ({ mode: 0o040755 }), fstat: () => ({ mode: 0o010000 }),
      fsWatchOpen: () => 40 + state.watches.push(state.watches.length ? [] : state.watch) - 1,
      fsWatchRead: id => state.watches[id - 40].shift() ?? -6,
      fsWatchClose: id => { state.closed.push(id); return 0; },
      procRead: () => { const next = state.reads.shift() ?? -6; if (next instanceof Error) throw next; return next; },
      procWrite: (_fd, bytes) => state.writable ? bytes.length : -6,
      procClose: fd => { state.closed.push(fd); return 0; }, procPoll: () => new Uint8Array(),
      procPipe: () => [state.fd++, state.fd++], procAccess: () => 0, procSpawn: () => 101, procJobOf: () => 3, procStartStatus: () => state.started,
      procWait: () => state.exited === true ? [0, 0] : state.exited || -6, procWaitJob: () => [0, 0], procKill: () => 0, procKillJob: () => 0,
      hostListen: () => 7, hostLocalPort: () => 1234, hostAccept: () => state.accepted.shift() ?? -2,
      hostRead: () => state.input.shift() ?? -2, hostWrite: (_id, bytes) => bytes.length,
      hostPeerAddr: () => '{"address":"127.0.0.1","port":1235,"family":"IPv4"}',
      hostClose: id => { state.closed.push(id); return 0; },
      hostError: () => '{"code":"EIO","message":"control error"}',
      latin1Decode: bytes => Buffer.from(bytes).toString("latin1"),
    });
    host.native = native;
    const modules = {
      events: EventEmitter, buffer: { Buffer }, path: nodePath,
      process: Object.assign(new EventEmitter(), { env: {}, execPath: "bun", execArgv: [], cwd: () => "/work" }),
      package_scripts: { spawnArguments: argv => argv }, websocket: { clientClass: () => undefined },
      html_server: { websocket: () => undefined, developmentEnabled: () => false, isBundle: () => false, attach() {}, dispose() {}, upgrade: () => false, asset: async () => undefined },
    };
    const internal = {
      native, builtinFactories: {}, web: { Request, Response, Headers, ReadableStream, DOMException, AbortController },
      require: name => modules[name] ?? {},
      builtin: name => name === "node:stream" ? modules.stream : name === "node:process" ? { nextTick: internal.nextTick, env: {}, emitWarning() {} }
        : name === "node:buffer" ? { Buffer } : name === "node:events" ? modules.events : nodeUtil,
      pumpSignals: () => false, handleUncaught: error => { throw error; }, printError: error => { throw error; },
      describe: String, toUint8: value => value, concatBytes: chunks => Buffer.concat(chunks),
    };
    globalThis.process = modules.process;
    host.internal = internal;
    ${bootstrapSource()}
    ${builtinsSource()}
    host.installGlobals();
    host.wrapPromiseJobs();
    const storage = new (internal.builtinFactories["node:async_hooks"]().AsyncLocalStorage)();
    // A frame is a name, or an object { frame: name } where retention is checked.
    const name = store => typeof store === "object" && store !== null ? store.frame : store ?? null;
    const records = [];
    const see = (site, ...extra) => records.push([site, name(storage.getStore())].concat(extra));
  `, context);
  for (const module of MODULES) {
    const extension = JAVASCRIPT.has(module) ? "js" : "ts";
    const text = readFileSync(new URL(`${module}.${extension}`, runtime), "utf8");
    context.factory = runInContext(extension === "ts" ? stripTypeScriptTypes(text) : text, context);
    runInContext(`modules[${JSON.stringify(module)}] = factory(internal);`, context);
  }
  runInContext(`modules.stream = modules.node_stream_core.Stream;
    const files = { statSync() {}, toPath: path => path, absolute: path => path };
    const watch = (...args) => modules.fs_watch(files).watch(...args);
    const record = new Uint8Array([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);`, context);
  return context;
}

function closeHost(context: Context): void {
  runInContext(`host.exited = true; internal.cancelIoWaiters(); internal.runTicks();
    native.setAsyncContext(undefined); host.channel?.port1.close(); host.channel?.port2.close();`, context);
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

async function scenario(native: boolean, code: string): Promise<unknown> {
  const context = hostContext(native);
  try {
    runInContext(`storage.enterWith("A"); ${code}\nstorage.enterWith("unrelated");`, context);
    for (let n = 0; n < 12; n++) {
      runInContext("host.pump();", context);
      await turn();
    }
    return runInContext("records", context);
  } finally {
    closeHost(context);
  }
}

async function collect(): Promise<void> {
  for (let n = 0; n < 6; n++) { await turn(); globalThis.gc!(); }
}

// Each step runs at the root frame with the ambient slot cleared, then the marker frame's
// reachability is checked: true while something still holds it.
async function retirement(steps: readonly string[]): Promise<boolean[]> {
  const context = hostContext(false);
  const held: boolean[] = [];
  try {
    for (const step of steps) {
      runInContext(`native.setAsyncContext(undefined); ${step}\nnative.setAsyncContext(undefined);`, context);
      await collect();
      held.push(runInContext("marker.deref() !== undefined", context));
    }
    return held;
  } finally {
    closeHost(context);
  }
}

const mode = process.argv[2];
if (mode !== "hooks" && mode !== "native") throw new Error("mode must be hooks or native");
const results: Record<string, unknown> = {};
for (const [name, code] of Object.entries(CASES)) results[name] = await scenario(mode === "native", code);
const output: Record<string, unknown> = { mode, results };
if (mode === "hooks") {
  assert(globalThis.gc, "run with --expose-gc");
  const retired: Record<string, boolean[]> = {};
  for (const [name, steps] of Object.entries(RETIREMENT)) retired[name] = await retirement(steps);
  output.retirement = retired;
}
console.log(`IO_RESOURCE_CONTEXT ${JSON.stringify(output)}`);
