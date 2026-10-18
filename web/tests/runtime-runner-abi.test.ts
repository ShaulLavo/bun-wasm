import { createNotifyObserver } from "./notify-observer";
import { processRuntimeFixture } from "./process-runtime-fixture";
import type { Runtime } from "waffle";
import { expect, test } from "bun:test";
import { createFilesystemIdentity, revokeFilesystem } from "waffle/fs";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { DescriptorTable } from "waffle/core/descriptors";
import { SubprocessBroker, type ExecutableRegistration } from "../src/subprocess-broker";
import { WorkerPipeBroker } from "waffle/proc/worker-pipes";
import { PipeController, attachPipePublicationRegistry, type PipePublicationRegistryHandle } from "waffle/proc/pipes";
import { setSignalDisposition, takeSignal } from "waffle/proc/signals";
import { readOutcome } from "waffle/proc/outcome";
import { startRun, type RunOptions } from "../src/runner";
import type { RunRequest } from "../src/worker";
import type { SharedFilesystem } from "../src/shared-fs";

const notifyObserver = createNotifyObserver();

function imported(name: string, namespace = "runtime_proc"): WebAssembly.Module {
  const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const imports = [1].concat(text(namespace), text(name), [0, 0]);
  return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, imports.length].concat(imports)));
}
function fixture(module: WebAssembly.Module, options: Partial<RunOptions> | ((runtime: Runtime) => Partial<RunOptions>) = {}) {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  const identity = createFilesystemIdentity();
  let sent!: RunRequest;
  const requests: RunRequest[] = [];
  const workerUrls = new Map<RunRequest, string>();
  let rootWorker: { onmessage?: (event: { data: WorkerProcessMessage }) => void };
  let posted!: () => void;
  const ready = new Promise<void>(resolve => { posted = resolve; });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  globalThis.Worker = class {
    // oxlint-disable-next-line typescript/no-this-alias -- Capture the actual fake worker or receiver for assertions outside this callback.
    constructor(readonly url: string) { rootWorker ??= this; }
    onmessage?: (event: { data: WorkerProcessMessage }) => void;
    postMessage(request: RunRequest) { sent ??= request; requests.push(request); workerUrls.set(request, this.url); posted(); }
    terminate() {}
  } as unknown as typeof Worker;
  const filesystem = {
    fork: () => ({ ...identity, port: channel.port1 }),
    connect: (value: object) => { if (!value) throw new TypeError("missing filesystem identity"); return { ...value, port: channel.port1 }; },
    revoke: revokeFilesystem, reap() {},
    async quiesce(value: typeof identity) { revokeFilesystem(value); },
    client: { sweep() {} },
  } as unknown as SharedFilesystem;
  const restore = () => {
    globalThis.Worker = originalWorker;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
    if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    channel.port1.close(); channel.port2.close();
  };
  const runtime = processRuntimeFixture(filesystem);
  let run: ReturnType<typeof startRun>;
  try { run = startRun({ engine: "browser", module, args: [], env: {}, runtime, moduleScope: false, ...(typeof options === "function" ? options(runtime) : options) }, { stdout() {}, stderr() {} }); }
  catch (error) { restore(); throw error; }
  return {
    run, runtime, ready, request: () => sent, requests, urlFor: (request: RunRequest) => workerUrls.get(request),
    message: (data: WorkerProcessMessage) => rootWorker.onmessage!({ data }),
    async dispose() {
      run.kill(9); await run.done;
      try { await runtime.dispose(); } finally { restore(); }
    },
  };
}

async function waitForChild(state: ReturnType<typeof fixture>, pid: number) {
  const deadline = performance.now() + 1000;
  while (!state.requests.some(request => request.runtimeProcess && workerProcessState(request.runtimeProcess).pid === pid) && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

for (const name of ["pipe", "read", "spawn", "poll"]) test(`runner automatically supplies generic ownership for runtime_proc.${name}`, async () => {
  const state = fixture(imported(name));
  try {
    await state.ready;
    expect(state.request().runtimeProcess).toBeDefined();
    expect((state.request().runtimeProcess!.data as { pipeRegistry: unknown }).pipeRegistry).toBeDefined();
  } finally { await state.dispose(); }
});
for (const name of ["signal", "interrupted", "default_signal"]) test(`runner supplies generic ownership even for runtime_proc.${name} alone`, async () => {
  const state = fixture(imported(name));
  try { await state.ready; expect(state.request().runtimeProcess).toBeDefined(); }
  finally { await state.dispose(); }
});

test("preview1 roots keep their explicit module and Bun executable paths launch real Bun", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => String(input).endsWith(".gz") ? new Response(null, { status: 404 }) : new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { "content-type": "application/wasm" } }), { preconnect: originalFetch.preconnect });
  const registrations = new Map<string, Parameters<SubprocessBroker["register"]>[1]>();
  const register = SubprocessBroker.prototype.register;
  SubprocessBroker.prototype.register = function(name, entry) {
    registrations.set(name, entry);
    return register.call(this, name, entry);
  };
  let state: ReturnType<typeof fixture> | undefined;
  try {
    state = fixture(imported("spawn"), { adapter: "preview1" });
    await state.ready;
    expect(state.request().adapter).toBe("preview1");
    const descriptors = new DescriptorTable();
    try {
      const root = state.request().runtimeProcess!;
      const client = new WorkerProcessClient({ transport: root, descriptors,
        codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
        postMessage: message => state!.message(message),
        prepareSpawn(pid) {
      const pipeRegistry = (root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry;
      const registry = attachPipePublicationRegistry(pipeRegistry);
      registry.registerProcess(pid);
      return { data: { filesystem: createFilesystemIdentity(), pipeRegistry }, cancel: () => registry.collectProcess(pid) };
    },
      });
      for (const alias of ["/bin/bun", "/bin/node"]) {
        const pid = client.spawn(1, { executable: alias, argv: [alias], env: {}, cwd: "/", job: 1, fds: [] });
        await waitForChild(state, pid);
        const child = state.requests.find(request => request.runtimeProcess && workerProcessState(request.runtimeProcess).pid === pid);
        expect(child).toBeDefined();
        expect(state.urlFor(child!)).toBe("http://localhost/worker.js");
        expect(child!.module).not.toBe(state.request().module);
        const record = (await state.runtime.processes().then(service => service.ready())).get(pid)!;
        expect(registrations.get(record.request!.executable)).toMatchObject({ adapter: "bun", engine: "browser" });
      }
    } finally { descriptors.dispose(); }
    for (const engine of ["quickjs", "jsc", "browser"]) {
      expect(registrations.get(engine === "browser" ? "/bin/bun" : `/opt/bun/${engine}/bin/bun`)).toMatchObject({ adapter: "bun", engine });
    }
  } finally {
    globalThis.fetch = originalFetch;
    SubprocessBroker.prototype.register = register;
    await state?.dispose();
  }
});

test("UI signals freeze canonical root pipe publication only for fatal actions", async () => {
  let transport!: ReturnType<typeof createWorkerProcessTransport>;
  const state = fixture(imported("pipe"), runtime => ({ runtimeProcess: transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer }) }));
  let controller: PipeController | undefined;
  try {
    await state.ready;
    const handle = (transport.data as { pipeRegistry?: PipePublicationRegistryHandle }).pipeRegistry;
    expect(handle).toBeDefined();
    const registry = attachPipePublicationRegistry(handle!);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const reader = controller.retain(1, "read");
    const writer = controller.retain(1, "write");
    setSignalDisposition(workerProcessState(transport).signals.signalState, 2, 2);
    state.run.kill(2);
    expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
    state.run.kill(9);
    expect(writer.tryWrite([new Uint8Array([2])])).toBeLessThan(0);
    reader.close(); writer.close();
    expect(await state.run.done).toEqual({ code: 137 });
  } finally { controller?.dispose(); await state.dispose(); }
});

function registryFixture(options?: ConstructorParameters<typeof SubprocessBroker>[2] & { activate?: () => Promise<typeof import("waffle/proc")> }) {
  const ports: MessagePort[] = [];
  const filesystem = {
    connect(identity: object) {
      const channel = new MessageChannel();
      channel.port2.close();
      ports.push(channel.port1);
      return { ...identity, port: channel.port1 };
    },
    revoke: revokeFilesystem, client: { sweep() {} },
    async quiesce(identity: Parameters<typeof revokeFilesystem>[0]) { revokeFilesystem(identity); },
  } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem, { activate: options?.activate });
  const root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime, options);
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export(descriptor) {
      if (descriptor.resource.kind === "terminal") return { kind: "web-terminal", target: 2 };
      throw new Error("unexpected export");
    }, import() { throw new Error("unexpected import"); }, discard() {} },
    postMessage: message => messages.push(message),
    prepareSpawn(pid) {
      const pipeRegistry = (root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry;
      const registry = attachPipePublicationRegistry(pipeRegistry);
      registry.registerProcess(pid);
      return { data: { filesystem: createFilesystemIdentity(), pipeRegistry }, cancel: () => registry.collectProcess(pid) };
    },
  });
  return { root, runtime, broker, client, messages, descriptors, async dispose() { broker.dispose(); descriptors.dispose(); try { await runtime.dispose(); } finally { for (const port of ports) port.close(); } } };
}

for (const path of ["supervisor", "dispose"] as const) test(`${path} freezes root-created pipe endpoints absent from supervisor descriptors`, async () => {
  const state = registryFixture();
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const registry = attachPipePublicationRegistry((state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const writer = controller.retain(1, "write"), reader = controller.retain(1, "read");
    expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
    if (path === "supervisor") (await state.broker.ready()).kill(1, 9);
    else void state.runtime.dispose();
    expect(writer.tryWrite([new Uint8Array([2])])).toBeLessThan(0);
    writer.close(); reader.close();
  } finally { controller?.dispose(); await state.dispose(); }
});

test("job kill freezes unknown reserved child endpoints before its spawn message is admitted", async () => {
  const state = registryFixture();
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "/bin/fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    expect(state.messages).toHaveLength(1);
    const registry = attachPipePublicationRegistry((state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const writer = controller.retain(pid, "write"), reader = controller.retain(pid, "read");
    expect(writer.tryWrite([new Uint8Array([1])])).toBe(1);
    await state.broker.killJob(1, 9);
    expect(writer.tryWrite([new Uint8Array([2])])).toBeLessThan(0);
    expect(() => controller!.retain(pid, "write")).toThrow();
    writer.close(); reader.close();
  } finally { controller?.dispose(); await state.dispose(); }
});

test("ordinary root completion freezes only its own pipe row, not a reserved independent child", async () => {
  const state = registryFixture();
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "/bin/fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const registry = attachPipePublicationRegistry((state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry);
    controller = new PipeController({ registry, relay: "manual", capacity: 16 });
    const parent = controller.retain(1, "write"), child = controller.retain(pid, "write"), reader = controller.retain(pid, "read");
    state.broker.rootExit(0);
    expect(parent.tryWrite([new Uint8Array([1])])).toBeLessThan(0);
    expect(child.tryWrite([new Uint8Array([2])])).toBe(1);
    expect(registry.isRevoked(pid)).toBe(false);
    parent.close(); child.close(); reader.close();
  } finally { controller?.dispose(); await state.dispose(); }
});

test("explicit Preview1 children run without installing Bun slots", async () => {
  const state = fixture(imported("spawn"), { adapter: "preview1" });
  const descriptors = new DescriptorTable();
  try {
    await state.ready;
    const root = state.request().runtimeProcess!;
    const client = new WorkerProcessClient({ transport: root, descriptors,
      codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
      postMessage: message => state.message(message),
      prepareSpawn(pid) {
      const pipeRegistry = (root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry;
      const registry = attachPipePublicationRegistry(pipeRegistry);
      registry.registerProcess(pid);
      return { data: { filesystem: createFilesystemIdentity(), pipeRegistry }, cancel: () => registry.collectProcess(pid) };
    },
    });
    const childBroker = new SubprocessBroker("http://localhost/worker.js", state.runtime);
    childBroker.register("/usr/libexec/test-guest", { adapter: "preview1", module: state.request().module, cooperative: true });
    const pid = client.spawn(1, { executable: "/usr/libexec/test-guest", argv: ["child"], env: {}, cwd: "/", job: 1, fds: [] });
    const deadline = performance.now() + 1000;
    while (state.requests.length < 2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    const child = state.requests.find(request => request.runtimeProcess && workerProcessState(request.runtimeProcess).pid === pid);
    expect(child).toBeDefined();
    expect(state.urlFor(child!)).toBe("http://localhost/preview1-worker.js");
  } finally { descriptors.dispose(); await state.dispose(); }
});

test("disposal before lazy pipe activation closes the subsequently created pipe broker", async () => {
  const state = registryFixture();
  const originalDispose = WorkerPipeBroker.prototype.dispose;
  let disposals = 0;
  WorkerPipeBroker.prototype.dispose = function () { disposals++; originalDispose.call(this); };
  try {
    const creating = state.runtime.processes();
    const pending = state.broker.adoptRuntimeRoot(state.root);
    const disposal = state.runtime.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await creating;
    await disposal;
    expect(disposals).toBe(1);
  } finally { await state.dispose(); WorkerPipeBroker.prototype.dispose = originalDispose; }
});

test("explicit root metadata without a filesystem forks an identity and preserves metadata", async () => {
  let transport!: ReturnType<typeof createWorkerProcessTransport>;
  const state = fixture(imported("pipe"), runtime => {
    transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    transport.data = { marker: "preserved" };
    return { runtimeProcess: transport };
  });
  try {
    await state.ready;
    expect(state.request().filesystem.owner).toBeDefined();
    expect((transport.data as { marker: string }).marker).toBe("preserved");
    expect((transport.data as { filesystem: unknown }).filesystem).toBeDefined();
  } finally { await state.dispose(); }
});

test("pipe-only generic work uses the responsive relay without activating the process supervisor", async () => {
  let activations = 0;
  const state = registryFixture({ activate: async () => { activations++; return import("waffle/proc"); } });
  let controller: PipeController | undefined;
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    controller = new PipeController({ registry: attachPipePublicationRegistry(
      (state.root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry), relay: "manual", capacity: 16 });
    const reader = controller.retain(1, "read"), writer = controller.retain(1, "write");
    await state.broker.runtimeMessage({ type: "runtime-proc", operation: "pipe", transport: state.root, handle: reader.handle() }, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(activations).toBe(0);
    writer.close(); reader.close();
  } finally { controller?.dispose(); await state.dispose(); }
});

test("generic runtime byte registrations retain injected-check metadata at worker launch", async () => {
  const NativeWorker = globalThis.Worker;
  const requests: RunRequest[] = [];
  let terminated = false;
  globalThis.Worker = class {
    postMessage(request: RunRequest) { requests.push(request); request.filesystem.port.close(); }
    terminate() { terminated = true; }
  } as unknown as typeof Worker;
  const state = registryFixture();
  try {
    state.broker.register("/bin/injected", { adapter: "preview1", bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) });
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(1, { executable: "/bin/injected", argv: [], env: {}, cwd: "/", job: 1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    const deadline = performance.now() + 1000;
    while (!requests.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(workerProcessState(requests[0]!.runtimeProcess!).pid).toBe(pid);
    expect(requests[0]!.interruptible).toBe(true);
  } finally {
    await state.dispose();
    const deadline = performance.now() + 1000;
    while (requests.length && !terminated && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    globalThis.Worker = NativeWorker;
  }
});

for (const refusal of ["compiled", "SIMD"] as const) test(refusal === "compiled"
  ? "untrusted compiled-only registration is rejected before child admission"
  : "generic runtime SIMD refusal writes actionable inherited stderr before closing descriptors", async () => {
  const output: { fd: number; text: string }[] = [];
  const state = registryFixture({ output(fd, data) { output.push({ fd, text: new TextDecoder().decode(data) }); } });
  try {
    const body = [0, 0xfd, 0x0c].concat(new Array<number>(16).fill(0), [0x1a, 0x0b]);
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0,
      10, body.length + 2, 1, body.length].concat(body));
    expect(WebAssembly.validate(bytes)).toBe(true);
    const entry = refusal === "SIMD" ? { adapter: "preview1", bytes } : {
      adapter: "preview1", module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    };
    if (refusal === "compiled") {
      expect(() => state.broker.register("/bin/refused", entry as ExecutableRegistration)).toThrow(/require source bytes/);
      expect(output).toHaveLength(0);
      expect(state.messages).toHaveLength(0);
      return;
    }
    state.broker.register("/bin/refused", entry as ExecutableRegistration);
    await state.broker.adoptRuntimeRoot(state.root);
    const fd = state.descriptors.open({ kind: "terminal", read: () => 0, write: () => 0,
      readiness: () => ({ readable: false, writable: true, hangup: false }) }, 0xffffn, 0n);
    const pid = state.client.spawn(1, { executable: "/bin/refused", argv: [], env: {}, cwd: "/", job: 1,
      fds: [{ child: 2, parent: fd }] });
    await state.broker.runtimeMessage(state.messages[0]!, 1);
    expect(await state.broker.wait(pid)).toEqual({ kind: "start-failed", code: 8, error: "ENOEXEC", status: null });
    expect(output).toHaveLength(1);
    expect(output[0]!.fd).toBe(2);
    expect(output[0]!.text).toMatch(refusal === "SIMD" ? /Cannot instrument WebAssembly:.*SIMD/ : /require source bytes/);
  } finally { await state.dispose(); }
});

for (const engine of ["quickjs", "jsc", "browser"] as const) for (const delivery of ["kill", "killJob"] as const) {
  test(`generic ${engine} ${delivery} wakes the shared process wake word without replaying handled SIGINT`, async () => {
    const nativeWorker = globalThis.Worker;
    const requests: RunRequest[] = [];
    globalThis.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(request: RunRequest) { requests.push(request); }
      terminate() {}
    } as unknown as typeof Worker;
    const state = registryFixture();
    let suppressed = 0;
    try {
      state.broker.register("/bin/fixture", { module: imported("signal"), adapter: "bun", engine });
      await state.broker.adoptRuntimeRoot(state.root);
      const pid = state.client.spawn(1, { executable: "/bin/fixture", argv: ["/bin/fixture"], env: {}, cwd: "/", job: -1, fds: [] });
      await state.broker.runtimeMessage(state.messages[0]!, 1);
      const supervisor = await state.broker.ready();
      await supervisor.start(pid);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.engine).toBe(engine);
      const shared = workerProcessState(request.runtimeProcess!);
      setSignalDisposition(shared.signals.signalState, 2, 2);
      const word = shared.wake;
      const generation = Atomics.load(word, 0);
      // Reuse the browser causal-wake negative control on the real production request,
      // never a manufactured word. Even suppressed notify must advance this generation.
      notifyObserver.current = (selected, index = 0) => {
        if (selected.buffer === word.buffer && selected.byteOffset + index * 4 === word.byteOffset) { suppressed++; return 0; }
        return notifyObserver.notify(selected, index);
      };
      if (delivery === "kill") await state.broker.kill(pid, 2);
      else await state.broker.killJob(shared.job, 2);
      expect(suppressed).toBe(1);
      expect(Atomics.load(word, 0)).toBe(generation + 1);
      expect(takeSignal(shared.signals.signalState)).toBe(2);
      expect(readOutcome(shared.signals.outcome)).toBeNull();
      expect(supervisor.get(pid)!.result).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 12));
      expect(takeSignal(shared.signals.signalState)).toBe(0);
      expect(suppressed).toBe(1);
    } finally {
      notifyObserver.current = undefined;
      try { await state.dispose(); } finally { globalThis.Worker = nativeWorker; }
    }
  });
}
