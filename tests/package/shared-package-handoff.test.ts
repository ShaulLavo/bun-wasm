import { expect, test } from "bun:test";
import { createRuntime, type RuntimeProcessContext } from "waffle";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { DescriptorTable } from "waffle/core/descriptors";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { FilesystemSection } from "waffle/fs/protocol";
import { captureProcessObserver } from "waffle/proc/observation";
import { installBunAdapters } from "../../src/bun-adapter.ts";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind.ts";
import { admittedIdentity } from "../../src/package-continuation.ts";
import { PACKAGE_ADAPTER } from "../../src/package-continuation-binding.ts";
import { createProgramShell } from "./fixtures/program-shell.ts";
import { sharedHandoffProgram } from "./fixtures/shared-handoff-program.ts";
import type { SharedHandoffRequest } from "./fixtures/shared-handoff-worker.ts";

const workerUrl = new URL("./fixtures/shared-handoff-worker.ts", import.meta.url).href;
const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

async function usingShared(surviving: boolean, run: (f: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const NativeWorker = globalThis.Worker;
  const nativeTerminate = NativeWorker.prototype.terminate;
  const workers: Worker[] = [];
  const stopped = new Set<Worker>();
  const sourceWorkers: Worker[] = [];
  const stopEntered = Promise.withResolvers<void>();
  const stopGate = Promise.withResolvers<void>();
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers.push(this);
      if (String(url) === workerUrl) sourceWorkers.push(this);
    }
    override async terminate() {
      if (this === sourceWorkers[0] && !surviving) { stopEntered.resolve(); await stopGate.promise; }
      await Reflect.apply(nativeTerminate, this, []);
      stopped.add(this);
    }
  };
  const cleanup = { workers, sourceWorkers, stopped, stopEntered, stopGate };
  let fixture: Awaited<ReturnType<typeof prepare>> | undefined;
  try { fixture = await prepare(surviving, cleanup); await run(fixture); }
  finally {
    stopGate.resolve();
    fixture?.release();
    for (const worker of sourceWorkers) worker.postMessage({ kind: "release" });
    try { await fixture?.dispose(); }
    finally {
      globalThis.Worker = NativeWorker;
      await forceStop(workers, stopped, nativeTerminate);
    }
  }
  expect(stopped.size).toBe(workers.length);
}

async function forceStop(workers: Worker[], stopped: Set<Worker>, terminate: Worker["terminate"]) {
  for (const worker of workers) {
    if (stopped.has(worker)) continue;
    await Reflect.apply(terminate, worker, []);
  }
}

type Cleanup = {
  workers: Worker[]; sourceWorkers: Worker[]; stopped: Set<Worker>;
  stopEntered: ReturnType<typeof Promise.withResolvers<void>>;
  stopGate: ReturnType<typeof Promise.withResolvers<void>>;
};

async function prepare(surviving: boolean, cleanup: Cleanup) {
  const fenceEntered = Promise.withResolvers<void>();
  const adapterEntered = Promise.withResolvers<void>();
  const adapterGate = Promise.withResolvers<void>();
  const childEntered = Promise.withResolvers<void>();
  const childGate = Promise.withResolvers<void>();
  const callerReady = Promise.withResolvers<void>();
  const peerReady = Promise.withResolvers<void>();
  const tables: DescriptorTable[] = [];
  const sources: RuntimeProcessContext[] = [];
  const sourceStops: Array<() => void | Promise<void>> = [];
  const targets: RuntimeProcessContext[] = [];
  let section: FilesystemSection | undefined;
  let sourceSections: SharedArrayBuffer | undefined;
  let sectionActive = false;
  let adapterStopped = false;
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL(import.meta.resolve("waffle/browser/fs-worker")) },
    memoryGroups: BUN_MEMORY_GROUP_POLICY,
    processHost: options => new BrowserProcessBroker({ ...options, filesystem: { ...options.filesystem,
      async quiesce(identity) {
        if (identity.sections === sourceSections) fenceEntered.resolve();
        await options.filesystem.quiesce(identity);
      },
    } }),
  });
  const release = () => {
    if (sectionActive) { section!.exit(); sectionActive = false; }
    cleanup.stopGate.resolve(); adapterGate.resolve(); childGate.resolve();
  };
  const dispose = async () => { release(); try { await runtime.dispose(); } finally { for (const table of tables) table.dispose(); } };
  try {
    const program = await sharedHandoffProgram();
    expect(WebAssembly.Module.imports(program.module).some(entry => entry.kind === "memory")).toBe(true);
    expect(WebAssembly.Module.exports(program.module).some(entry => entry.kind === "memory")).toBe(false);
    const owner = { ...runtime, registerHostAdapter(name: string, launch: Parameters<typeof runtime.registerHostAdapter>[1]) {
      return runtime.registerHostAdapter(name, (context, service) => {
        expect("takeWorker" in service).toBe(false);
        if (name === PACKAGE_ADAPTER) targets.push(context);
        return launch(context, service);
      });
    } };
    await installBunAdapters(owner, { module: empty, workerUrl, notificationWorkerUrl: new URL("../../src/notification-worker-entry.ts", import.meta.url).href });
    runtime.registerAdapter("source", (context, service) => {
      sources.push(context);
      const peer = context.request.argv[1] === "peer";
      if (!peer) sourceSections = admittedIdentity(context, service).sections;
      const handle = service.launchWorker<SharedHandoffRequest>(context, { workerUrl,
        memoryGroup: peer ? service.memoryGroupOf(sources[0]!.pid) : "new",
        request: { module: context.module, engine: "quickjs", linkPlan: program.linkPlan, slots: "off", net: null, trace: false,
          args: context.request.argv, env: {}, hold: peer },
        onMessage(message) { if (message && typeof message === "object" && "type" in message && message.type === "shared-ready") (peer ? peerReady : callerReady).resolve(); },
      });
      const accepted = { async terminate() {
        await handle.terminate();
        if (peer || surviving) return;
        adapterEntered.resolve(); await adapterGate.promise; adapterStopped = true;
      } };
      sourceStops.push(() => accepted.terminate());
      return accepted;
    });
    runtime.registerProgram("/caller", { module: program.module, adapter: "source", cooperative: true });
    runtime.registerAdapter("shell", context => {
      if (!context.started()) return { terminate() {} };
      childEntered.resolve();
      void childGate.promise.then(() => context.exit(0));
      return { terminate() { childGate.resolve(); } };
    });
    runtime.registerProgram("/bin/bash", { module: empty, adapter: "shell", cooperative: true });
    await runtime.filesystem.writeFile("/caller", "caller");
    await runtime.filesystem.writeFile("/bin/bash", "shell");
    await runtime.filesystem.writeFile("/still-usable", "live source");
    await runtime.filesystem.drain();
    const shell = await createProgramShell(runtime, tables);
    tables[0]!.openAt(0, { kind: "terminal", read: () => 0, write: () => 0, tryRead: () => 0,
      readiness: () => ({ readable: true, writable: true, hangup: false }) }, 2n | (1n << 27n), 0n);
    createRuntimeTerminalCodec({ descriptors: tables[0], fallback: createWorkerPipeCodec() });
    const caller = await shell.spawn("/caller", ["caller"], {}, [0, 1, 2].map(fd => ({ parent: fd, child: fd })));
    await Promise.race([callerReady.promise, caller.exit.then(exit => { throw new Error(`Caller stopped before ready: ${JSON.stringify(exit)}`); })]);
    const service = await runtime.processes();
    const source = sources[0]!;
    const groupId = service.memoryGroupOf(caller.pid)?.id;
    expect(groupId).toBeString();
    const observer = captureProcessObserver(source.observation);
    const holdFilesystem = () => {
      section = new FilesystemSection(admittedIdentity(source, service));
      section.enter(); sectionActive = true;
    };
    return { runtime, service, shell, caller, sources, targets, groupId, observer, callerReady, peerReady, fenceEntered,
      adapterEntered, adapterGate, childEntered, childGate, cleanup, holdFilesystem, release, dispose,
      releaseFilesystem() { if (sectionActive) { section!.exit(); sectionActive = false; } },
      adapterStopped: () => adapterStopped,
      returned: () => Promise.all(sourceStops.map(stop => stop())),
      pending: (milestone: Promise<void>) => Promise.race([milestone, caller.exit.then(exit => {
        throw new Error(`Caller finished before milestone: ${JSON.stringify({ exit, output: shell.output })}`);
      })]),
    };
  } catch (error) { await dispose(); throw error; }
}

test("released Runtime admits slots-off imported PIE only after real filesystem, native and adapter retirement", async () => usingShared(false, async f => {
  f.holdFilesystem();
  f.cleanup.sourceWorkers[0]!.postMessage({ kind: "release" });
  await f.pending(f.fenceEntered.promise);
  expect(f.targets).toHaveLength(0);
  expect(f.service.memoryGroupOf(f.caller.pid)?.id).toBe(f.groupId);
  expect(f.observer.read().kind).toBe("pending");
  f.releaseFilesystem();
  await f.pending(f.cleanup.stopEntered.promise);
  expect(f.cleanup.stopped.has(f.cleanup.sourceWorkers[0]!)).toBe(false);
  expect(f.targets).toHaveLength(0);
  expect(f.service.memoryGroups()[0]?.committedBytes).toBeGreaterThan(0);
  expect(f.observer.read().kind).toBe("pending");
  f.cleanup.stopGate.resolve();
  await f.pending(f.adapterEntered.promise);
  expect(f.cleanup.stopped.has(f.cleanup.sourceWorkers[0]!)).toBe(true);
  expect(f.targets).toHaveLength(0);
  expect(f.service.memoryGroupOf(f.caller.pid)?.id).toBe(f.groupId);
  f.adapterGate.resolve();
  await f.pending(f.childEntered.promise);
  expect(f.adapterStopped()).toBe(true);
  expect(f.targets).toHaveLength(1);
  expect(f.targets[0]).toMatchObject({ pid: f.sources[0]!.pid, parentPid: f.sources[0]!.parentPid, job: f.sources[0]!.job, generation: 2 });
  expect(f.service.memoryGroupOf(f.caller.pid)).toBeUndefined();
  expect(f.service.memoryGroups()).toEqual([]);
  expect(f.observer.read().kind).toBe("pending");
  f.childGate.resolve();
  expect(await f.caller.exit).toMatchObject({ kind: "exited", code: 0 });
  await f.returned();
}), 60_000);

test("real surviving shared member makes package handoff return NOTSUP with the source filesystem usable", async () => usingShared(true, async f => {
  const peer = await f.shell.spawn("/caller", ["caller", "peer"]);
  await Promise.race([f.peerReady.promise, peer.exit.then(exit => { throw new Error(`Peer finished before ready: ${JSON.stringify(exit)}`); })]);
  expect(f.service.memoryGroups()[0]?.members).toBe(2);
  f.cleanup.sourceWorkers[0]!.postMessage({ kind: "release" });
  expect(await f.caller.exit).toMatchObject({ kind: "exited", code: 42 });
  expect(f.targets).toHaveLength(0);
  expect(f.service.memoryGroupOf(peer.pid)?.id).toBe(f.groupId);
  f.cleanup.sourceWorkers[1]!.postMessage({ kind: "release" });
  expect(await peer.exit).toMatchObject({ kind: "exited", code: 0 });
  await f.returned();
  expect(f.service.memoryGroups()).toEqual([]);
}), 60_000);
