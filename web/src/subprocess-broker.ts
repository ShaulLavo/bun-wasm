// Bun's composition over the page runtime's process service. The service owns admission,
// supervision, descriptors, signals and worker lifetimes; this adds Bun's engine programs, the
// run that roots a process tree. Executable resolution belongs to the guest and its PATH.
import type { ProcessExit } from "waffle/proc";
import { checkedSignal } from "waffle/proc/types";
import type { SignalTransport } from "waffle/proc/signals";
import type { Runtime, ProcessService, RuntimeSupervisor } from "waffle";
import type { WorkerProcessMessage, WorkerProcessTransport } from "waffle/proc/worker-client";
import type { FilesystemIdentity } from "waffle/fs";
import { bunLauncher, preview1Launcher } from "./bun-launcher.js";
import type { Engine } from "./bun-executor.js";

type CompiledExecutable = WebAssembly.Module | (() => Promise<WebAssembly.Module>);
export type ExecutableRegistration =
  | { module: CompiledExecutable; adapter: "bun"; engine?: Engine }
  | { module: CompiledExecutable; adapter: "preview1"; cooperative: true }
  | { bytes: Uint8Array | (() => Uint8Array | Promise<Uint8Array>); adapter: "preview1"; cooperative?: false };

export interface SubprocessBrokerOptions {
  output?(fd: 1 | 2, data: Uint8Array): void;
  rootFilesystem?: FilesystemIdentity;
  rootAcknowledged?(): boolean;
  stopRoot?(): void | Promise<void>;
}

/** One run's view of the page's process service: its root process and the names it spawns. */
export class SubprocessBroker {
  private disposed = false;
  private service?: ProcessService;
  private root?: SignalTransport & { pid: number; job: number };
  constructor(workerUrl: string, private runtime: Runtime, private options: SubprocessBrokerOptions = {}) {
    installBunAdapters(runtime, workerUrl);
  }

  register(name: string, entry: ExecutableRegistration): void {
    if (entry.adapter === "preview1" && !("bytes" in entry) && entry.cooperative !== true) throw new TypeError("Third-party preview1 programs require source bytes or an explicit cooperative assertion");
    const adapter = entry.adapter === "bun" ? `bun:${entry.engine ?? "browser"}` : "preview1";
    if (!name.startsWith("/")) throw new TypeError("Executable registration needs an absolute path");
    const previous = programFiles.get(this.runtime) ?? Promise.resolve();
    const created = previous.then(async () => {
      const existing = await this.runtime.filesystem.lookup(name);
      if (existing) {
        if (existing.kind !== "file") throw new TypeError(`Executable path is a directory: ${name}`);
        return;
      }
      await this.runtime.filesystem.mkdirp(name.slice(0, name.lastIndexOf("/")) || "/");
      await this.runtime.filesystem.writeFile(name, new Uint8Array());
    });
    programFiles.set(this.runtime, created);
    // Registration is synchronous; preparation reports file creation errors to the run.
    void created.catch(() => {});
    this.runtime.registerProgram(name, "bytes" in entry ? { adapter, source: entry.bytes }
      : { adapter, module: entry.module, cooperative: true });
  }
  private async processService(): Promise<ProcessService> {
    await programFiles.get(this.runtime);
    return this.service ??= await this.runtime.processes();
  }
  ready(): Promise<RuntimeSupervisor> { return this.processService().then(service => service.ready()); }
  /** Resolves when `pid` has confirmed its exit, as its parent would observe it. */
  async wait(pid: number): Promise<ProcessExit> {
    const supervisor = await this.ready();
    return supervisor.waitForExit(supervisor.get(pid)?.parentPid ?? this.root?.pid ?? 1, pid);
  }

  /** Roots this run's process tree at a worker the page started with `transport`. */
  async adoptRuntimeRoot(transport: WorkerProcessTransport): Promise<void> {
    if (this.disposed) throw new Error("Process broker is disposed");
    const { workerProcessState } = await import("waffle/proc/worker-client");
    const state = workerProcessState(transport);
    this.root = { pid: state.pid, job: state.job, ...state.signals };
    const service = await this.processService();
    if (this.disposed) throw new Error("Process broker is disposed");
    await service.adoptRuntimeRoot(transport, {
      filesystem: this.options.rootFilesystem, acknowledged: this.options.rootAcknowledged,
      output: this.options.output, stop: this.options.stopRoot,
    });
  }
  async runtimeMessage(message: WorkerProcessMessage, senderPid: number): Promise<void> {
    return (await this.processService()).runtimeMessage(message, senderPid);
  }
  rejectRuntimeMessage(message: WorkerProcessMessage, senderPid = this.root?.pid): void {
    void this.processService().then(service => service.rejectRuntimeMessage(message, senderPid)).catch(error => this.report(error));
  }
  revokeRuntimeProcess(pid: number): void { this.service?.revokeRuntimeProcess(pid); }

  /**
   * Signals one process or a whole job. Once the service is active the call enters it
   * synchronously, so every member's outcome is published before any teardown callback runs.
   */
  kill(pid: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal);
    return this.service ? this.service.kill(pid, sig) : this.processService().then(service => service.kill(pid, sig));
  }
  killJob(job: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal);
    return this.service ? this.service.killJob(job, sig) : this.processService().then(service => service.killJob(job, sig));
  }
  /** A run exits only its root; it never owns shared service teardown. */
  rootExit(code: number): void | Promise<void> {
    if (!this.root) return;
    const pid = this.root.pid;
    this.revokeRuntimeProcess(pid);
    return this.service?.rootExit(pid, code);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
  private report(error: unknown): void { console.error("bun-wasm: process controller failed", error); }
}

const programFiles = new WeakMap<Runtime, Promise<void>>();
const installedAdapters = new WeakSet<Runtime>();
/** Immutable engine-qualified registrations; concurrent runs never replace a global engine alias. */
export function installBunAdapters(runtime: Runtime, workerUrl: string): void {
  if (installedAdapters.has(runtime)) return;
  installedAdapters.add(runtime);
  runtime.registerAdapter("preview1", preview1Launcher({ workerUrl }));
  for (const engine of ["quickjs", "jsc", "browser"] as const) runtime.registerAdapter(`bun:${engine}`, bunLauncher(engine, { workerUrl }));
}
