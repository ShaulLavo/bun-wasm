// Runnable page-side adapter. The generic process service is loaded only on first spawn;
// blocked guest workers never have to activate a MessageChannel or a nested Worker.
import type { ProcessContext, ProcessExit, ProcessSupervisor, Signal } from "../../runtime/proc";
import { isRevoked } from "../../runtime/fs/protocol";
import type { SharedFilesystem } from "./shared-fs";
import { childTransport, type ChildTransport } from "./subprocess.ts";
import type { Engine, RunRequest, SpawnRequest, WorkerMessage } from "./worker";

type Proc = typeof import("../../runtime/proc");
export interface ExecutableRegistration {
  module: WebAssembly.Module | (() => Promise<WebAssembly.Module>);
  adapter: "bun" | "preview1";
  engine?: Engine;
}
interface Child {
  spawn: SpawnRequest;
  context?: ProcessContext;
  worker?: Worker;
  request?: RunRequest;
  signal: number;
  acknowledged: boolean;
}

export class SubprocessBroker {
  private disposed = false;
  private children = new Map<number, Child>();
  private registrations = new Map<string, ExecutableRegistration>();
  private activation?: Promise<ProcessSupervisor>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private workerUrl: string, private filesystem: SharedFilesystem,
    private options: { activate?: () => Promise<Proc>; rootPid?: number; rootJob?: number } = {}) {}

  register(name: string, entry: ExecutableRegistration): void {
    if (this.activation) throw new Error("Register executables before the first spawn");
    this.registrations.set(name, entry);
  }

  ready(): Promise<ProcessSupervisor> {
    return this.activation ??= (this.options.activate?.() ?? import("../../runtime/proc")).then(proc => {
      const registry = new proc.ExecutableRegistry();
      for (const [name, entry] of this.registrations) registry.register(name, {
        module: entry.module, adapter: entry.adapter === "preview1" ? "preview1" : `bun:${entry.engine ?? "browser"}`,
      });
      const supervisor = new proc.ProcessSupervisor({ registry, launch: context => this.launch(context) });
      supervisor.createRoot({ pid: this.options.rootPid ?? 1, job: this.options.rootJob ?? 1 });
      supervisor.onChildExit(event => {
        const child = this.children.get(event.pid);
        if (!child) return;
        const result = supervisor.wait(child.spawn.parentPid, event.pid);
        if (result) childTransport(child.spawn.child).finish(result.status);
        if (!child.acknowledged) this.filesystem.revoke(child.spawn.filesystem);
        if (!child.worker) this.children.delete(event.pid);
      });
      return supervisor;
    });
  }

  spawn(spawn: SpawnRequest): void {
    if (this.disposed) { this.cancel(spawn); return; }
    const child: Child = { spawn, signal: 0, acknowledged: false };
    this.children.set(spawn.pid, child);
    // No import, compile, worker startup or wait is on the synchronous spawn path.
    void this.ready().then(supervisor => {
      if (this.disposed) return;
      supervisor.reserveSpawn(spawn.parentPid, {
        executable: spawn.executable, argv: spawn.argv, env: spawn.env, cwd: spawn.cwd,
        job: spawn.job ?? spawn.jobId, fds: [],
      }, { pid: spawn.pid, job: spawn.jobId, interrupt: spawn.child.interrupt, requestedSignal: spawn.child.requestedSignal });
      const signal = Atomics.load(new Int32Array(spawn.child.requestedSignal), 0);
      if (signal) { child.signal = signal; supervisor.kill(spawn.pid, signal as Signal); }
      return supervisor.start(spawn.pid);
    }).catch(error => {
      childTransport(spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: process start failed: ${String(error)}\n`));
      childTransport(spawn.child).finish(126);
      this.filesystem.revoke(spawn.filesystem);
    });
    this.watch();
  }

  private launch(context: ProcessContext) {
    const child = this.children.get(context.pid);
    if (!child || this.disposed) throw new Error("Process no longer has a live controller");
    const spawn = child.spawn;
    child.context = context;
    const preview1 = context.adapter === "preview1";
    const engine = preview1 ? "browser" : context.adapter.slice(4) as Engine;
    const request: RunRequest = {
      module: context.module, engine, adapter: preview1 ? "preview1" : "bun",
      args: spawn.argv, env: { ...spawn.env, PWD: spawn.cwd },
      filesystem: this.filesystem.connect(spawn.filesystem), child: spawn.child,
      pid: spawn.pid, jobId: spawn.jobId, identity: spawn.child.identity, interrupt: spawn.child.interrupt,
      trace: spawn.trace, slots: spawn.slots, spawnBroker: true, net: null, moduleCache: null,
    };
    if (!preview1 && engine === "browser" && new URL(this.workerUrl).pathname.endsWith("/__bunwasm/worker.js")) request.moduleCache = `bunwasm-m-${crypto.randomUUID()}`;
    child.request = request;
    let worker: Worker;
    try { worker = new Worker(this.workerUrl, { type: "module" }); }
    catch (error) { request.filesystem.port.close(); throw error; }
    child.worker = worker;
    context.registerRevocation(() => {
      this.filesystem.revoke(spawn.filesystem);
      const transport = childTransport(spawn.child);
      if (!spawn.child.inheritedStdin) transport.stdin.close();
      transport.stdout.close(); transport.stderr.close();
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.type === "spawn") {
        if (isRevoked(spawn.filesystem) || data.request.parentPid !== context.pid) this.cancel(data.request);
        else this.spawn(data.request);
        return;
      }
      if (data.type !== "exit" && data.type !== "error") return;
      // A quiescent ACK can release filesystem lock owners even after SIGKILL. It can never
      // replace the supervisor's already recorded signaled outcome.
      child.acknowledged = true;
      this.filesystem.reap(spawn.filesystem);
      if (data.type === "exit" && data.signal) context.defaultSignal(data.signal as Signal);
      else if (data.type === "exit") context.exit(data.code);
      else context.fail(new Error(data.message));
      worker.terminate();
      this.cleanupCache(child);
      this.children.delete(context.pid);
    };
    worker.onerror = event => {
      event.preventDefault();
      childTransport(spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: child worker failed: ${event.message}\n`));
      context.fail(new Error(event.message));
      worker.terminate();
      this.cleanupCache(child);
      // Browser error events do not prove a worker has stopped touching shared memory.
      this.filesystem.revoke(spawn.filesystem);
      this.children.delete(context.pid);
    };
    try { worker.postMessage(request, [request.filesystem.port]); }
    catch (error) {
      request.filesystem.port.close();
      worker.terminate();
      this.cleanupCache(child);
      this.children.delete(context.pid);
      throw error;
    }
    return { terminate: () => {
      worker.terminate();
      this.cleanupCache(child);
      this.children.delete(context.pid);
    } };
  }

  async wait(pid: number): Promise<ProcessExit> {
    const child = this.children.get(pid);
    const supervisor = await this.ready();
    return supervisor.waitForExit(child?.spawn.parentPid ?? supervisor.get(pid)?.parentPid ?? this.options.rootPid ?? 1, pid);
  }
  async kill(pid: number, signal: number): Promise<void> { (await this.ready()).kill(pid, signal as Signal); }
  async killJob(job: number, signal: number): Promise<void> {
    if (this.activation) (await this.activation).killJob(job, signal as Signal);
  }
  /** Parent exit is not job teardown: independently running/background children stay alive. */
  rootExit(code: number): void {
    if (this.activation) void this.activation.then(supervisor => supervisor.exit(this.options.rootPid ?? 1, code)).catch(() => {});
  }

  private cleanupCache(child: Child): void { if (child.request?.moduleCache) void caches.delete(child.request.moduleCache); }
  private cancel(spawn: SpawnRequest): void {
    Atomics.store(new Int32Array(spawn.child.requestedSignal), 0, 9);
    Atomics.store(new Int32Array(spawn.child.interrupt), 0, 9);
    this.filesystem.revoke(spawn.filesystem);
    childTransport(spawn.child).finish(137);
  }
  private watch(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ready().then(supervisor => {
        for (const [pid, child] of this.children) {
          const signal = Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0);
          if (!signal || signal === child.signal) continue;
          child.signal = signal;
          supervisor.kill(pid, signal as Signal);
        }
      }).catch(() => {});
      if (this.children.size) this.watch();
    }, 4);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const child of this.children.values()) {
      this.cancel(child.spawn);
      child.worker?.terminate();
      this.cleanupCache(child);
    }
    this.children.clear();
    if (this.activation) void this.activation.then(supervisor => supervisor.dispose()).catch(() => {});
  }
}
