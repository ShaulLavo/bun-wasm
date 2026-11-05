import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { Duplex, Readable, Writable, getDefaultHighWaterMark } from "node:stream";
import { createContext, runInContext, type Context } from "node:vm";
import { createScriptEvaluation } from "../../src/script-evaluation.ts";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../../src/buffer-transfer.ts";
import { createNodeAsyncContext } from "../../scripts/async-context.ts";
import { builtinsSource, engineHostSource, runInContextSource } from "./engine-host-context.ts";

// The frame a node:http server's callbacks see is the one current when `listen` ran, as under
// Node: `enterWith` before it, a scoped `run` around it, and not an unrelated frame entered
// after it. The host's root entry resets the ambient frame each turn, so the listener, its
// acceptance and its connections carry the listen-time frame themselves.
//
// Modes: `reference` runs each scenario on Node's own HTTP server; `hooks` and `native` run
// the maintained net.js, net_listener, HTTP parser and request dispatch on engine-host.js,
// stepped by the host's own scheduler, with the hook slot or a native continuation provider.
// Only the host socket ABI is a fixture: one bind, one accepted connection, one request.

type Kind = "enterWith" | "run" | "ambient" | "root" | "error";
type Observation = [site: string, store: unknown];
const KINDS: Kind[] = ["enterWith", "run", "ambient", "root", "error"];
const REQUEST = "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
const MODULES = [
  "net_port.ts", "net_address.ts", "net_hostname.ts", "net_path.ts", "net_listener.ts", "http_common.ts", "http_agent.ts",
  "http_server_response.ts", "node_net_server.ts", "node_net_socket_state.ts", "node_net_socket_options.ts",
  "node_net_onread.ts", "node_net.js", "tls_transport.ts", "net.js",
];

// One scenario text for every mode: `listen(port)` starts the server, `settled` resolves once
// the listening or error callback ran.
const SCENARIO = `(function (storage, server, kind, listen) {
  const observations = [];
  const see = (site) => observations.push([site, storage.getStore() ?? null]);
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  server.on("connection", () => see("connection"));
  server.on("request", (_request, response) => { see("request"); response.end("ok"); });
  server.once("listening", () => { see("listening"); settle(); });
  server.once("error", () => { see("error"); settle(); });
  if (kind === "run") storage.run("listen-frame", listen);
  else if (kind === "root") listen();
  else { storage.enterWith("listen-frame"); listen(); }
  if (kind === "ambient" || kind === "root") storage.enterWith("unrelated");
  return { observations, settled, see };
})`;

type Scenario = { observations: Observation[]; settled: Promise<void>; see(site: string): void };

const EXPECTED: Record<Kind, Observation[]> = {
  enterWith: [["listening", "listen-frame"], ["connection", "listen-frame"], ["request", "listen-frame"], ["close", "closer"]],
  run: [["listening", "listen-frame"], ["connection", "listen-frame"], ["request", "listen-frame"], ["close", "closer"]],
  ambient: [["listening", "listen-frame"], ["connection", "listen-frame"], ["request", "listen-frame"], ["close", "closer"]],
  root: [["listening", null], ["connection", null], ["request", null], ["close", "closer"]],
  error: [["error", "listen-frame"]],
};

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), 5_000); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function closeNode(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function referenceRequest(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, agent: false }, response => { response.resume(); response.once("end", resolve); });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function referenceScenario(kind: Kind): Promise<Observation[]> {
  const storage = new AsyncLocalStorage<string>();
  const blocker = createServer();
  const server = createServer();
  try {
    if (kind === "error") await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
    const port = kind === "error" ? (blocker.address() as AddressInfo).port : 0;
    const scenario: Scenario = (0, eval)(SCENARIO)(storage, server, kind, () => server.listen(port, "127.0.0.1"));
    await within(scenario.settled, `${kind} listen`);
    if (!server.listening) return scenario.observations;
    await referenceRequest((server.address() as AddressInfo).port);
    server.closeAllConnections();
    await new Promise<void>(resolve => storage.run("closer", () => server.close(() => { scenario.see("close"); resolve(); })));
    return scenario.observations;
  } finally {
    if (server.listening) await closeNode(server);
    if (blocker.listening) await closeNode(blocker);
  }
}

// The host the maintained modules run on. Every pump is the host's scheduler task.
function hostContext(native: boolean, kind: Kind): Context {
  const context = createContext({
    TextEncoder, TextDecoder, URL, Blob, MessageChannel, setTimeout, clearTimeout, queueMicrotask,
    createScriptEvaluation, isWasmMemoryBuffer, transferArrayBuffers, SLOT_NAMES: [], memoryViews: () => ({}),
    EventEmitter, Readable, Writable, Duplex, getDefaultHighWaterMark, Buffer,
    provider: native ? createNodeAsyncContext() : undefined, kind, REQUEST,
  });
  runInContext(`${engineHostSource()}
    const host = new EngineHost({ instance: { exports: {} }, asyncContext: provider }, () => {});
    host.pendingAsync = 1;
    host.uncaught = error => { throw error; };
    const accepted = [8], input = [new TextEncoder().encode(REQUEST)];
    const native = Object.assign(host.valueNatives(), {
      hostCaps: {}, flushOutput() {}, latin1Decode: bytes => Buffer.from(bytes).toString("latin1"),
      hostListen: () => 7, hostLocalPort: () => 1234,
      // Readiness lands on the host's next scheduler turn, after the scenario's synchronous code.
      hostLocalAddr: () => kind === "error" ? -1 : '{"address":"127.0.0.1","port":1234,"family":"IPv4"}',
      hostPeerAddr: () => '{"address":"127.0.0.1","port":1235,"family":"IPv4"}',
      hostAccept: () => accepted.shift() ?? -2, hostRead: () => input.shift() ?? -2,
      hostWrite: (_handle, bytes) => bytes.length, hostClose: () => 0,
      hostError: () => '{"name":"Error","message":"address in use","code":"EADDRINUSE"}',
    });
    host.native = native;
    const modules = { events: EventEmitter, buffer: { Buffer }, websocket: { clientClass: () => undefined } };
    const builtins = { "node:net": () => modules.net.nodeNet(), "node:http": () => ({ STATUS_CODES: { 200: "OK" } }) };
    // Ticks keep their registration frame, as bootstrap.js's nextTick does.
    const ticks = [];
    const internal = {
      native, builtinFactories: {}, web: {}, require: name => modules[name] ?? {},
      builtin: name => builtins[name] ? builtins[name]() : { Readable, Writable, Duplex, getDefaultHighWaterMark },
      nextTick: (fn, ...args) => ticks.push([fn, args, native.getAsyncContext()]),
      runTicks: () => { while (ticks.length) { const [fn, args, frame] = ticks.shift(); internal.runInContext(frame, fn, undefined, args); } },
      pumpSignals: () => false, runTimers: () => -1, handleUncaught: error => { throw error; }, printError: error => { throw error; },
      concatBytes: chunks => Buffer.concat(chunks),
    };
    host.internal = internal;
    ${runInContextSource()}
    ${builtinsSource()}
    host.installGlobals();
    host.wrapPromiseJobs();
    const storage = new (internal.builtinFactories["node:async_hooks"]().AsyncLocalStorage)();
  `, context);
  for (const name of MODULES) loadModule(context, name);
  return context;
}

function loadModule(context: Context, name: string): void {
  const source = readFileSync(new URL(`../../../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
  context.factory = runInContext(name.endsWith(".ts") ? stripTypeScriptTypes(source) : source, context);
  runInContext(`modules[${JSON.stringify(name.replace(/\.(ts|js)$/, ""))}] = factory(internal);`, context);
}

async function hostScenario(native: boolean, kind: Kind): Promise<Observation[]> {
  const context = hostContext(native, kind);
  try {
    let served = () => {};
    context.served = new Promise<void>(resolve => { served = resolve; });
    context.serve = () => served();
    const scenario: Scenario = runInContext(`
      const server = modules.net.nodeHttp("http:").createServer();
      server.on("request", () => queueMicrotask(serve));
      (${SCENARIO})(storage, server, kind, () => server.listen(1234));
    `, context);
    await within(scenario.settled, `${kind} listen`);
    if (kind === "error") return scenario.observations;
    await within(context.served as Promise<void>, `${kind} request`);
    runInContext(`
      server.closeAllConnections();
      storage.run("closer", () => server.close(() => see("close")));
      internal.runTicks();
    `, Object.assign(context, { see: scenario.see }));
    return scenario.observations;
  } finally {
    runInContext("host.exited = true; host.channel?.port1.close(); host.channel?.port2.close();", context);
  }
}

// A synchronous pump inside the caller's own `run` steps the listener in its listen-time frame
// and hands the caller's frame back afterwards.
function callerFrame(): Observation[] {
  const context = hostContext(false, "enterWith");
  try {
    return runInContext(`
      host.schedule = () => {};
      const seen = [];
      const server = modules.net.nodeHttp("http:").createServer();
      server.on("listening", () => seen.push(["listening", storage.getStore() ?? null]));
      storage.enterWith("listen-frame");
      server.listen(1234);
      storage.run("caller", () => {
        internal.pumpIo();
        internal.pumpIo();
        seen.push(["caller", storage.getStore() ?? null]);
      });
      server.close();
      seen;
    `, context);
  } finally {
    runInContext("host.exited = true; host.channel?.port1.close(); host.channel?.port2.close();", context);
  }
}

async function scenarios(run: (kind: Kind) => Promise<Observation[]>): Promise<Record<string, Observation[]>> {
  const results: Record<string, Observation[]> = {};
  for (const kind of KINDS) results[kind] = await run(kind);
  return results;
}

const mode = process.argv[2];
if (mode === "reference") {
  const results = await scenarios(referenceScenario);
  assert.deepEqual(results, EXPECTED);
  console.log(`LISTEN_CONTEXT_RESULT ${JSON.stringify({ mode, results })}`);
} else if (mode === "hooks" || mode === "native") {
  const results = await scenarios(kind => hostScenario(mode === "native", kind));
  console.log(`LISTEN_CONTEXT_RESULT ${JSON.stringify({ mode, results, caller: mode === "hooks" ? callerFrame() : undefined, expected: EXPECTED })}`);
} else {
  throw new Error("mode must be reference, hooks or native");
}
