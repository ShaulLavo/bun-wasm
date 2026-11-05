import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { Duplex, Readable, Writable, getDefaultHighWaterMark } from "node:stream";
import { createContext, runInContext, type Context } from "node:vm";
import { createScriptEvaluation } from "../../src/script-evaluation.ts";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../../src/buffer-transfer.ts";
import { createNodeAsyncContext } from "../../scripts/async-context.ts";
import { builtinsSource, engineHostSource, runInContextSource } from "./engine-host-context.ts";
import { KINDS, SCENARIO, type Kind, type Sites } from "./bun-listen-scenario.ts";

// The shared Bun.listen and Bun.connect scenario on the maintained bun_tcp adapter, over
// net.js, node_net and net_listener, on engine-host.js with bootstrap.js's timers and ticks.
// The host's own scheduler steps every turn and enters it at the root frame. Only the host
// socket ABI is a fixture: one bind, one accepted connection that reads "x" then EOF, and one
// outbound connection that reads "hi" then EOF.
//
// Modes: `hooks` (the host's frame slot) and `native` (a native continuation provider). Hooks
// mode also reports the caller's frame around a synchronous pump, and, with --expose-gc,
// whether each stop path still holds the listen-time frame.

const MODULES = [
  "net_port.ts", "net_address.ts", "net_hostname.ts", "net_path.ts", "net_listener.ts", "http_common.ts", "http_agent.ts",
  "http_server_response.ts", "node_net_server.ts", "node_net_socket_state.ts", "node_net_socket_options.ts",
  "node_net_onread.ts", "node_net.js", "tls_transport.ts", "net.js", "bun_tcp.ts",
];
const runtime = new URL("../../../crates/bunwasm-runtime/src/js/", import.meta.url);

// bootstrap.js's timer, immediate and tick queues, which the host's pump runs.
function timersSource(): string {
  const bootstrap = readFileSync(new URL("bootstrap.js", runtime), "utf8");
  const start = bootstrap.indexOf("  let timerSeq = 1;");
  const end = bootstrap.indexOf("  function queueMicrotask(callback) {", start);
  assert(start >= 0 && end > start);
  return `${bootstrap.slice(start, end)}\n  internal.realTimers = { setImmediate };\n`;
}

function hostContext(native: boolean): Context {
  const context = createContext({
    TextEncoder, TextDecoder, URL, Blob, MessageChannel, setTimeout, clearTimeout, queueMicrotask,
    createScriptEvaluation, isWasmMemoryBuffer, transferArrayBuffers, SLOT_NAMES: [], memoryViews: () => ({}),
    EventEmitter, Readable, Writable, Duplex, getDefaultHighWaterMark, Buffer, WeakRef,
    provider: native ? createNodeAsyncContext() : undefined,
  });
  runInContext(`${engineHostSource()}
    const host = new EngineHost({ instance: { exports: {} }, asyncContext: provider }, () => {});
    host.pendingAsync = 1;
    host.uncaught = error => { throw error; };
    const bytes = text => new TextEncoder().encode(text);
    const sockets = { accepted: [8], inputs: new Map([[8, [bytes("x"), 0]], [9, [bytes("hi"), 0]]]) };
    const native = Object.assign(host.valueNatives(), {
      hostCaps: { connect: true }, now: () => Date.now(), flushOutput() {},
      latin1Decode: chunk => Buffer.from(chunk).toString("latin1"),
      hostListen: () => 7, hostConnect: () => 9, hostLocalPort: () => 1234,
      hostLocalAddr: () => '{"address":"127.0.0.1","port":1234,"family":"IPv4"}',
      hostPeerAddr: () => '{"address":"127.0.0.1","port":1235,"family":"IPv4"}',
      hostAccept: () => sockets.accepted.shift() ?? -2,
      hostRead: handle => sockets.inputs.get(handle)?.shift() ?? -2,
      hostWrite: (_handle, chunk) => chunk.length, hostShutdown: () => 0, hostClose: () => 0,
      hostError: () => '{"name":"Error","message":"connection failed","code":"ECONNRESET"}',
    });
    host.native = native;
    const modules = { events: EventEmitter, buffer: { Buffer }, websocket: { clientClass: () => undefined } };
    const internal = {
      native, builtinFactories: {}, web: {}, require: name => modules[name] ?? {},
      builtin: name => name === "node:net" ? modules.net.nodeNet() : name === "node:http" ? { STATUS_CODES: { 200: "OK" } } : { Readable, Writable, Duplex, getDefaultHighWaterMark },
      pumpSignals: () => false, handleUncaught: error => { throw error; }, printError: error => { throw error; },
      describe: String, toUint8: value => value, concatBytes: chunks => Buffer.concat(chunks),
    };
    host.internal = internal;
    ${runInContextSource()}
    ${timersSource()}
    ${builtinsSource()}
    host.installGlobals();
    host.wrapPromiseJobs();
    const storage = new (internal.builtinFactories["node:async_hooks"]().AsyncLocalStorage)();
  `, context);
  for (const name of MODULES) {
    const source = readFileSync(new URL(name, runtime), "utf8");
    context.factory = runInContext(name.endsWith(".ts") ? stripTypeScriptTypes(source) : source, context);
    runInContext(`modules[${JSON.stringify(name.replace(/\.(ts|js)$/, ""))}] = factory(internal);`, context);
  }
  runInContext("const tcp = modules.net.bunTcp();", context);
  return context;
}

function closeHost(context: Context): void {
  runInContext(`host.exited = true; host.schedule = () => {}; internal.cancelIoWaiters(); internal.runTicks();
    native.setAsyncContext(undefined); host.channel?.port1.close(); host.channel?.port2.close();`, context);
}

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 5));

async function until(predicate: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (!predicate()) {
    assert(Date.now() < end, `${what} timed out`);
    await turn();
  }
}

async function scenario(native: boolean, kind: Kind): Promise<Sites> {
  const context = hostContext(native);
  try {
    context.closed = false;
    const run: { seen: Sites } = runInContext(`(${SCENARIO})(storage, tcp, ${JSON.stringify(kind)}, () => { closed = true; })`, context);
    await until(() => context.closed as boolean, `${kind} sockets`);
    return run.seen;
  } finally {
    closeHost(context);
  }
}

// A synchronous pump inside the caller's own `run` accepts in the listen-time frame and hands
// the caller's frame back afterwards.
function callerFrame(): [string, unknown][] {
  const context = hostContext(false);
  try {
    return runInContext(`
      host.schedule = () => {};
      const seen = [];
      storage.enterWith("listen-frame");
      const listener = tcp.listen({ port: 0, socket: { data() {}, open(socket) { seen.push(["open", storage.getStore() ?? null]); socket.terminate(); } } });
      storage.run("caller", () => {
        internal.pumpIo();
        seen.push(["caller", storage.getStore() ?? null]);
      });
      listener.stop(true);
      seen;
    `, context);
  } finally {
    closeHost(context);
  }
}

// Each stop path, with the listener itself still reachable: does it hold the listen-time frame?
// `active` is checked while an accepted socket is still open, `stopped` after every path ends.
const RETIREMENT: Record<string, { accepted: number[]; end: string }> = {
  "stop without sockets": { accepted: [], end: "listener.stop();" },
  "force stop with a live socket": { accepted: [8], end: "listener.stop(true);" },
  "stop, then the live socket closes": { accepted: [8], end: "listener.stop(); socket.terminate();" },
};

async function collect(): Promise<void> {
  for (let n = 0; n < 6; n++) { await turn(); globalThis.gc!(); }
}

async function retirement(name: string): Promise<{ active?: boolean; stopped: boolean; reachable: boolean }> {
  const context = hostContext(false);
  const { accepted, end } = RETIREMENT[name]!;
  try {
    runInContext(`
      sockets.accepted = ${JSON.stringify(accepted)};
      sockets.inputs.clear();
      var socket;
      var listener = storage.run({ frame: "listen-frame" }, () => {
        globalThis.frameRef = new WeakRef(storage.getStore());
        return tcp.listen({ port: 0, socket: { data() {}, open(accepted) { socket = accepted; } } });
      });
    `, context);
    if (accepted.length) await until(() => runInContext("socket !== undefined", context), `${name} accept`);
    runInContext("internal.runTicks(); native.setAsyncContext(undefined);", context);
    await collect();
    const active = accepted.length ? runInContext("frameRef.deref() !== undefined", context) as boolean : undefined;
    runInContext(`${end} internal.runTicks(); native.setAsyncContext(undefined);`, context);
    await collect();
    return {
      active,
      stopped: runInContext("frameRef.deref() !== undefined", context),
      reachable: runInContext("listener !== undefined && listener._sockets.size === 0 && internal.ioPending() === 0", context),
    };
  } finally {
    closeHost(context);
  }
}

const mode = process.argv[2];
if (mode !== "hooks" && mode !== "native") throw new Error("mode must be hooks or native");
const results: Record<string, Sites> = {};
for (const kind of KINDS) results[kind] = await scenario(mode === "native", kind);
const output: Record<string, unknown> = { mode, results };
if (mode === "hooks") {
  output.caller = callerFrame();
  assert(globalThis.gc, "run with --expose-gc");
  const retired: Record<string, unknown> = {};
  for (const name of Object.keys(RETIREMENT)) retired[name] = await retirement(name);
  output.retirement = retired;
}
console.log(`BUN_LISTEN_CONTEXT ${JSON.stringify(output)}`);
