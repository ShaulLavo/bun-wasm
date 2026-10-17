import { isToolCommand } from "../src/tool-command.ts";
import { readFileSync, statSync, writeSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { WorkerProcessBroker } from "waffle/proc/worker-broker";
import { createWorkerProcessTransport, workerProcessState, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { WorkerPipeBroker } from "waffle/proc/worker-pipes";
import type { ProcessContext } from "waffle/proc/types";
import { PipeController, PipePublicationRegistry } from "waffle/proc/pipes";
import { nodeStdioCodec } from "./node-process.ts";

export const nodeExecutables = ["bun", "/bun", "/usr/local/bin/bun", "node", "/node", "/usr/local/bin/node"] as const;

export function createNodeExecutableRegistry(module: WebAssembly.Module): ExecutableRegistry {
  const registry = new ExecutableRegistry();
  for (const name of nodeExecutables) registry.register(name, { module, adapter: "bun" });
  return registry;
}

export function validateNodeCwd(preopens: Record<string, string>, cwd: string): void {
  const path = posix.resolve("/", cwd || "/");
  const mounts = Object.entries(preopens).sort(([a], [b]) => b.length - a.length);
  const mount = mounts.find(([guest]) => guest === "/" || path === guest || path.startsWith(`${guest}/`));
  if (!mount) throw new Error(`spawn: cwd does not exist: ${path}`);
  const [guest, host] = mount;
  const directory = resolve(host, `.${path.slice(guest === "/" ? 0 : guest.length)}`);
  if (!statSync(directory).isDirectory()) throw new Error(`spawn: cwd is not a directory: ${path}`);
}

/** Responsive main-thread controller. No WASM guest runs on this thread. */
export class NodeProcessBroker {
  readonly root = createWorkerProcessTransport();
  readonly supervisor: ProcessSupervisor;
  readonly broker: WorkerProcessBroker;
  private readonly pipes = new WorkerPipeBroker();
  private readonly workers = new Map<number, Worker>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly input: PipeController;
  private readonly inputWriter: ReturnType<PipeController["retain"]>;
  private readonly inputQueue: Uint8Array[] = [];
  private inputEnded = false;
  private inputSource?: NodeJS.ReadStream;
  constructor(options: {
    module: WebAssembly.Module;
    launch(context: ProcessContext, transport: WorkerProcessTransport): Worker;
    onError?(error: unknown): void;
  }) {
    const registry = createNodeExecutableRegistry(options.module);
    this.supervisor = new ProcessSupervisor({
      registry,
      launch: context => {
        const transport = this.broker.get(context.pid);
        if (!transport) throw new Error(`missing process transport ${context.pid}`);
        const worker = options.launch(context, transport);
        this.attach(worker, transport);
        return { terminate: () => worker.terminate().then(() => {}) };
      },
      startFailed: (pid, error) => {
        const resource = this.supervisor.get(pid)?.descriptors.get(2)?.resource;
        const bytes = new TextEncoder().encode(`bun-wasm: ${error instanceof Error ? error.message : error}\n`);
        if (resource?.kind === "pipe" || resource?.kind === "terminal") resource.write([bytes]);
      },
      onError: options.onError,
    });
    const state = workerProcessState(this.root);
    const publications = new PipePublicationRegistry({ wake: state.wake });
    this.root.data = { registry: publications.handle() };
    this.input = new PipeController({ registry: publications, wake: state.wake });
    const inputReader = this.input.retain(state.pid, "read");
    this.inputWriter = this.input.retain(state.pid, "write");
    this.root.resources.push({ kind: "pipe", endpoint: inputReader.handle() });
    this.root.bindings.push({ fd: 0, reference: 0, rightsBase: (1n << 1n) | (1n << 27n), rightsInheriting: 0n });
    this.supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
    this.broker = new WorkerProcessBroker({
      supervisor: () => Promise.resolve(this.supervisor), codec: this.pipes.codec(nodeStdioCodec),
      onPipe: handle => this.pipes.attach(handle as Parameters<WorkerPipeBroker["attach"]>[0]),
      pumpPipes: () => this.pipes.pump(), onError: options.onError,
    });
    this.broker.adoptRoot(this.root);
    this.timer = setInterval(() => { this.broker.pump(); this.pipes.pump(); this.pumpInput(); }, 1);
  }
  /** Native input stays on the responsive controller; guest runtime_proc reads never block it. */
  pipeStdin(source: NodeJS.ReadStream = process.stdin): void {
    this.inputSource = source;
    source.on("data", this.onInput);
    source.once("end", this.onInputEnd);
    source.once("error", this.onInputEnd);
    source.resume();
  }
  private readonly onInput = (bytes: Buffer) => {
    this.inputQueue.push(bytes);
    this.inputSource?.pause();
    this.pumpInput();
  };
  private readonly onInputEnd = () => { this.inputEnded = true; this.pumpInput(); };
  private pumpInput(): void {
    while (this.inputQueue.length) {
      const bytes = this.inputQueue[0]!;
      const written = this.inputWriter.tryWrite([bytes]);
      if (written === -6) return;
      if (written < 0) { this.inputQueue.length = 0; this.inputEnded = true; break; }
      if (written < bytes.length) { this.inputQueue[0] = bytes.subarray(written); return; }
      this.inputQueue.shift();
    }
    if (this.inputEnded) this.inputWriter.close();
    else this.inputSource?.resume();
  }
  attach(worker: Worker, transport: WorkerProcessTransport): void {
    const { pid } = workerProcessState(transport);
    this.workers.set(pid, worker);
    worker.on("message", (message: WorkerProcessMessage) => {
      if (message?.type === "runtime-proc") void this.broker.handle(message);
    });
    worker.on("error", error => {
      const bytes = new TextEncoder().encode(`node-host: ${error instanceof Error ? error.stack : error}\n`);
      const stderr = this.supervisor.get(pid)?.descriptors.get(2)?.resource;
      if (stderr?.kind === "pipe" || stderr?.kind === "terminal") stderr.write([bytes]);
      else writeSync(2, bytes);
      this.supervisor.exit(pid, 126);
    });
    worker.on("exit", code => {
      this.workers.delete(pid);
      this.supervisor.exit(pid, code);
      this.broker.pump(); this.pipes.pump();
    });
  }
  dispose(): void {
    clearInterval(this.timer);
    this.inputSource?.off("data", this.onInput);
    this.inputSource?.off("end", this.onInputEnd);
    this.inputSource?.off("error", this.onInputEnd);
    this.inputSource?.pause();
    this.inputQueue.length = 0;
    this.broker.dispose(); this.supervisor.dispose(); this.pipes.dispose(); this.input.dispose();
    for (const worker of this.workers.values()) void worker.terminate();
    this.workers.clear();
  }
}

export async function nodeModule(options: { args: readonly string[]; baseModule: WebAssembly.Module; wasmPath: string }): Promise<WebAssembly.Module> {
  if (!isToolCommand(options.args)) return options.baseModule;
  return WebAssembly.compile(readFileSync(join(dirname(options.wasmPath), "bun-tools.wasm")));
}
