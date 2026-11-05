import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createServer, request, Server } from "node:http";
import { createConnection, createServer as createTcpServer, Socket, type AddressInfo, type Server as TcpServer } from "node:net";
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
// acceptance and its connections carry the listen-time frame themselves. A raw node:net
// server's listening, connection and bind error callbacks do the same, and an outbound
// socket's connect and data callbacks keep the frame current when `connect` ran.
//
// Modes: `reference` runs each scenario on Node's own server or socket; `hooks` and `native`
// run the maintained net.js, node_net, net_listener, HTTP parser and request dispatch on
// engine-host.js, stepped by the host's own scheduler, with the hook slot or a native
// continuation provider. Only the host socket ABI is a fixture: one bind, one accepted
// connection, one request, or one outbound connection that reads one chunk. The second
// argument picks the protocol: `http` (default), `tcp`, `dial`, or `unix`, a host-only dial
// over a socket path that the test compares with the TCP dial reference.

type Protocol = "http" | "tcp" | "dial" | "unix";
type Kind = "enterWith" | "run" | "ambient" | "root" | "error";
type Observation = [site: string, store: unknown];
const KINDS: Kind[] = ["enterWith", "run", "ambient", "root", "error"];
// Outbound connection failure is not compared: the fixture's streams are Node's own, whose
// deferred error emission does not run on the guest's ticks.
const DIAL_KINDS: Kind[] = ["enterWith", "run", "ambient", "root"];
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

// The outbound counterpart: `connect()` dials, and the socket records its connect and data.
const DIAL_SCENARIO = `(function (storage, socket, kind, connect) {
  const observations = [];
  const see = (site) => observations.push([site, storage.getStore() ?? null]);
  socket.on("connect", () => see("connect"));
  socket.on("data", () => see("data"));
  if (kind === "run") storage.run("dial-frame", connect);
  else if (kind === "root") connect();
  else { storage.enterWith("dial-frame"); connect(); }
  if (kind === "ambient" || kind === "root") storage.enterWith("unrelated");
  return { observations };
})`;

const EXPECTED: Record<Kind, Observation[]> = {
  enterWith: [["listening", "listen-frame"], ["connection", "listen-frame"], ["request", "listen-frame"], ["close", "closer"]],
  run: [["listening", "listen-frame"], ["connection", "listen-frame"], ["request", "listen-frame"], ["close", "closer"]],
  ambient: [["listening", "listen-frame"], ["connection", "listen-frame"], ["request", "listen-frame"], ["close", "closer"]],
  root: [["listening", null], ["connection", null], ["request", null], ["close", "closer"]],
  error: [["error", "listen-frame"]],
};

// Node gives an accepted raw socket its own frame, so its data callback is not compared here;
// the maintained socket reads in the listen-time frame, as the request path does.
const EXPECTED_TCP: Record<Kind, Observation[]> = {
  enterWith: [["listening", "listen-frame"], ["connection", "listen-frame"], ["close", "closer"]],
  run: [["listening", "listen-frame"], ["connection", "listen-frame"], ["close", "closer"]],
  ambient: [["listening", "listen-frame"], ["connection", "listen-frame"], ["close", "closer"]],
  root: [["listening", null], ["connection", null], ["close", "closer"]],
  error: [["error", "listen-frame"]],
};

const EXPECTED_DIAL: Partial<Record<Kind, Observation[]>> = {
  enterWith: [["connect", "dial-frame"], ["data", "dial-frame"]],
  run: [["connect", "dial-frame"], ["data", "dial-frame"]],
  ambient: [["connect", "dial-frame"], ["data", "dial-frame"]],
  root: [["connect", null], ["data", null]],
};

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), 5_000); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function closeNode(server: Server | TcpServer): Promise<void> {
  if (server instanceof Server) server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function referenceRequest(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, agent: false }, response => { response.resume(); response.once("end", resolve); });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function referenceConnection(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = createConnection({ host: "127.0.0.1", port });
    client.once("error", reject);
    client.once("close", () => resolve());
    client.resume();
  });
}

async function referenceScenario(protocol: Protocol, kind: Kind): Promise<Observation[]> {
  const storage = new AsyncLocalStorage<string>();
  const blocker = createServer();
  const server = protocol === "tcp" ? createTcpServer(socket => socket.destroy()) : createServer();
  try {
    if (kind === "error") await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
    const port = kind === "error" ? (blocker.address() as AddressInfo).port : 0;
    // oxlint-disable-next-line no-eval -- Evaluate the shared scenario text as the host modes do.
    const scenario: Scenario = (0, eval)(SCENARIO)(storage, server, kind, () => server.listen(port, "127.0.0.1"));
    await within(scenario.settled, `${kind} listen`);
    if (!server.listening) return scenario.observations;
    const bound = (server.address() as AddressInfo).port;
    await (protocol === "tcp" ? referenceConnection(bound) : referenceRequest(bound));
    if (server instanceof Server) server.closeAllConnections();
    await new Promise<void>(resolve => storage.run("closer", () => server.close(() => { scenario.see("close"); resolve(); })));
    return scenario.observations;
  } finally {
    if (server.listening) await closeNode(server);
    if (blocker.listening) await closeNode(blocker);
  }
}

async function referenceDial(kind: Kind): Promise<Observation[]> {
  const storage = new AsyncLocalStorage<string>();
  const server = createTcpServer(socket => socket.end("hi"));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new Socket();
    const closed = new Promise<void>((resolve, reject) => { socket.once("close", () => resolve()); socket.once("error", reject); });
    // oxlint-disable-next-line no-eval -- Evaluate the shared scenario text as the host modes do.
    const scenario: { observations: Observation[] } = (0, eval)(DIAL_SCENARIO)(storage, socket, kind, () => socket.connect(port, "127.0.0.1"));
    await within(closed, `${kind} dial`);
    return scenario.observations;
  } finally {
    if (server.listening) await closeNode(server);
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
      hostCaps: { connect: true }, flushOutput() {}, latin1Decode: bytes => Buffer.from(bytes).toString("latin1"),
      hostListen: () => 7, hostConnect: () => 9, hostConnectPath: () => 9, hostLocalPort: () => 1234,
      // Readiness lands on the host's next scheduler turn, after the scenario's synchronous code.
      hostLocalAddr: () => kind === "error" ? -1 : '{"address":"127.0.0.1","port":1234,"family":"IPv4"}',
      hostPeerAddr: () => '{"address":"127.0.0.1","port":1235,"family":"IPv4"}',
      // A listener whose bind failed has nothing to accept.
      hostAccept: () => kind === "error" ? -1 : accepted.shift() ?? -2, hostRead: () => input.shift() ?? -2,
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
      // A destroyed socket's close callback; the fixture runs it with the ticks.
      realTimers: { setImmediate: (fn, ...args) => internal.nextTick(fn, ...args) },
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

function closeHost(context: Context): void {
  runInContext("host.exited = true; host.channel?.port1.close(); host.channel?.port2.close();", context);
}

// HTTP is served once its request ran; a raw TCP server once its connection did, and that
// accepted socket is then destroyed, as the reference's is.
const SERVER = {
  http: `const server = modules.net.nodeHttp("http:").createServer();
    server.on("request", () => queueMicrotask(serve));`,
  tcp: `const server = modules.net.nodeNet().createServer();
    server.on("connection", socket => { socket.destroy(); queueMicrotask(serve); });`,
};

async function hostScenario(protocol: "http" | "tcp", native: boolean, kind: Kind): Promise<Observation[]> {
  const context = hostContext(native, kind);
  try {
    let served = () => {};
    context.served = new Promise<void>(resolve => { served = resolve; });
    context.serve = () => served();
    const scenario: Scenario = runInContext(`
      ${SERVER[protocol]}
      (${SCENARIO})(storage, server, kind, () => server.listen(1234));
    `, context);
    await within(scenario.settled, `${kind} listen`);
    if (kind === "error") return scenario.observations;
    await within(context.served as Promise<void>, `${kind} request`);
    runInContext(`
      server.closeAllConnections?.();
      storage.run("closer", () => server.close(() => see("close")));
      internal.runTicks();
    `, Object.assign(context, { see: scenario.see }));
    return scenario.observations;
  } finally {
    closeHost(context);
  }
}

// The accepted input chunk doubles as the outbound socket's one read.
const DIAL = { dial: "socket.connect(1234)", unix: 'socket.connect({ path: "/fixture.sock" })' };

async function hostDial(protocol: "dial" | "unix", native: boolean, kind: Kind): Promise<Observation[]> {
  const context = hostContext(native, kind);
  try {
    let read = () => {};
    context.read = new Promise<void>(resolve => { read = resolve; });
    context.serve = () => read();
    const scenario: { observations: Observation[] } = runInContext(`
      const socket = new (modules.net.nodeNet().Socket)();
      socket.on("data", () => queueMicrotask(serve));
      (${DIAL_SCENARIO})(storage, socket, kind, () => ${DIAL[protocol]});
    `, context);
    await within(context.read as Promise<void>, `${kind} dial`);
    runInContext("socket.destroy(); internal.runTicks();", context);
    return scenario.observations;
  } finally {
    closeHost(context);
  }
}

// A synchronous pump inside the caller's own `run` steps the listener in its listen-time frame
// and hands the caller's frame back afterwards.
// The same holds for a raw TCP listener and for an outbound socket's connection step.
const CALLER_RESOURCE = {
  http: `const server = modules.net.nodeHttp("http:").createServer();
    server.on("listening", () => seen.push(["listening", storage.getStore() ?? null]));
    storage.enterWith("listen-frame");
    server.listen(1234);`,
  tcp: `const server = modules.net.nodeNet().createServer();
    server.on("listening", () => seen.push(["listening", storage.getStore() ?? null]));
    storage.enterWith("listen-frame");
    server.listen(1234);`,
  dial: `const socket = new (modules.net.nodeNet().Socket)();
    socket.on("connect", () => seen.push(["connect", storage.getStore() ?? null]));
    storage.enterWith("dial-frame");
    socket.connect(1234);`,
  unix: `const socket = new (modules.net.nodeNet().Socket)();
    socket.on("connect", () => seen.push(["connect", storage.getStore() ?? null]));
    storage.enterWith("dial-frame");
    socket.connect({ path: "/fixture.sock" });`,
};

function callerFrame(protocol: Protocol): Observation[] {
  const context = hostContext(false, "enterWith");
  try {
    return runInContext(`
      host.schedule = () => {};
      const seen = [];
      ${CALLER_RESOURCE[protocol]}
      storage.run("caller", () => {
        internal.pumpIo();
        internal.pumpIo();
        seen.push(["caller", storage.getStore() ?? null]);
      });
      ${protocol === "dial" || protocol === "unix" ? "socket.destroy();" : "server.close();"}
      seen;
    `, context);
  } finally {
    closeHost(context);
  }
}

async function scenarios(kinds: Kind[], run: (kind: Kind) => Promise<Observation[]>): Promise<Record<string, Observation[]>> {
  const results: Record<string, Observation[]> = {};
  for (const kind of kinds) results[kind] = await run(kind);
  return results;
}

function hostRun(protocol: Protocol, native: boolean): (kind: Kind) => Promise<Observation[]> {
  if (protocol === "dial" || protocol === "unix") return kind => hostDial(protocol, native, kind);
  return kind => hostScenario(protocol, native, kind);
}

const mode = process.argv[2];
const protocol = (process.argv[3] ?? "http") as Protocol;
const expected = { http: EXPECTED, tcp: EXPECTED_TCP, dial: EXPECTED_DIAL, unix: EXPECTED_DIAL }[protocol];
const kinds = protocol === "dial" || protocol === "unix" ? DIAL_KINDS : KINDS;
if (!expected) throw new Error("protocol must be http, tcp, dial or unix");
if (mode === "reference" && protocol === "unix") {
  throw new Error("unix dialing has no reference of its own; compare it with dial's");
} else if (mode === "reference") {
  const results = await scenarios(kinds, kind => protocol === "dial" ? referenceDial(kind) : referenceScenario(protocol, kind));
  assert.deepEqual(results, expected);
  console.log(`LISTEN_CONTEXT_RESULT ${JSON.stringify({ mode, results })}`);
} else if (mode === "hooks" || mode === "native") {
  const results = await scenarios(kinds, hostRun(protocol, mode === "native"));
  console.log(`LISTEN_CONTEXT_RESULT ${JSON.stringify({ mode, results, caller: mode === "hooks" ? callerFrame(protocol) : undefined, expected })}`);
} else {
  throw new Error("mode must be reference, hooks or native");
}
