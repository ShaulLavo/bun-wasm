import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createSharedObjects } from "../src/shared-objects/service";
import { bindSharedObjectHost } from "../src/shared-objects/host";
import { installRuntimeSharedObjects, runtimeSharedObjectRoute, type SharedObjectRoute } from "../src/shared-objects/runtime";
import { bunLauncher } from "../src/bun-launcher";
import { networkPathScopeFixture, socketDirectoryFixture, processRuntimeFixture } from "./process-runtime-fixture";
import type { Runtime, RuntimeProcessContext, ProcessService } from "waffle";
import type { RunRequest } from "../src/bun-executor";
import type { SharedObjects } from "../src/shared-objects/protocol";
import { memoryViews } from "waffle/core/memory-views";
import { outcomeWord } from "waffle/proc/outcome";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../src/buffer-transfer";
import { createScriptEvaluation } from "../src/script-evaluation.ts";

const cleanup = new Set<() => void | Promise<void>>();
afterEach(async () => { for (const close of Array.from(cleanup).reverse()) await close(); cleanup.clear(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export function startEngineHost", "function startEngineHost");
const engine = runInNewContext(source + "\n({ EngineHost, startEngineHost });", {
  TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask, SLOT_NAMES: [],
  isWasmMemoryBuffer, transferArrayBuffers, bindSharedObjectHost, createScriptEvaluation, memoryViews,
});
const EngineHost = engine.EngineHost;
function host(service?: ReturnType<typeof createSharedObjects>) {
  const wakeups: number[] = [], exits: number[] = [];
  const value = Object.assign(Object.create(EngineHost.prototype), {
    o: { sharedObjects: service, onExit(code: number) { exits.push(code); } },
    exited: false, pendingAsync: 0, timer: null,
    schedule(delay: number) { wakeups.push(delay); }, resolveDone() {}, flush() {},
    native: { closeAllDirs() {} },
  });
  return { value, wakeups, exits, api: value.valueNatives().sharedObjects as SharedObjects | undefined };
}
function fixtureRuntime() {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  cleanup.add(() => runtime.dispose());
  return runtime;
}
function install(runtime: Runtime) {
  const installation = installRuntimeSharedObjects(runtime);
  cleanup.add(installation.close);
  return installation;
}
function processContext() {
  const revocations = new Set<() => void>(), failures: unknown[] = [];
  const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
  const context = { identity: { pid: 1, parentPid: 0, host: null }, outcome: outcomeWord(),
    registerRevocation(callback: () => void) { revocations.add(callback); return () => revocations.delete(callback); },
    fail(error: unknown) { failures.push(error); }, module, interruptible: false,
    request: { executable: "/bin/bun", argv: ["bun", "-e", "0"], env: {}, cwd: "/work" },
  } as unknown as RuntimeProcessContext;
  return { context, failures, revoke() { for (const callback of Array.from(revocations)) callback(); } };
}
interface Launch { request: RunRequest; onMessage(message: unknown): void; cleanup(): void; }
async function launch(runtime: Runtime, context: RuntimeProcessContext, rejected = false) {
  let launched: Launch | undefined;
  const service = { networkPathScope: networkPathScopeFixture, launchWorker(_context: unknown, options: Launch) {
    launched = options;
    if (rejected) throw new Error("native launch rejected");
    cleanup.add(options.cleanup);
    return { terminate() {} };
  } } as unknown as ProcessService;
  await bunLauncher("browser", { runtime, workerUrl: "./worker.js" })(context, service);
  if (!launched) throw new Error("No native launch");
  return launched;
}
function connect(launched: Launch) {
  const owner = launched.request.sharedObjects?.owner;
  if (!owner) throw new Error("Missing private shared owner");
  const channel = new MessageChannel();
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  launched.onMessage({ type: "bun-shared-connect", owner, port: channel.port2 });
  const service = createSharedObjects(owner, channel.port1);
  cleanup.add(service.close);
  return service;
}

test("default launcher and host have no shared-object service", async () => {
  const runtime = fixtureRuntime(), { context } = processContext();
  expect(runtimeSharedObjectRoute(runtime)).toBeUndefined();
  const launched = await launch(runtime, context);
  expect(launched.request.sharedObjects).toBeUndefined();
  expect(host().api).toBeUndefined();
});

test("runtime installation is identity-scoped and rejects duplicate installation", () => {
  const first = fixtureRuntime(), second = fixtureRuntime(), installation = install(first);
  expect(() => installRuntimeSharedObjects(first)).toThrow("already installed");
  expect(runtimeSharedObjectRoute(second)).toBeUndefined();
  const route = runtimeSharedObjectRoute(first)!;
  expect(installation.inspect().clients).toBe(1);
  route.close(); route.close();
  expect(installation.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  installation.close();
  expect(runtimeSharedObjectRoute(first)).toBeUndefined();
  expect(() => installation.open()).toThrow("closed");
});

test("launcher routes real native backing across processes of one runtime and closes leases", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime);
  const first = processContext(), second = processContext();
  const sender = connect(await launch(runtime, first.context)), receiver = connect(await launch(runtime, second.context));
  const publication = sender.begin(), backing = new SharedArrayBuffer(8), reference = publication.reference(backing);
  publication.publish();
  await new Promise<void>(resolve => receiver.wait([reference], resolve));
  Atomics.store(new Int32Array(receiver.read(reference)), 0, 42);
  expect(Atomics.load(new Int32Array(backing), 0)).toBe(42);
  first.revoke(); second.revoke();
  await tick();
  expect(sender.inspect().closed).toBe(true);
  expect(receiver.inspect().closed).toBe(true);
  expect(installation.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
});

test("launch failure rolls back route and revoked-before-attach closes late ports", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime), first = processContext();
  await expect(launch(runtime, first.context, true)).rejects.toThrow("native launch rejected");
  expect(installation.inspect().clients).toBe(0);
  const second = processContext(), launched = await launch(runtime, second.context);
  second.revoke();
  const service = connect(launched);
  expect(installation.inspect().clients).toBe(0);
  launched.cleanup(); launched.cleanup();
  expect(second.failures).toEqual([]);
  // A late peer has no live broker route even if the platform silently accepts posting to a closed port.
  expect(service.inspect().buffers).toBe(0);
});

test("mismatched and duplicate native port exports fail without leaking leases", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime), first = processContext();
  const launched = await launch(runtime, first.context);
  const channel = new MessageChannel();
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  launched.onMessage({ type: "bun-shared-connect", owner: "wrong", port: channel.port2 });
  expect(first.failures).toHaveLength(1);
  expect(installation.inspect().clients).toBe(0);
  const second = processContext(), next = await launch(runtime, second.context);
  connect(next);
  const extra = new MessageChannel();
  cleanup.add(() => { extra.port1.close(); extra.port2.close(); });
  next.onMessage({ type: "bun-shared-connect", owner: next.request.sharedObjects?.owner, port: extra.port2 });
  expect(second.failures).toHaveLength(1);
  expect(installation.inspect().clients).toBe(0);
});

test("actual engine native binding holds attachment waits, wakes on ready and closes once", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime);
  const sender = connect(await launch(runtime, processContext().context)), receiver = connect(await launch(runtime, processContext().context));
  const h = host(receiver), api = h.api!;
  const publication = sender.begin(), reference = publication.reference(new SharedArrayBuffer(8));
  let ready = 0;
  const cancel = api.wait([reference], () => ready++);
  expect(h.value.pendingAsync).toBe(1);
  publication.publish();
  await tick(); await tick();
  expect(ready).toBe(1);
  expect(h.value.pendingAsync).toBe(0);
  expect(h.wakeups).toEqual([0]);
  expect(api.wait([reference], () => { throw new Error("Already attached"); })).toBeNull();
  expect(h.value.pendingAsync).toBe(0);
  cancel?.();
  expect(h.value.pendingAsync).toBe(0);
  h.value.exit(0); h.value.exit(7);
  expect(receiver.inspect().closed).toBe(true);
  expect(h.exits).toEqual([0]);
  expect(() => api.read(reference)).toThrow("closed");
  await tick();
  expect(installation.inspect().clients).toBe(1);
});

test("cancelling or closing an attachment wait releases host liveness exactly once", async () => {
  const runtime = fixtureRuntime(); install(runtime);
  const sender = connect(await launch(runtime, processContext().context)), receiver = connect(await launch(runtime, processContext().context));
  const publication = sender.begin(), reference = publication.reference(new SharedArrayBuffer(8));
  const h = host(receiver), api = h.api!;
  let ready = 0;
  const cancel = api.wait([reference], () => ready++);
  expect(h.value.pendingAsync).toBe(1);
  cancel?.(); cancel?.();
  expect(h.value.pendingAsync).toBe(0);
  expect(ready).toBe(0);
  expect(h.wakeups).toEqual([0]);
  api.wait([reference], () => ready++);
  h.value.exit(0);
  expect(h.value.pendingAsync).toBe(0);
  expect(ready).toBe(0);
  expect(h.wakeups).toEqual([0]);
  publication.publish(); await tick();
  expect(ready).toBe(0);
});

async function nativeExecutor(route: SharedObjectRoute) {
  const worker = new Worker(new URL("./fixtures/shared-objects/executor-worker.ts", import.meta.url).href);
  cleanup.add(() => worker.terminate());
  const connected = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  const exits: unknown[] = [];
  const failure = Promise.withResolvers<never>();
  worker.onerror = event => failure.reject(new Error(event.message));
  worker.onmessage = event => {
    if (route.accept(event.data)) { connected.resolve(); return; }
    if (event.data.type === "exit" || event.data.type === "error") exits.push(event.data);
    if (event.data.type === "fixture-cleaned") finished.resolve();
  };
  worker.postMessage(route.owner);
  await Promise.race([connected.promise, failure.promise]);
  return { worker, exits, finish: () => Promise.race([finished.promise, failure.promise]) };
}

test("actual native Worker exports executor setup port and normal bootstrap finish releases it", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime), route = installation.open();
  const child = await nativeExecutor(route);
  expect(installation.inspect().clients).toBe(1);
  child.worker.postMessage("finish");
  await child.finish();
  await tick();
  expect(child.exits).toEqual([{ type: "exit", code: 0, signal: undefined, sleep: "atomics" }]);
  expect(installation.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  route.close(); route.close();
});

test("explicit revocation releases a native executor route before hard worker stop", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime), route = installation.open();
  const child = await nativeExecutor(route);
  expect(installation.inspect().clients).toBe(1);
  route.close(); route.close();
  child.worker.terminate();
  expect(installation.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  expect(child.exits).toEqual([]);
});

test("failed engine construction closes its supplied backing service", async () => {
  const runtime = fixtureRuntime(); install(runtime);
  const receiver = connect(await launch(runtime, processContext().context));
  await expect(engine.startEngineHost({ instance: { exports: {} }, sharedObjects: receiver })).rejects.toThrow("toResizableBuffer");
  expect(receiver.inspect()).toEqual({ buffers: 0, pending: 0, staged: 0, closed: true });
});

test("closing an installation rejects future routes and preserves already delivered native aliases", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime);
  const sender = connect(await launch(runtime, processContext().context)), receiver = connect(await launch(runtime, processContext().context));
  const publication = sender.begin(), backing = new SharedArrayBuffer(8), reference = publication.reference(backing);
  publication.publish();
  await new Promise<void>(resolve => receiver.wait([reference], resolve));
  const delivered = receiver.read(reference);
  installation.close(); installation.close();
  await tick();
  expect(installation.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  expect(() => installation.open()).toThrow("closed");
  expect(() => receiver.read(reference)).toThrow("closed");
  Atomics.store(new Int32Array(delivered), 0, 73);
  expect(Atomics.load(new Int32Array(backing), 0)).toBe(73);
});

test("transport close while the engine is active settles its pending wait once", async () => {
  const runtime = fixtureRuntime(); install(runtime);
  const sender = connect(await launch(runtime, processContext().context)), receiver = connect(await launch(runtime, processContext().context));
  const publication = sender.begin(), reference = publication.reference(new SharedArrayBuffer(8));
  const h = host(receiver);
  let ready = 0;
  const cancel = h.api!.wait([reference], () => ready++);
  receiver.close(); receiver.close(); cancel?.();
  expect(h.value.pendingAsync).toBe(0);
  expect(ready).toBe(1);
  expect(h.wakeups).toEqual([0]);
  expect(receiver.inspect()).toEqual({ buffers: 0, pending: 0, staged: 0, closed: true });
});

test("direct route attachment validation releases its lease on malformed or wrong-owner exports", () => {
  const runtime = fixtureRuntime(), installation = install(runtime);
  const malformed = installation.open();
  expect(() => malformed.accept({ type: "bun-shared-connect", owner: malformed.owner, port: {} })).toThrow("native port");
  expect(installation.inspect().clients).toBe(0);
  const wrong = installation.open(), channel = new MessageChannel();
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  expect(() => wrong.accept({ type: "bun-shared-connect", owner: "wrong", port: channel.port2 })).toThrow("attachment");
  expect(installation.inspect().clients).toBe(0);
});

test("a native port arriving after Runtime disposal cannot revive its leased route", async () => {
  const runtime = fixtureRuntime(), installation = install(runtime), route = installation.open();
  await runtime.dispose();
  const channel = new MessageChannel();
  cleanup.add(() => { channel.port1.close(); channel.port2.close(); });
  expect(route.accept({ type: "bun-shared-connect", owner: route.owner, port: channel.port2 })).toBe(true);
  expect(installation.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  expect(runtimeSharedObjectRoute(runtime)).toBeUndefined();
  expect(() => installation.open()).toThrow("closed");
});
