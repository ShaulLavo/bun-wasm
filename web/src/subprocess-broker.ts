// Bun's composition over the page runtime's process service. The service owns admission,
// supervision, descriptors, signals and worker lifetimes; this adds Bun's engine programs, the
// run that roots a process tree, and the executable aliases (`bun`, `node`) a spawn resolves to.
import type { ProcessContext, ProcessExit } from "waffle/proc";
import { checkedSignal } from "waffle/proc/types";
import type { SignalTransport } from "waffle/proc/signals";
import type { Runtime, ProcessService, RuntimeSupervisor } from "waffle";
import type { WorkerProcessMessage, WorkerProcessTransport } from "waffle/proc/worker-client";
import type { FilesystemIdentity } from "waffle/fs";
import { bunLauncher, preview1Launcher } from "./bun-launcher";
import type { Engine } from "./bun-executor";

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
  /** The run's engine: spawns of `bun` and `node` resolve to this engine's program. */
  engine?: Engine;
  aliasExecutable?: string;
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
    this.runtime.registerProgram(name, "bytes" in entry ? { adapter, source: entry.bytes }
      : { adapter, module: entry.module, cooperative: true });
  }
  qualifyExecutable(name: string): string {
    return this.options.engine && ["bun", "/bun", "node", "/node", "/usr/local/bin/bun", "/usr/local/bin/node"].includes(name)
      ? this.options.aliasExecutable ?? `bun-${this.options.engine}` : name;
  }
  private async processService(): Promise<ProcessService> { return this.service ??= await this.runtime.processes(); }
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
    if (this.root) controllersFor(this.runtime).delete(this.root.pid);
    this.root = { pid: state.pid, job: state.job, ...state.signals };
    controllersFor(this.runtime).set(state.pid, this);
    const service = await this.processService();
    if (this.disposed) throw new Error("Process broker is disposed");
    await service.adoptRuntimeRoot(transport, {
      filesystem: this.options.rootFilesystem, acknowledged: this.options.rootAcknowledged,
      output: this.options.output, stop: this.options.stopRoot,
      retired: () => controllersFor(this.runtime).delete(state.pid),
    });
  }
  async runtimeMessage(message: WorkerProcessMessage, senderPid: number): Promise<void> {
    if (message.operation === "spawn") message = { ...message, request: { ...message.request, executable: this.qualifyExecutable(message.request.executable) } };
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
    if (this.root) controllersFor(this.runtime).delete(this.root.pid);
  }
  private report(error: unknown): void { console.error("bun-wasm: process controller failed", error); }
}

const installedAdapters = new WeakSet<Runtime>();
const runtimeControllers = new WeakMap<Runtime, Map<number, SubprocessBroker>>();
function controllersFor(runtime: Runtime): Map<number, SubprocessBroker> {
  let controllers = runtimeControllers.get(runtime);
  if (!controllers) runtimeControllers.set(runtime, controllers = new Map());
  return controllers;
}
/** Immutable engine-qualified registrations; concurrent runs never replace a global engine alias. */
export function installBunAdapters(runtime: Runtime, workerUrl: string): void {
  if (installedAdapters.has(runtime)) return;
  installedAdapters.add(runtime);
  // Alias selection belongs to the run that rooted this process tree.
  const executableName = async (context: ProcessContext, service: ProcessService) => {
    const supervisor = await service.ready();
    let parent = context.parentPid;
    let controller: SubprocessBroker | undefined;
    while (parent && !controller) { controller = controllersFor(runtime).get(parent); parent = supervisor.table.parentOf(parent) ?? 0; }
    return controller && ((name: string) => controller.qualifyExecutable(name));
  };
  runtime.registerAdapter("preview1", preview1Launcher({ workerUrl, executableName }));
  for (const engine of ["quickjs", "jsc", "browser"] as const) runtime.registerAdapter(`bun:${engine}`, bunLauncher(engine, { workerUrl, executableName }));
}
