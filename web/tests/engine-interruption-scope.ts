import { DescriptorTable } from "waffle/core/descriptors";
import type { FilesystemIdentity } from "waffle/fs";
import { readOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState } from "waffle/proc/worker-client";
import { createRuntimeTerminalCodec } from "../src/runtime-terminals";
import { SubprocessBroker } from "../src/subprocess-broker";
import type { Runtime } from "waffle";
import type { Engine } from "../src/bun-executor";

export type EngineInterruptionRoute = "legacy" | "runtimeProcess";
export type EngineSignalDelivery = "host" | "page-kill" | "page-killJob";
export interface EngineInterruptionChild {
  pid: number;
  jobId: number;
  requestedSignal: Int32Array;
  signalState: Int32Array;
  stdout: string;
  stderr: string;
}

export interface EngineInterruptionScope {
  broker: SubprocessBroker;
  children: ReadonlyMap<number, EngineInterruptionChild>;
  spawn(source: string): EngineInterruptionChild;
  drain(child: EngineInterruptionChild): void;
  wait(child: EngineInterruptionChild): number;
  kill(child: EngineInterruptionChild, signal: 2 | 15, delivery?: EngineSignalDelivery): Promise<number>;
  dispose(): void;
}

/** Original test adapter. Admission, descriptor tokens and launchRuntime are the
 * production path; no RunRequest is manufactured. Preview1 here is only our byte-encoded
 * signal-clock fixture, which handles and dequeues signals through poll_oneoff, not an
 * untrusted guest upload. */
export async function createRuntimeEngineScope(module: WebAssembly.Module, engine: Engine, runtime: Runtime,
  workerUrl = new URL("./engine-interruption-worker.js", location.href).href, adapter: "bun" | "preview1" = "bun") {
  const filesystem = runtime.filesystem;
  const descriptors = new DescriptorTable();
  const identities: FilesystemIdentity[] = [];
  const children = new Map<number, EngineInterruptionChild>();
  const outcomes = new Map<number, BigInt64Array>();
  let broker: SubprocessBroker | undefined;
  let active: EngineInterruptionChild | undefined;
  let failure: unknown;
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    try { broker?.dispose(); }
    finally {
      try { descriptors.dispose(); }
      finally { for (const identity of identities) filesystem.revoke(identity); }
    }
  }
  try {
    const root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    const identity = filesystem.createIdentity(); identities.push(identity);
    root.data = { filesystem: identity };
    const decoder = new TextDecoder();
    broker = new SubprocessBroker(workerUrl, runtime, {
      output(fd, bytes) {
        if (!active) throw new Error("generic output has no test-owned child");
        if (fd === 2) active.stderr += decoder.decode(bytes); else active.stdout += decoder.decode(bytes);
      },
    });
    runtime.registerProgram("bun", { module, adapter: adapter === "preview1" ? "preview1" : `bun:${engine}`, cooperative: true });
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
    await broker.adoptRuntimeRoot(root);
    const pageBroker = broker;
    const client = new WorkerProcessClient({ transport: root, descriptors, codec,
      prepareSpawn() {
        const filesystemIdentity = filesystem.createIdentity(); identities.push(filesystemIdentity);
        return { data: { filesystem: filesystemIdentity,
          pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } };
      },
      postMessage(message) {
        if (message.operation !== "spawn") throw new Error("unexpected generic test controller operation");
        const state = workerProcessState(message.transport);
        active = { pid: state.pid, jobId: state.job, requestedSignal: state.signals.requestedSignal,
          signalState: state.signals.signalState, stdout: "", stderr: "" };
        children.set(active.pid, active); outcomes.set(active.pid, state.signals.outcome);
        void pageBroker.runtimeMessage(message, client.pid).catch(error => { failure = error; });
      },
    });
    return {
      broker: pageBroker, children,
      spawn(source: string) {
        if (children.size) throw new Error("one generic guest per interruption scope");
        const pid = client.spawn(client.pid, { executable: "bun", argv: ["bun", "-e", source], cwd: "/home/user", env: {}, job: -1,
          fds: [0, 1, 2].map(fd => ({ parent: fd, child: fd })) });
        const child = children.get(pid);
        if (!child) throw new Error("generic admission did not publish child state");
        return child;
      },
      drain(_child: EngineInterruptionChild) { if (failure) throw failure; },
      wait(child: EngineInterruptionChild) { return readOutcome(outcomes.get(child.pid)!)?.status ?? -2; },
      async kill(child: EngineInterruptionChild, signal: 2 | 15, delivery: EngineSignalDelivery = "page-kill") {
        if (delivery === "page-killJob") await pageBroker.killJob(child.jobId, signal);
        else await pageBroker.kill(child.pid, signal);
        return 0;
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
