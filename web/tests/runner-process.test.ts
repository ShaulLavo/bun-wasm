import { TaggedCells, controlLoad } from "waffle/proc/control";
import type { RootProcessOptions } from "waffle/proc";
import { processRuntimeFixture } from "./process-runtime-fixture";
import { expect, spyOn, test } from "bun:test";
import { startRun } from "../src/runner";
import { ENGINES, type Engine } from "../src/engine-loader";
import { SubprocessBroker } from "../src/subprocess-broker";
import { ENGINE_BIN } from "../../src/executable-paths.js";
import type { SharedFilesystem } from "../src/shared-fs";
import type { RunRequest, WorkerMessage } from "../src/bun-executor";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { setSignalDisposition, takeSignal } from "waffle/proc/signals";
import { WorkerProcessClient, workerProcessState } from "waffle/proc/worker-client";
import { DescriptorTable } from "waffle/core/descriptors";
import { createFilesystemIdentity } from "waffle/fs";
import { installRuntimeSharedObjects } from "../src/shared-objects/runtime";

/** The shared signal words of the process a request roots. */
const signalsOf = (request: RunRequest) => workerProcessState(request.runtimeProcess!).signals;
const pidOf = (request: RunRequest) => workerProcessState(request.runtimeProcess!).pid;

function runConfirmation(run: ReturnType<typeof startRun>) {
  let confirmed = false;
  const result = run.done.then(value => { confirmed = true; return value; });
  return { result, confirmed: () => confirmed };
}

function isolatedRoot(isolated = true, engine: Engine = "browser", options: Parameters<typeof processRuntimeFixture>[1] = {}, args = ["-e", "0"], prepare?: (runtime: ReturnType<typeof processRuntimeFixture>) => void, moduleOverride?: WebAssembly.Module) {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const channel = new MessageChannel();
  let request!: RunRequest;
  let posted!: () => void;
  const ready = new Promise<void>(resolve => { posted = resolve; });
  let worker!: FakeWorker;
  const requests = new Map<number, RunRequest>();
  const workers = new Map<number, FakeWorker>();
  const pending = new Map<number, (request: RunRequest) => void>();
  const launchTimers = new Set<ReturnType<typeof setTimeout>>();
  const ports: MessagePort[] = [];
  let revoked = 0;
  let reaped = 0;
  let rejected = 0;
  const output: string[] = [];
  const phases: string[] = [];
  let release!: () => void;
  const quiescence = new Promise<void>(resolve => { release = resolve; });
  class FakeWorker {
    // oxlint-disable-next-line typescript/no-this-alias -- Capture the actual fake worker or receiver for assertions outside this callback.
    constructor() { worker ??= this; }
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    terminated = 0;
    postMessage(value: RunRequest) {
      // oxlint-disable-next-line typescript/no-this-alias -- Capture the actual fake worker or receiver for assertions outside this callback.
      request ??= value; worker ??= this; const pid = pidOf(value); requests.set(pid, value); workers.set(pid, this);
      pending.get(pid)?.(value); posted();
    }
    terminate() { this.terminated++; }
    exit(code: number, signal?: number) { this.onmessage?.({ data: { type: "exit", code, signal, sleep: "atomics" } } as MessageEvent); }
  }
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: isolated });
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const filesystem = {
    fork: () => ({ ...createFilesystemIdentity(), port: channel.port1 }),
    connect(identity: object) {
      const child = new MessageChannel(); child.port2.close(); ports.push(child.port1);
      return { ...identity, port: child.port1 };
    },
    reap() { reaped++; },
    revoke() { rejected++; },
    async quiesce() { revoked++; await quiescence; },
  } as unknown as SharedFilesystem;
  const runtime = processRuntimeFixture(filesystem, options);
  prepare?.(runtime);
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const run = startRun({ engine, module: moduleOverride ?? module, args, env: {}, runtime, moduleScope: false }, {
    stdout(data) { output.push(new TextDecoder().decode(data)); }, stderr() {}, phase(name) { phases.push(name); },
  });
  return {
    run, runtime, ready, get request() { return request; }, get worker() { return worker; }, release, quiescence, output, phases,
    workerFor(pid: number) { return workers.get(pid)!; },
    requestFor(pid: number): Promise<RunRequest> {
      const request = requests.get(pid);
      return request ? Promise.resolve(request) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => { launchTimers.delete(timer); pending.delete(pid); reject(new Error(`worker ${pid} did not receive its run request`)); }, 1000);
        launchTimers.add(timer);
        pending.set(pid, request => { clearTimeout(timer); launchTimers.delete(timer); pending.delete(pid); resolve(request); });
      });
    },
    async record() { return (await (await runtime.processes()).ready()).get(pidOf(request))!; },
    revoked: () => revoked, reaped: () => reaped, rejected: () => rejected,
    async dispose() {
      try {
        run.kill(9);
        release();
        await run.done;
        await quiescence;
        await runtime.dispose();
      } finally {
        for (const timer of launchTimers) clearTimeout(timer);
        pending.clear();
        globalThis.Worker = originalWorker;
        if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
        if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
        for (const port of ports) port.close();
        channel.port1.close(); channel.port2.close();
      }
    },
  };
}

test("browser roots carry installed shared-object ownership and release it on teardown", async () => {
  let installation: ReturnType<typeof installRuntimeSharedObjects> | undefined;
  const state = isolatedRoot(true, "browser", {}, ["-e", "0"], runtime => {
    installation = installRuntimeSharedObjects(runtime);
  });
  try {
    await state.ready;
    const owner = state.request?.sharedObjects?.owner;
    expect(owner).toBeString();
    const channel = new MessageChannel();
    try {
      state.worker.onmessage?.({ data: { type: "bun-shared-connect", owner, port: channel.port2 } } as MessageEvent<WorkerMessage>);
      expect(installation?.inspect().clients).toBe(1);
    } finally {
      channel.port1.close();
    }
  } finally {
    await state.dispose();
    expect(installation?.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
    installation?.close();
  }
});

test("terminal browser roots retire their route before a held filesystem fence accepts late ports", async () => {
  let installation: ReturnType<typeof installRuntimeSharedObjects> | undefined;
  const state = isolatedRoot(true, "browser", {}, ["-e", "0"], runtime => {
    installation = installRuntimeSharedObjects(runtime);
  });
  try {
    await state.ready;
    const owner = state.request?.sharedObjects?.owner;
    expect(owner).toBeString();
    state.run.kill(9);
    expect(installation?.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
    const channel = new MessageChannel();
    try {
      state.worker.onmessage?.({ data: { type: "bun-shared-connect", owner, port: channel.port2 } } as MessageEvent<WorkerMessage>);
      expect(installation?.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
    } finally { channel.port1.close(); }
    state.release();
    await state.run.done;
  } finally {
    await state.dispose();
    expect(installation?.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
    installation?.close();
  }
});

for (const failure of ["fork", "retainConsumer", "registerAdapter"] as const) test(`root setup rolls back its shared route when ${failure} throws`, async () => {
  const channel = new MessageChannel();
  const runtime = processRuntimeFixture(failure === "fork"
    ? { fork: () => { throw new Error("fork failed"); } }
    : { fork: () => ({ ...createFilesystemIdentity(), port: channel.port1 }) });
  const installation = installRuntimeSharedObjects(runtime);
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  const mutable = (failure === "fork" ? runtime.filesystem : runtime) as unknown as Record<string, unknown>;
  const original = mutable[failure];
  if (failure !== "fork") mutable[failure] = () => { throw new Error(`${failure} failed`); };
  try {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() => startRun({ runtime, engine: "browser", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} })).toThrow(`${failure} failed`);
    expect(installation.inspect()).toEqual({ clients: 0, objects: 0, waiting: 0 });
  } finally {
    mutable[failure] = original;
    installation.close();
    channel.port1.close(); channel.port2.close();
    await runtime.dispose();
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
  }
});

/** A worker-side client for the root a run adopted; its spawn messages go to the run's handler. */
function rootClient(request: RunRequest, deliver: (message: object) => void) {
  const transport = request.runtimeProcess!;
  const descriptors = new DescriptorTable();
  const client = new WorkerProcessClient({ transport, descriptors,
    codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
    postMessage: message => deliver(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (transport.data as { pipeRegistry: unknown }).pipeRegistry } }),
  });
  const which = async (command: string) => {
    const candidates = command.includes("/") ? [command] : request.env.PATH!.split(":").map(directory => `${directory || "."}/${command}`);
    for (const candidate of candidates) {
      const query = client.accessStart(client.pid, candidate, "/");
      let result = client.accessTake(client.pid, query);
      while (result === -6) { await new Promise(resolve => setTimeout(resolve, 0)); result = client.accessTake(client.pid, query); }
      if (result === 0) return candidate;
    }
    throw new Error(`No executable: ${command}`);
  };
  return { client, which, async spawn(command: string) {
    const executable = await which(command);
    return client.spawn(client.pid, { executable, argv: [command], cwd: "/", env: request.env, job: -1, fds: [] });
  }, dispose: () => descriptors.dispose() };
}

const engines: Engine[] = ["quickjs", "jsc", "browser", "hermes"];

for (const engine of engines) {
  test(`${engine} roots find bun/node/nodejs through PATH with their selected engine and existing module`, async () => {
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Root engine aliases must not download another guest"));
    const state = isolatedRoot(false, engine);
    let root: ReturnType<typeof rootClient> | undefined;
    try {
      await state.ready;
      root = rootClient(state.request, message => state.worker.onmessage?.({ data: message } as MessageEvent));
      state.release();
      expect(await root.which("bun")).toBe(`${ENGINE_BIN[engine]}/bun`);
      for (const name of ["bun", "node", "nodejs", `${ENGINE_BIN[engine]}/bun`, `${ENGINE_BIN[engine]}/node`, `${ENGINE_BIN[engine]}/nodejs`]) {
        const pid = await root.spawn(name);
        const entry = await state.requestFor(pid);
        expect(entry.engine).toBe(engine);
        expect(entry.adapter).toBe("bun");
        expect(entry.module).toBe(state.request.module);
        state.workerFor(pid).exit(0);
        const supervisor = await state.runtime.processes().then(service => service.ready());
        expect((await supervisor.waitForExit(root.client.pid, pid)).status).toBe(0);
      }
      expect(fetch).not.toHaveBeenCalled();
      for (const name of engine === "hermes" ? [] : ["bun", "node", "nodejs"]) await expect(root.which(`/opt/bun/hermes/bin/${name}`)).rejects.toThrow("No executable");
    } finally {
      try { root?.dispose(); await state.dispose(); }
      finally { fetch.mockRestore(); }
    }
  });

  test(`${engine} roots retain explicit engine overrides and cache each guest module`, async () => {
    const { quickjsPair } = await import("../../tests/package/quickjs-plan-fixture");
    const { programLinkPlan } = await import("../../src/assets");
    const { core, side } = quickjsPair();
    const pair = new Map([["bun.wasm", core], ["quickjs.wasm", side]]);
    const builds = Object.fromEntries(Array.from(pair, ([name, bytes]) => [name, new Bun.CryptoHasher("sha256").update(bytes).digest("hex")]));
    const originalBuilds = Object.getOwnPropertyDescriptor(globalThis, "__bunwasmBuilds");
    Object.defineProperty(globalThis, "__bunwasmBuilds", { configurable: true, value: builds });
    const register = spyOn(SubprocessBroker.prototype, "register");
    const urls: string[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      const name = new URL(url).pathname.slice(1);
      if (name.endsWith(".gz")) return new Response(null, { status: 404 });
      return new Response(pair.get(name) ?? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { "content-type": "application/wasm" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const state = isolatedRoot(false, engine);
    try {
      await state.ready;
      const entries = new Map(register.mock.calls);
      const available = engines.filter(selected => selected !== "hermes" || engine === "hermes");
      const loaded = new Set<WebAssembly.Module>();
      for (const selected of available) {
        const entry = entries.get(`${ENGINE_BIN[selected]}/bun`);
        if (!entry) throw new Error(`Missing explicit engine registration: ${selected}`);
        if (entry.adapter !== "bun") throw new Error(`Explicit ${selected} program must use the Bun adapter`);
        expect(entry.engine).toBe(selected);
        expect(entry.adapter).toBe("bun");
        const module = typeof entry.module === "function" ? await entry.module() : entry.module;
        const again = typeof entry.module === "function" ? await entry.module() : entry.module;
        expect(module).toBeInstanceOf(WebAssembly.Module);
        expect(again).toBe(module);
        if (selected === engine) expect(module).toBe(state.request.module);
        else expect(module).not.toBe(state.request.module);
        if (selected === "quickjs" && selected !== engine) expect(programLinkPlan(module)?.libraries[0]?.source).toEqual(side);
        loaded.add(module);
      }
      expect(loaded.size).toBe(available.length);
      expect(urls).toEqual(available.filter(selected => selected !== engine).flatMap(selected => selected === "quickjs"
        ? ["bun.wasm", "quickjs.wasm"].flatMap(name => [`http://localhost/${name}.gz?v=${builds[name]}`, `http://localhost/${name}`])
        : [`http://localhost/${ENGINES[selected].wasm}.gz`, `http://localhost/${ENGINES[selected].wasm}`]));
    } finally {
      try { await state.dispose(); }
      finally {
        register.mockRestore(); fetch.mockRestore();
        if (originalBuilds) Object.defineProperty(globalThis, "__bunwasmBuilds", originalBuilds);
        else Reflect.deleteProperty(globalThis, "__bunwasmBuilds");
      }
    }
  });
}

test("concurrent roots on one runtime inherit independent engine PATHs without replacing other roots", async () => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [];
  const workers: FakeWorker[] = [];
  const requests = new Map<number, RunRequest>();
  const runs: ReturnType<typeof startRun>[] = [];
  const clients: ReturnType<typeof rootClient>[] = [];
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    String(input).endsWith(".gz") ? new Response(null, { status: 404 })
      : new Response(wasm, { headers: { "content-type": "application/wasm" } }), { preconnect: globalThis.fetch.preconnect }));
  function connect(identity = createFilesystemIdentity()) {
    const channel = new MessageChannel(); channel.port2.close(); ports.push(channel.port1);
    return { ...identity, port: channel.port1 };
  }
  const runtime = processRuntimeFixture({ fork: () => connect(), connect, revoke() {}, reap() {}, async quiesce() {} } as unknown as SharedFilesystem);
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    request!: RunRequest;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request: RunRequest) { this.request = request; requests.set(pidOf(request), request); }
    terminate() { this.terminated = true; }
  }
  async function received(pid: number): Promise<RunRequest> {
    const deadline = performance.now() + 1000;
    while (!requests.has(pid) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    const request = requests.get(pid);
    if (!request) throw new Error(`worker ${pid} did not receive its run request`);
    return request;
  }
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    for (const engine of engines) {
      runs.push(startRun({ engine, module: new WebAssembly.Module(wasm), args: [], env: {}, runtime, moduleScope: false }, { stdout() {}, stderr() {} }));
    }
    const roots = workers.slice();
    for (const worker of roots) {
      const deadline = performance.now() + 1000;
      while (!worker.request && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
      expect(worker.request).toBeDefined();
      const root = worker.request;
      const client = rootClient(root, message => worker.onmessage?.({ data: message } as MessageEvent));
      clients.push(client);
      expect(await client.which("bun")).toBe(`${ENGINE_BIN[root.engine]}/bun`);
      for (const alias of ["bun", "node", `${ENGINE_BIN[root.engine]}/bun`, `${ENGINE_BIN[root.engine]}/node`]) {
        const pid = await client.spawn(alias);
        const child = await received(pid);
        expect(child.engine).toBe(root.engine);
        expect(child.adapter).toBe("bun");
        workers.find(candidate => candidate.request && pidOf(candidate.request) === pid)!.onmessage?.({ data: { type: "exit", code: 0, sleep: "atomics" } } as MessageEvent);
        const supervisor = await runtime.processes().then(service => service.ready());
        expect((await supervisor.waitForExit(client.client.pid, pid)).status).toBe(0);
      }
    }
    expect(roots.every(worker => !worker.terminated)).toBe(true);
  } finally {
    for (const client of clients) client.dispose();
    for (const run of runs) run.kill(9);
    try { await Promise.all(runs.map(run => run.done)); await runtime.dispose(); }
    finally {
      for (const worker of workers) worker.terminate();
      for (const port of ports) port.close();
      fetch.mockRestore();
      globalThis.Worker = originalWorker;
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
      if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    }
  }
});

test("Preview1 roots keep independent explicit modules and 100 launches register no per-run executables", async () => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [];
  const workers: FakeWorker[] = [];
  const runs: ReturnType<typeof startRun>[] = [];
  const registered: string[] = [];
  function connect(identity = createFilesystemIdentity()) {
    const channel = new MessageChannel(); channel.port2.close(); ports.push(channel.port1);
    return { ...identity, port: channel.port1 };
  }
  const runtime = processRuntimeFixture({ fork: () => connect(), connect, revoke() {}, reap() {}, async quiesce() {} } as unknown as SharedFilesystem);
  const register = runtime.registerProgram.bind(runtime);
  runtime.registerProgram = (name, program) => { registered.push(name); return register(name, program); };
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    request?: RunRequest;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request: RunRequest) { this.request = request; }
    terminate() { this.terminated = true; }
    exit() { this.onmessage?.({ data: { type: "exit", code: 0, sleep: "atomics" } } as MessageEvent); }
  }
  const launch = async (module: WebAssembly.Module, engine: Engine = "browser", adapter: "bun" | "preview1" = "preview1") => {
    const run = startRun({ engine, adapter, module, args: [], env: {}, runtime, moduleScope: false }, { stdout() {}, stderr() {} });
    runs.push(run);
    const worker = workers.at(-1)!;
    const deadline = performance.now() + 1000;
    while (!worker.request && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    expect(worker.request?.module).toBe(module);
    expect(worker.request?.adapter).toBe(adapter);
    expect(worker.request?.env.PATH?.split(":")[0]).toBe(ENGINE_BIN[engine]);
    return { run, worker };
  };
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const first = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const second = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, 120]));
    const a = await launch(first), b = await launch(second);
    expect(a.worker.request!.module).not.toBe(b.worker.request!.module);
    a.worker.exit(); b.worker.exit();
    await Promise.all([a.run.done, b.run.done]);
    for (let index = 0; index < 100; index++) {
      const { run, worker } = await launch(index % 2 ? first : second, engines[index % engines.length]!, "bun");
      worker.exit();
      expect(await run.done).toEqual({ code: 0 });
    }
    expect(registered).toEqual(["/opt/bun/quickjs/bin/bun", "/opt/bun/quickjs/bin/node", "/opt/bun/quickjs/bin/nodejs", "/opt/bun/jsc/bin/bun", "/opt/bun/jsc/bin/node", "/opt/bun/jsc/bin/nodejs", "/bin/bun", "/bin/node", "/bin/nodejs", "/opt/bun/hermes/bin/bun", "/opt/bun/hermes/bin/node", "/opt/bun/hermes/bin/nodejs"]);
    for (const path of registered) expect(await runtime.filesystem.lookup(path)).toMatchObject({ kind: "file" });
    // Page-launched modules never become executable files or retain a per-launch registry key.
    expect(await runtime.filesystem.lookup("/bin/preview1-root-1")).toBeUndefined();
    expect(await runtime.filesystem.lookup("/usr/libexec/preview1-root")).toBeUndefined();
    expect(workers.every(worker => worker.terminated)).toBe(true);
  } finally {
    for (const run of runs) run.kill(9);
    try { await Promise.all(runs.map(run => run.done)); await runtime.dispose(); }
    finally {
      for (const port of ports) port.close();
      globalThis.Worker = originalWorker;
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
      if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    }
  }
});

test("one isolated Ctrl-C claims DEFAULT 130 immediately before quiescent physical stop", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    expect(signalsOf(state.request).signalState).toBeInstanceOf(TaggedCells);
    const waiting = runConfirmation(state.run);
    state.run.kill();
    expect(readOutcome(signalsOf(state.request).outcome)).toEqual({ kind: "signaled", code: 2, status: 130 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(waiting.confirmed()).toBe(false);
    expect(state.revoked()).toBe(1);
    expect(state.worker.terminated).toBe(0);
    state.worker.exit(0);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    state.release();
    expect(await waiting.result).toEqual({ code: 130 });
    expect(state.worker.terminated).toBe(1);
  } finally { await state.dispose(); }
});

for (const code of [0, 23, 130]) {
  test(`handled root INT keeps ordinary guest exit ${code}`, async () => {
    const state = isolatedRoot();
    try {
      await state.ready;
      const signalState = signalsOf(state.request).signalState;
      setSignalDisposition(signalState, 2, 2);
      state.run.kill();
      expect(takeSignal(signalState)).toBe(2);
      expect(takeSignal(signalState)).toBe(0);
      expect(readOutcome(signalsOf(state.request).outcome)).toBeNull();
      expect(state.revoked()).toBe(0);
      const root = await state.record();
      state.worker.exit(code);
      expect(await state.run.done).toEqual({ code });
      expect(root.result).toEqual({ kind: "exited", code, status: code });
      expect(() => readOutcome(root.outcome)).toThrow("collected");
      expect(state.reaped()).toBe(1);
    } finally { await state.dispose(); }
  });
}

test("root IGNORE leaves no pending signal or terminal result", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const signalState = signalsOf(state.request).signalState;
    setSignalDisposition(signalState, 2, 1);
    state.run.kill();
    expect(takeSignal(signalState)).toBe(0);
    expect(controlLoad(signalsOf(state.request).interrupt, 0)).toBe(0);
    expect(readOutcome(signalsOf(state.request).outcome)).toBeNull();
    expect(state.revoked()).toBe(0);
    state.worker.exit(0);
    expect(await state.run.done).toEqual({ code: 0 });
  } finally { await state.dispose(); }
});

test("removing a root handler restores the next explicit INT default", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const signalState = signalsOf(state.request).signalState;
    setSignalDisposition(signalState, 2, 2);
    state.run.kill(2);
    expect(takeSignal(signalState)).toBe(2);
    expect(setSignalDisposition(signalState, 2, 0)).toBe(false);
    const root = await state.record();
    state.run.kill(2);
    state.release();
    expect(await state.run.done).toEqual({ code: 130 });
    expect(root.result?.kind).toBe("signaled");
    expect(() => readOutcome(root.outcome)).toThrow("collected");
  } finally { await state.dispose(); }
});

test.each([0, 143])("a root exit already claimed as %s wins a later default signal", async code => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const root = await state.record();
    claimOutcome(signalsOf(state.request).outcome, { kind: "exited", code });
    state.run.kill(2);
    state.release();
    expect(await state.run.done).toEqual({ code });
    expect(root.result).toEqual({ kind: "exited", code, status: code });
    expect(() => readOutcome(root.outcome)).toThrow("collected");
  } finally { await state.dispose(); }
});

test("root acknowledgement adopts a previously claimed typed signal rather than ordinary 143", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const root = await state.record();
    claimOutcome(signalsOf(state.request).outcome, { kind: "signaled", code: 15 });
    state.worker.exit(143);
    expect(await state.run.done).toEqual({ code: 143 });
    expect(root.result).toEqual({ kind: "signaled", code: 15, status: 143 });
    expect(() => readOutcome(root.outcome)).toThrow("collected");
  } finally { await state.dispose(); }
});

for (const signal of [2, 9, 13, 15]) {
  test(`a root's caught default ${signal} is observed without a worker exit acknowledgement`, async () => {
    const state = isolatedRoot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await state.ready;
      claimOutcome(signalsOf(state.request).outcome, { kind: "signaled", code: signal });
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("root signal outcome was not observed")), 250); });
      const waiting = runConfirmation(state.run);
      await new Promise(resolve => setTimeout(resolve, 12));
      expect(waiting.confirmed()).toBe(false);
      expect(state.reaped()).toBe(0);
      expect(state.revoked()).toBe(1);
      expect(state.worker.terminated).toBe(0);
      state.release();
      expect(await Promise.race([waiting.result, timeout])).toEqual({ code: 128 + signal });
      expect(state.worker.terminated).toBe(1);
    } finally { clearTimeout(timer); await state.dispose(); }
  });
}

test("root capability messages cannot cross a selected fatal outcome before its timer observes it", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(signalsOf(state.request).outcome, { kind: "signaled", code: 15 });
    state.worker.onmessage?.({ data: { type: "stdout", data: new TextEncoder().encode("late output") } } as MessageEvent);
    state.worker.onmessage?.({ data: { type: "phase", name: "late-phase", duration: 0 } } as MessageEvent);
    expect(state.output).toEqual([]);
    expect(state.phases).toEqual([]);
    state.release();
    expect(await state.run.done).toEqual({ code: 143 });
    expect(state.reaped()).toBe(0);
  } finally { await state.dispose(); }
});

test("a second implicit UI stop still force-kills a root that handled the first Ctrl-C", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    const signalState = signalsOf(state.request).signalState;
    setSignalDisposition(signalState, 2, 2);
    state.run.kill();
    expect(takeSignal(signalState)).toBe(2);
    expect(readOutcome(signalsOf(state.request).outcome)).toBeNull();
    const root = await state.record();
    state.run.kill();
    state.release();
    expect(await state.run.done).toEqual({ code: 137 });
    expect(root.result).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(() => readOutcome(root.outcome)).toThrow("collected");
  } finally { await state.dispose(); }
});

for (const code of [1, 126]) {
  test(`root crash acknowledgement preserves selected ordinary ${code} and diagnostic stack`, async () => {
    const state = isolatedRoot();
    try {
      await state.ready;
      claimOutcome(signalsOf(state.request).outcome, { kind: "exited", code });
      state.worker.onmessage?.({ data: { type: "error", code, message: "crash details\nstack frame", sleep: "atomics" } } as MessageEvent);
      expect(await state.run.done).toEqual({ code, error: "bun.wasm crashed: crash details\r\nstack frame" });
      expect(state.reaped()).toBe(1);
    } finally { await state.dispose(); }
  });
}

test("typed fatal winner suppresses a later ordinary crash diagnostic", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(signalsOf(state.request).outcome, { kind: "signaled", code: 15 });
    state.worker.onmessage?.({ data: { type: "error", code: 1, message: "stale crash", sleep: "atomics" } } as MessageEvent);
    expect(await state.run.done).toEqual({ code: 143 });
  } finally { await state.dispose(); }
});

test("an earlier ordinary root winner does not inherit a losing crash diagnostic", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(signalsOf(state.request).outcome, { kind: "exited", code: 0 });
    state.worker.onmessage?.({ data: { type: "error", code: 1, message: "losing crash", sleep: "atomics" } } as MessageEvent);
    expect(await state.run.done).toEqual({ code: 0 });
  } finally { await state.dispose(); }
});

for (const acknowledged of [false, true]) test(`runner root job completion uses its own filesystem fence (acknowledged ${acknowledged})`, async () => {
  let broker!: SubprocessBroker;
  const original = SubprocessBroker.prototype.register;
  const register = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(this: SubprocessBroker, name, entry) {
    // oxlint-disable-next-line typescript/no-this-alias -- Capture the actual fake worker or receiver for assertions outside this callback.
    broker = this;
    original.call(this, name, entry);
  });
  const state = isolatedRoot();
  try {
    await state.ready;
    const supervisor = await broker.ready();
    const root = supervisor.get(1)!;
    const background = supervisor.reserveSpawn(1, { executable: "bun", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    const waiting = runConfirmation(state.run);
    if (acknowledged) state.worker.exit(23);
    else state.run.kill(9);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(waiting.confirmed()).toBe(acknowledged);
    expect(root.result?.status ?? null).toBe(acknowledged ? 23 : null);
    expect(root.jobSafe).toBe(acknowledged);
    expect(supervisor.job(1)?.pendingMembers ?? 0).toBe(acknowledged ? 0 : 1);
    // Runner physical stop and supervisor confirmation share exactly one fence.
    expect(state.revoked()).toBe(acknowledged ? 0 : 1);
    state.release();
    expect((await waiting.result).code).toBe(acknowledged ? 23 : 137);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.result?.status).toBe(acknowledged ? 23 : 137);
    expect(root.jobSafe).toBe(true);
    expect(supervisor.job(1)?.pendingMembers ?? 0).toBe(0);
    expect(supervisor.get(background)!.result).toBeNull();
    expect(state.worker.terminated).toBe(1);
  } finally { register.mockRestore(); await state.dispose(); broker.dispose(); }
});

test("run.done waits for deferred root activation and descriptor release", async () => {
  const proc = await import("waffle/proc");
  let broker!: SubprocessBroker;
  let activate!: () => void;
  const activation = new Promise<void>(resolve => { activate = resolve; });
  const original = SubprocessBroker.prototype.register;
  const register = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(this: SubprocessBroker, name, entry) {
    // oxlint-disable-next-line typescript/no-this-alias -- Capture the actual fake worker or receiver for assertions outside this callback.
    broker = this;
    original.call(this, name, entry);
  });
  let released = false;
  class DescriptorSupervisor extends proc.ProcessSupervisor {
    override createRoot(options: RootProcessOptions): number {
      const pid = super.createRoot(options);
      this.get(pid)!.descriptors.open({
        kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      }, 0n, 0n, () => { released = true; });
      return pid;
    }
  }
  // Install the descriptor before readiness resolves: the generic owner may observe the
  // selected root outcome before a caller's subsequent .then callback runs.
  const state = isolatedRoot(true, "browser", { activate: async () => { await activation; return { ...proc, ProcessSupervisor: DescriptorSupervisor }; } });
  let supervisor!: ReturnType<SubprocessBroker["ready"]>;
  try {
    await state.ready;
    // The service adopts a root before it activates; adoption of a root waits for any
    // activation already requested, so the deferred activation starts after the worker did.
    supervisor = broker.ready();
    const waiting = runConfirmation(state.run);
    state.run.kill(9);
    state.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(waiting.confirmed()).toBe(false);
    expect(released).toBe(false);
    expect(state.worker.terminated).toBe(0);
    activate();
    const active = await supervisor;
    expect(await waiting.result).toEqual({ code: 137 });
    expect(released).toBe(true);
    // A completed root with no descendants retires after its descriptor fence; run.done
    // above retains the terminal winner without retaining page-owned controller metadata.
    expect(active.get(1)).toBeUndefined();
    expect(state.revoked()).toBe(1);
    expect(state.worker.terminated).toBe(1);
  } finally {
    activate();
    await supervisor?.catch(() => {});
    register.mockRestore();
    await state.dispose();
    broker.dispose();
  }
});

for (const partial of [false, true]) test(`run.done safely handles rejected deferred process activation (partial root ${partial})`, async () => {
  const proc = await import("waffle/proc");
  let broker!: SubprocessBroker;
  let failActivation!: () => void;
  const failure = new Error("process module could not initialize");
  let released = false;
  class PartialSupervisor extends proc.ProcessSupervisor {
    override createRoot(options: RootProcessOptions): never {
      const pid = super.createRoot(options);
      this.get(pid)!.descriptors.open({
        kind: "terminal", read: () => 0, write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      }, 0n, 0n, () => { released = true; });
      throw failure;
    }
  }
  const activation = new Promise<typeof proc>((resolve, reject) => {
    failActivation = () => partial ? resolve({ ...proc, ProcessSupervisor: PartialSupervisor }) : reject(failure);
  });
  const original = SubprocessBroker.prototype.register;
  const register = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(this: SubprocessBroker, name, entry) {
    // oxlint-disable-next-line typescript/no-this-alias -- Capture the actual fake worker or receiver for assertions outside this callback.
    broker = this;
    original.call(this, name, entry);
  });
  const report = spyOn(console, "error").mockImplementation(() => {});
  const state = isolatedRoot(true, "browser", { activate: () => activation });
  let attempted!: Promise<unknown>;
  try {
    await state.ready;
    // Observe the explicit ready request too; rootExit must handle only its activation
    // rejection, while the runner's own filesystem fence remains mandatory.
    attempted = broker.ready().catch(error => error);
    const waiting = runConfirmation(state.run);
    state.run.kill(9);
    failActivation();
    expect(await attempted).toBe(failure);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(waiting.confirmed()).toBe(false);
    expect(state.worker.terminated).toBe(0);
    expect(state.revoked()).toBe(1);
    expect(report).toHaveBeenCalledWith("runtime: process controller failed", failure);
    expect(released).toBe(partial);
    state.release();
    expect(await waiting.result).toEqual({ code: 137 });
    expect(state.worker.terminated).toBe(1);
  } finally {
    failActivation();
    register.mockRestore();
    await state.dispose();
    broker.dispose();
    // dispose observes the same failed activation asynchronously.
    await new Promise(resolve => setTimeout(resolve, 0));
    report.mockRestore();
  }
});

test("run.done confirms after the filesystem fence without awaiting physical worker termination", async () => {
  const state = isolatedRoot();
  await state.ready;
  let release!: () => void;
  const physicalTermination = new Promise<void>(resolve => { release = resolve; });
  const terminate = spyOn(state.worker, "terminate").mockImplementation(() => physicalTermination);
  try {
    const waiting = runConfirmation(state.run);
    state.run.kill(9);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    state.release();
    expect(await waiting.result).toEqual({ code: 137 });
    expect(terminate).toHaveBeenCalledTimes(1);
    // The returned physical-termination promise is deliberately still unresolved.
  } finally { release(); terminate.mockRestore(); await state.dispose(); }
});

test("typed root startup failures preserve their diagnostic and shell status", async () => {
  const state = isolatedRoot();
  try {
    await state.ready;
    claimOutcome(signalsOf(state.request).outcome, { kind: "start-failed", code: 13 });
    state.worker.onmessage?.(new MessageEvent("message", { data: { type: "error", code: 126, message: "invalid executable", sleep: "atomics" } }));
    state.release();
    expect(await state.run.done).toEqual({ code: 126, error: "bun.wasm crashed: invalid executable" });
    expect(state.worker.terminated).toBe(1);
  } finally { await state.dispose(); }
});

for (const terminal of [{ code: 0 }, { code: 143, signal: 15 }]) test(`worker cleanup fault preserves status ${terminal.code} but requires a root admission fence`, async () => {
  const report = spyOn(console, "error").mockImplementation(() => {});
  const state = isolatedRoot();
  try {
    await state.ready;
    const waiting = runConfirmation(state.run);
    state.worker.onmessage?.({ data: { type: "cleanup-error", ...terminal, message: "filesystem release failed", cleanupErrors: ["filesystem release failed"] } } as MessageEvent);
    await Promise.resolve();
    expect(waiting.confirmed()).toBe(false);
    expect(state.reaped()).toBe(0);
    expect(state.worker.terminated).toBe(0);
    expect(state.revoked()).toBe(1);
    state.release();
    expect(await waiting.result).toEqual({ code: terminal.code });
    expect(state.worker.terminated).toBe(1);
    expect(report).toHaveBeenCalledWith("bun-wasm: root cleanup failed", "filesystem release failed");
  } finally {
    try { await state.dispose(); } finally { report.mockRestore(); }
  }
});


test("process runtime fixture releases program registrations idempotently", async () => {
  const runtime = processRuntimeFixture({} as SharedFilesystem);
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const program = { adapter: "fixture", module, cooperative: true } as const;
  const unregisterAdapter = runtime.registerAdapter("fixture", async () => { throw new Error("unused launcher"); });
  try {
    const unregister = runtime.registerProgram("/bin/fixture", program);
    expect(() => runtime.registerProgram("/bin/fixture", program)).toThrow("already registered");
    unregister();
    const replacement = runtime.registerProgram("/bin/fixture", program);
    unregister();
    expect(() => runtime.registerProgram("/bin/fixture", program)).toThrow("already registered");
    replacement();
    runtime.registerProgram("/bin/fixture", program)();
  } finally { unregisterAdapter(); await runtime.dispose(); }
});

async function assertToolsRoot(engine: "quickjs" | "jsc" | "browser", linked: WebAssembly.Module, tools?: WebAssembly.Module) {
  const state = isolatedRoot(false, engine, {}, engine === "jsc" ? ["--cwd", "/", "fmt"] : ["lint"], undefined, engine === "quickjs" ? linked : undefined);
  try {
    await state.ready;
    tools ??= state.request.module;
    expect(state.request.module).toBe(tools);
    expect(state.request.engine).toBe(engine);
    expect(state.request.args[0]).toBe(`${ENGINE_BIN[engine]}/bun`);
    expect(state.request.runtimeProcess).toBeDefined();
    expect(state.request.linkPlan).toBeUndefined();
    state.worker.exit(0);
    expect((await state.run.done).code).toBe(0);
    return tools;
  } finally { await state.dispose(); }
}

test("page lint/fmt roots lazily compile verified tools once and clear the selected pair plan", async () => {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const { quickjsPair } = await import("../../tests/package/quickjs-plan-fixture");
  const { prepareQuickjsProgram } = await import("../../src/assets");
  const { core, side } = quickjsPair();
  const linked = await prepareQuickjsProgram(core, side);
  const build = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const originalBuilds = Object.getOwnPropertyDescriptor(globalThis, "__bunwasmBuilds");
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(Bun.gzipSync(bytes)), { preconnect: globalThis.fetch.preconnect }));
  const compile = spyOn(WebAssembly, "compile");
  try {
    Object.defineProperty(globalThis, "__bunwasmBuilds", { configurable: true, value: { "bun-tools.wasm": build } });
    let tools: WebAssembly.Module | undefined;
    for (const engine of ["quickjs", "jsc", "browser"] as const) {
      tools = await assertToolsRoot(engine, linked, tools);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore(); compile.mockRestore();
    if (originalBuilds) Object.defineProperty(globalThis, "__bunwasmBuilds", originalBuilds);
    else Reflect.deleteProperty(globalThis, "__bunwasmBuilds");
  }
});


test("worker failure before deferred executable markers cannot adopt a late running root", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const state = isolatedRoot(true, "browser", {}, ["-e", "0"], runtime => {
    const lookup = runtime.filesystem.lookup.bind(runtime.filesystem);
    runtime.filesystem.lookup = async path => { entered.resolve(); await gate.promise; return lookup(path); };
  });
  try {
    await entered.promise;
    state.worker.onerror!({ preventDefault() {}, message: "early worker failure" } as ErrorEvent);
    state.release();
    expect(await state.run.done).toMatchObject({ code: 1 });
    expect(state.worker.terminated).toBe(1);
    gate.resolve();
    // Await every marker in the serialized preparation chain before inspecting service ownership.
    await new Promise(resolve => setTimeout(resolve, 20));
    const supervisor = await (await state.runtime.processes()).ready();
    expect(supervisor.get(1)).toBeUndefined();
  } finally { gate.resolve(); await state.dispose(); }
});
