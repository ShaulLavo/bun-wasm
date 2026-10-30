import { createRuntime, type RuntimeNetworkHelper } from "waffle";
import { startRun, type Run } from "../src/runner";
import { Previews } from "../src/preview";
import type { BunNetworkOptions } from "../src/net/helper";
import { installBunAdapters } from "../../src/bun-adapter";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { bunRuntimeProcFixture } from "./bun-runtime-proc-fixtures";
import type { RuntimeWorkerMessage } from "waffle/browser/worker";

const workers = new Set<Worker>();
const NativeWorker = globalThis.Worker;
const writes: Int32Array[] = [];
function writeStats(start: number) {
  const replies = writes.slice(start);
  return { accepted: replies.reduce((total, reply) => total + Math.max(0, Atomics.load(reply, 1)), 0), again: replies.filter(reply => Atomics.load(reply, 1) === -2).length };
}
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); workers.add(this);
    this.addEventListener("message", ({ data }) => { if (data?.type === "net" && data.req?.type === "tcp-write") writes.push(new Int32Array(data.req.reply)); });
  }
  override terminate() { workers.delete(this); super.terminate(); }
};
const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) } });
const previews = new Previews();
const listeners = new Map<number, RuntimeNetworkHelper>();
const stopped: number[] = [];
const network: BunNetworkOptions = {
  fetch: async (url, init) => {
    if (url === "https://policy.invalid/") return new Response("injected policy", { headers: { "x-policy": "retained" } });
    return fetch(url, init);
  },
  listening(port, helper) { listeners.set(port, helper); previews.register(port, helper); },
  stopped(port, helper) { if (listeners.get(port) === helper) listeners.delete(port); previews.unregister(port, helper); stopped.push(port); },
};
let stdout = "", stderr = "";
const runs: Run[] = [];
const ports = { root: 31971, child: 31972, sibling: 31973 };
const hooks = { stdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); }, stderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); } };
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(`${label}: ${stdout}\n${stderr}`); }
async function until(ready: () => boolean, label: string) {
  const deadline = performance.now() + 30_000;
  while (!ready()) {
    if (performance.now() >= deadline) throw new Error(`${label}: ${stdout}\n${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const source = (port: number, peer: number) => `
const server = Bun.serve({port:${port}, async fetch(request) {
  const path=new URL(request.url).pathname;
  if(path==='/peer') return new Response(await (await fetch('http://localhost:${peer}/')).text());
  if(path==='/stop') { setTimeout(()=>server.stop(true),10); return new Response('stopped'); }
  if(path==='/stream') return new Response(new ReadableStream({pull(c){ c.enqueue(new Uint8Array(65536)); }}));
  if(path==='/socket') { server.upgrade(request); return; }
  return new Response('server-${port}',{headers:{'x-child':'alive','content-type':'text/html'}});
}, websocket:{message(ws,message){ws.send(message)}}});
if(process.send) process.send({ready:true});
`;
const client = (port: number, expected: string) => `const response${port}=await fetch('http://localhost:${port}/'); if(await response${port}.text()!==${JSON.stringify(expected)})throw Error('cross-process fetch'); console.log('fetch-${port}');`;
let module: WebAssembly.Module;
function root(code: string): Run {
  const run = startRun({ runtime, module, engine: "browser", moduleScope: false, args: ["-e", code], env: { PWD: "/home/user", PATH: "/bin:/usr/bin" }, network }, hooks);
  runs.push(run); return run;
}
async function pausedGuestReader() {
  const start = writes.length;
  const reader = root(`
const response=await fetch('http://localhost:${ports.child}/stream');
console.log('paused-reader-ready');
await new Promise(resolve=>setTimeout(resolve,1500));
const reader=response.body.getReader();
if(!(await reader.read()).value?.byteLength)throw Error('stream missing bytes');
await reader.cancel();
console.log('reader-cancelled');
`);
  await until(() => stdout.includes("paused-reader-ready") && writeStats(start).again > 0, "writer backpressure");
  const paused = writeStats(start);
  await new Promise(resolve => setTimeout(resolve, 100));
  const held = writeStats(start);
  check(paused.accepted > 0 && held.accepted <= 2 * 1024 * 1024, "bounded unread response credit");
  check(held.accepted === paused.accepted, "writer stays paused without reads");
  check((await reader.done).code === 0 && stdout.includes("reader-cancelled"), "reader resumes and cancels");
  const resumed = writeStats(start);
  const probe = root(client(ports.child, `server-${ports.child}`));
  check((await probe.done).code === 0, "cancellation leaves child listener live");
  return { paused, held, resumed };
}
async function bindCollision() {
  const childOwner = listeners.get(ports.child);
  const diagnosticStart = stderr.length;
  const collision = root(`Bun.serve({port:${ports.child},fetch(){return new Response('collision')}});`);
  const failedBind = await collision.done;
  check(failedBind.code !== 0 && stderr.slice(diagnosticStart).includes("EADDRINUSE"), "same-runtime bind conflict");
  check(listeners.get(ports.child) === childOwner, "failed bind preserves existing owner");
  return { conflict: failedBind.code, childPreserved: listeners.get(ports.child) === childOwner };
}
async function transientLifetime() {
  const first = root(source(0, ports.child));
  await until(() => Array.from(listeners.keys()).some(port => port !== ports.root && port !== ports.child && port !== ports.sibling), "ephemeral root listening");
  const port = Array.from(listeners.keys()).find(value => value !== ports.root && value !== ports.child && value !== ports.sibling);
  check(port !== undefined && port > 0, "ephemeral port published");
  const owner = listeners.get(port);
  check(owner !== undefined, "ephemeral listener owner");
  let closed = false;
  const connection = owner.connect(port, { data() {}, end() { closed = true; }, error() { closed = true; } });
  check(connection !== null, "queued or accepted preview connection");
  first.kill(9);
  check((await first.done).code === 137, "physical signal death");
  await until(() => closed && !listeners.has(port), "dead owner's listener and connection removed");
  const second = root(source(0, ports.child));
  await until(() => listeners.has(port), "released ephemeral port reused");
  check(listeners.get(port) !== owner, "new incarnation gets a distinct helper");
  second.kill(9);
  check((await second.done).code === 137, "replacement root stopped");
  check(listeners.has(ports.child) && listeners.has(ports.sibling), "foreign child owners survive root death");
  return { port, closed, reused: true };
}
Reflect.set(globalThis, "networkConsumer", {
  diagnostics: () => ({ stdout, stderr, listeners: Array.from(listeners.keys()), stopped, workers: workers.size, writes: writeStats(0) }),
  previews,
  async prepare() {
    check(crossOriginIsolated, "isolation");
    module = await WebAssembly.compileStreaming(fetch("./bun-guest.wasm"));
    await runtime.filesystem.mkdirp("/home/user");
    await runtime.filesystem.writeFile("/home/user/child.ts", source(ports.child, ports.sibling));
    await runtime.filesystem.writeFile("/home/user/sibling.ts", source(ports.sibling, ports.child));
    await runtime.filesystem.flush();
    check(await previews.ready === "ready", "service worker ready");
    root(source(ports.root, ports.child));
    await until(() => listeners.has(ports.root), "root listening");
    const parent = root(`
const children=['/home/user/child.ts','/home/user/sibling.ts'].map(path=>Bun.spawn([process.execPath,path],{stdout:'inherit',stderr:'inherit',ipc(message){if(message.ready)ready++;}}));
let ready=0;
while(ready!==2) await new Promise(r=>setTimeout(r,5));
${client(ports.child, `server-${ports.child}`)}
if(await (await fetch('http://localhost:${ports.child}/peer')).text()!=='server-${ports.sibling}')throw Error('sibling route');
process.exit(0);
`);
    check((await parent.done).code === 0, "parent exited successfully");
    check(listeners.has(ports.child) && listeners.has(ports.sibling), "children survived parent exit");
    const probe = root(client(ports.root, `server-${ports.root}`) + client(ports.child, `server-${ports.child}`) + client(ports.sibling, `server-${ports.sibling}`) + `const p=await fetch('https://policy.invalid/');if(await p.text()!=='injected policy')throw Error('fetch policy');`);
    check((await probe.done).code === 0, "new root reaches living children and injected fetch");
    const backpressure = await pausedGuestReader();
    const collision = await bindCollision();
    const lifetime = await transientLifetime();
    check(listeners.has(ports.root), "unrelated root listener survives");
    return { ports, parentExit: 0, backpressure, collision, lifetime, listeners: Array.from(listeners.keys()), stdout, stderr };
  },
  async isolated() {
    module = await WebAssembly.compileStreaming(fetch("./bun-guest.wasm"));
    await runtime.filesystem.mkdirp("/home/user");
    root(source(ports.child, ports.child));
    await until(() => listeners.has(ports.child), "independent runtime binds the same port");
    return { port: ports.child, listening: true };
  },
  async survivor() {
    const run = root(client(ports.child, `server-${ports.child}`));
    check((await run.done).code === 0 && listeners.has(ports.child), "foreign runtime disposal preserves child");
    return true;
  },
  async publicAdapter() {
    check(await previews.ready === "ready", "service worker ready");
    module = await WebAssembly.compileStreaming(fetch("./bun-guest.wasm"));
    await runtime.filesystem.mkdirp("/home/user"); await runtime.filesystem.flush();
    const installation = await installBunAdapters(runtime, { workerUrl: new URL("./worker.js", location.href), notificationWorkerUrl: new URL("./notification-worker.js", location.href), module, network });
    const service = await runtime.processes();
    const transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    const state = workerProcessState(transport);
    const connection = runtime.filesystem.fork();
    const { port, ...filesystem } = connection;
    transport.data = { filesystem };
    const fixture = new WebAssembly.Module(bunRuntimeProcFixture({ name: "network-consumer", commands: [{ source: source(ports.child, ports.child) }], stdout: "" }));
    let rootWorker: Worker | undefined;
    await service.adoptRuntimeRoot(transport, { filesystem, output: (fd, bytes) => (fd === 2 ? hooks.stderr : hooks.stdout)(bytes), stop: () => rootWorker?.terminate() });
    rootWorker = new Worker(new URL("./preview1-worker.js", location.href), { type: "module" });
    rootWorker.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => {
      if (data.type === "runtime-proc") { void service.runtimeMessage(data, state.pid); return; }
      if (data.type === "stdout" || data.type === "stderr") (data.type === "stderr" ? hooks.stderr : hooks.stdout)(data.data);
    };
    rootWorker.postMessage({ module: fixture, args: ["shell"], env: { PWD: "/home/user", PATH: "/bin" }, filesystem: connection, runtimeProcess: transport }, [port]);
    await until(() => listeners.has(ports.child), "public adapter child listening");
    installation.dispose(); installation.dispose();
    await service.rootExit(state.pid, 0);
    check(listeners.has(ports.child), "uninstall and parent exit preserve child");
    return { externalRoot: state.pid, ports, listeners: Array.from(listeners.keys()) };
  },
  async cleanup() {
    await runtime.dispose();
    await Promise.all(runs.map(run => run.done));
    check(workers.size === 0, "all owned workers stopped");
    check(listeners.size === 0, "all listeners removed");
    return { workers: workers.size, listeners: listeners.size, stopped };
  },
});
