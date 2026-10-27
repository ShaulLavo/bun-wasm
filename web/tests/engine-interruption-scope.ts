import type { ControlCells } from "waffle/proc/control";
import { DescriptorTable } from "waffle/core/descriptors";
import { FilesystemClient, createProcessFilesystemIdentity, type FilesystemIdentity } from "waffle/fs";
import { ProcessABI } from "waffle/proc/abi";
import { readOutcome, type OutcomeWord } from "waffle/proc/outcome";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState } from "waffle/proc/worker-client";
import { attachPipePublicationRegistry, type PipePublicationRegistryHandle } from "waffle/proc/pipes";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { bunLauncher, preview1Launcher } from "../src/bun-launcher";
import type { ProcessExit } from "waffle/proc";
import type { Runtime, ProcessService } from "waffle";
import type { Engine } from "../src/bun-executor";

// The case families retain their names/counters; both now use the generic transport.
export type EngineInterruptionRoute = "legacy" | "runtimeProcess";
export type EngineSignal = 2 | 10 | 15;
export type EngineSignalDelivery = "host" | "page-kill" | "page-killJob";
export interface EngineInterruptionChild {
  pid: number;
  jobId: number;
  requestedSignal: ControlCells;
  signalState: ControlCells;
  stdout: string;
  stderr: string;
}

export interface EngineInterruptionScope {
  service: ProcessService;
  children: ReadonlyMap<number, EngineInterruptionChild>;
  spawn(source: string): EngineInterruptionChild;
  drain(child: EngineInterruptionChild): void;
  wait(child: EngineInterruptionChild): number;
  outcome(child: EngineInterruptionChild): Promise<ProcessExit>;
  kill(child: EngineInterruptionChild, signal: EngineSignal, delivery?: EngineSignalDelivery): Promise<number>;
  dispose(): Promise<void>;
}

/** Original controller fixture over real generic admission and launchWorker. Only its root
 * controller is page-local: the child always executes in the production Bun/preview1 worker.
 * Preview1 is our cooperative byte-encoded signal-clock guest, not an untrusted upload. */
export async function createRuntimeEngineScope(module: WebAssembly.Module, engine: Engine, runtime: Runtime,
  workerUrl = new URL("./engine-interruption-worker.js", location.href).href, adapter: "bun" | "preview1" = "bun") {
  const filesystem = runtime.filesystem;
  const descriptors = new DescriptorTable();
  const identities: FilesystemIdentity[] = [];
  const children = new Map<number, EngineInterruptionChild>();
  const outcomes = new Map<number, OutcomeWord>();
  let service: ProcessService | undefined;
  let rootPid: number | undefined;
  let fs: FilesystemClient | undefined;
  let active: EngineInterruptionChild | undefined;
  let failure: unknown;
  let disposal: Promise<void> | undefined;
  function dispose(): Promise<void> {
    return disposal ??= (async () => {
      const errors: unknown[] = [];
      try { if (rootPid !== undefined) await service?.rootExit(rootPid, 0); } catch (error) { errors.push(error); }
      try { descriptors.dispose(); } catch (error) { errors.push(error); }
      try { fs?.dispose(); } catch (error) { errors.push(error); }
      for (const identity of identities) try { filesystem.revoke(identity); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "engine controller cleanup failed");
    })();
  }
  try {
    const root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    rootPid = workerProcessState(root).pid;
    const identity = filesystem.createIdentity(); identities.push(identity);
    root.data = { filesystem: identity };
    const decoder = new TextDecoder();
    runtime.registerAdapter(adapter === "preview1" ? "preview1" : `bun:${engine}`,
      adapter === "preview1" ? preview1Launcher({ workerUrl }) : bunLauncher(engine, { runtime, workerUrl }));
    const executable = "/usr/libexec/engine-probe";
    await filesystem.mkdirp("/usr/libexec");
    await filesystem.writeFile(executable, new Uint8Array([1]));
    runtime.registerProgram(executable, { module, adapter: adapter === "preview1" ? "preview1" : `bun:${engine}`, cooperative: true });
    for (const fd of [0, 1, 2]) {
      const installed = descriptors.open({ kind: "terminal", read: () => 0,
        write: chunks => chunks.reduce((size, bytes) => size + bytes.length, 0),
        readiness: () => ({ readable: true, writable: true, hangup: fd === 0 }) }, (1n << 29n) - 1n, 0n);
      if (installed !== fd) throw new Error("generic test stdio descriptor mismatch");
    }
    const codec = createRuntimeTerminalCodec({ descriptors, fallback: {
      export() { throw new Error("unexpected non-terminal test descriptor"); },
      import() { throw new Error("unexpected non-terminal test token"); },
      discard() { throw new Error("unexpected non-terminal test token"); },
    } });
    service = await runtime.processes();
    await service.adoptRuntimeRoot(root, { output(fd, bytes) {
      if (!active) throw new Error("generic output has no test-owned child");
      if (fd === 2) active.stderr += decoder.decode(bytes); else active.stdout += decoder.decode(bytes);
    } });
    const pageService = service;
    const pipeRegistry = attachPipePublicationRegistry(
      (root.data as { pipeRegistry: PipePublicationRegistryHandle }).pipeRegistry,
    );
    const client = new WorkerProcessClient({ transport: root, descriptors, codec,
      prepareSpawn(pid) {
        const filesystemIdentity = createProcessFilesystemIdentity(identity); identities.push(filesystemIdentity);
        pipeRegistry.registerProcess(pid);
        return { cancel: pipeRegistry.collectProcess.bind(pipeRegistry, pid),
          data: { filesystem: filesystemIdentity, pipeRegistry: pipeRegistry.handle() } };
      },
      postMessage(message) {
        if (message.operation === "spawn") {
          const state = workerProcessState(message.transport);
          active = { pid: state.pid, jobId: state.job, requestedSignal: state.signals.requestedSignal,
            signalState: state.signals.signalState, stdout: "", stderr: "" };
          children.set(active.pid, active); outcomes.set(active.pid, state.signals.outcome);
        }
        void pageService.runtimeMessage(message, client.pid).catch(error => { failure = error; });
      },
    });
    fs = new FilesystemClient(filesystem.connect(identity));
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({ memory, descriptors, fs, pid: client.pid, service: client, signals: client.signals, wake: client.wake });
    return {
      service: pageService, children,
      spawn(source: string) {
        if (children.size) throw new Error("one generic guest per interruption scope");
        const request = new TextEncoder().encode(JSON.stringify({ executable, argv: ["bun", "-e", source], cwd: "/home/user", env: {}, job: -1,
          fds: [0, 1, 2].map(fd => ({ parent: fd, child: fd })) }));
        new Uint8Array(memory.buffer, 64, request.length).set(request);
        const pid = abi.imports.spawn!(64, request.length);
        const child = children.get(pid);
        if (!child) throw new Error(`generic admission did not publish child state (${pid})`);
        return child;
      },
      drain(_child: EngineInterruptionChild) { if (failure) throw failure; },
      wait(child: EngineInterruptionChild) { return readOutcome(outcomes.get(child.pid)!)?.status ?? -2; },
      async outcome(child: EngineInterruptionChild) { return (await pageService.ready()).waitForExit(client.pid, child.pid); },
      async kill(child: EngineInterruptionChild, signal: EngineSignal, delivery: EngineSignalDelivery = "host") {
        if (delivery === "host") return abi.imports.kill!(child.pid, signal);
        if (delivery === "page-killJob") await pageService.killJob(child.jobId, signal);
        else await pageService.kill(child.pid, signal);
        return 0;
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
