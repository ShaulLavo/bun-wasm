import { isToolCommand } from "../src/tool-command.ts";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { WorkerProcessBroker } from "waffle/proc/worker-broker";
import { createWorkerProcessTransport, workerProcessState, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { WorkerPipeBroker } from "waffle/proc/worker-pipes";
import type { ProcessContext } from "waffle/proc/types";
import { startStatus } from "waffle/proc/outcome";
import { PipeController, PipePublicationRegistry } from "waffle/proc/pipes";
import { nodeStdioCodec } from "./node-process.ts";
import { drainStartupDiagnostic } from "./node-startup-diagnostic.ts";
import { ProcessErrno, ProcessError } from "waffle/proc/types";

export const nodeExecutables = ["/bin/bun", "/bin/node"] as const;
export type NodeEngineModules = Partial<Record<"quickjs" | "jsc", WebAssembly.Module>>;

/** Resolve guest path components before normalization: file/.. must remain ENOTDIR.
 * Symlink targets live in the guest namespace, just as they do in preview1. */
function nodeExecutableLookup(preopens: Record<string, string>, absolute: string) {
  const mounts = Object.entries(preopens).sort(([a], [b]) => b.length - a.length);
  const lookup = (path: string) => {
    const mount = mounts.find(([guest]) => guest === "/" || path === guest || path.startsWith(`${guest}/`));
    const native = mount && `${mount[1]}/${path.slice(mount[0] === "/" ? 1 : mount[0].length + 1)}`;
    try { return native ? { native, stat: lstatSync(native) } : undefined; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && mounts.some(([guest]) => guest.startsWith(`${path === "/" ? "" : path}/`))) return undefined;
      throw error;
    }
  };
  let pending = absolute.split("/");
  const components: string[] = [];
  let kind: "file" | "dir" = "dir", links = 0;
  while (pending.length) {
    const component = pending.shift()!;
    if (!component) continue;
    if (kind !== "dir") throw Object.assign(new Error(`not a directory: /${components.join("/")}`), { errno: 54 });
    if (component === "..") components.pop(); else if (component !== ".") components.push(component);
    const path = `/${components.join("/")}`, node = lookup(path);
    if (!node) {
      if (mounts.some(([guest]) => guest.startsWith(`${path === "/" ? "" : path}/`))) { kind = "dir"; continue; }
      return undefined;
    }
    if (node.stat.isSymbolicLink()) {
      if (++links > 40) throw Object.assign(new Error("too many symbolic links"), { code: "ELOOP" });
      const target = readlinkSync(node.native);
      components.pop();
      if (target.startsWith("/")) components.length = 0;
      pending = target.split("/").concat(pending);
      kind = "dir";
    } else kind = node.stat.isDirectory() ? "dir" : "file";
  }
  if (absolute.endsWith("/") && kind !== "dir") throw Object.assign(new Error("not a directory"), { errno: 54 });
  return { path: `/${components.join("/")}`, kind };
}

export function createNodeExecutableRegistry(module: WebAssembly.Module, preopens: Record<string, string>, engines: NodeEngineModules = {}): ExecutableRegistry {
  const registry = new ExecutableRegistry(path => nodeExecutableLookup(preopens, path));
  for (const name of nodeExecutables) registry.register(name, { module, adapter: "bun" });
  for (const engine of ["quickjs", "jsc"] as const) {
    const module = engines[engine];
    if (module) for (const name of ["bun", "node"]) registry.register(`/opt/bun/${engine}/bin/${name}`, { module, adapter: "bun" });
  }
  return registry;
}

/** Private files, not aliases. Mount order is shared with the native host's preview1 ABI. */
function nodeExecutableFiles(preopens: Record<string, string>, engines: NodeEngineModules) {
  for (const guest of Object.keys(preopens)) if (guest === "/bin" || guest.startsWith("/bin/") || guest === "/opt/bun" || guest.startsWith("/opt/bun/")) {
    throw new Error(`reserved executable mount: ${guest}`);
  }
  const root = mkdtempSync(join(process.env.BUN_WASM_SCRATCH_ROOT ?? tmpdir(), "bun-wasm-node-executables-"));
  try {
    mkdirSync(join(root, "bin")); mkdirSync(join(root, "opt/bun"), { recursive: true });
    for (const name of ["bun", "node"]) writeFileSync(join(root, "bin", name), new Uint8Array());
    for (const engine of ["quickjs", "jsc"] as const) if (engines[engine]) {
      const bin = join(root, "opt/bun", engine, "bin"); mkdirSync(bin, { recursive: true });
      for (const name of ["bun", "node"]) writeFileSync(join(bin, name), new Uint8Array());
    }
    const mounted: Record<string, string> = { "/": preopens["/"] ?? root, "/bin": join(root, "bin"), "/opt/bun": join(root, "opt/bun") };
    for (const [guest, host] of Object.entries(preopens)) if (guest !== "/") mounted[guest] = host;
    return { preopens: mounted, dispose() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
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
  readonly registry: ExecutableRegistry;
  readonly broker: WorkerProcessBroker;
  readonly preopens: Record<string, string>;
  private readonly files: ReturnType<typeof nodeExecutableFiles>;
  private disposal?: Promise<void>;
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
    engines?: NodeEngineModules;
    preopens?: Record<string, string>;
    launch(context: ProcessContext, transport: WorkerProcessTransport): Worker;
    onError?(error: unknown): void;
  }) {
    this.files = nodeExecutableFiles(options.preopens ?? {}, options.engines ?? {});
    this.preopens = this.files.preopens;
    const registry = this.registry = createNodeExecutableRegistry(options.module, this.preopens, options.engines);
    this.supervisor = new ProcessSupervisor({
      registry,
      launch: context => {
        const transport = this.broker.get(context.pid);
        if (!transport) throw new Error(`missing process transport ${context.pid}`);
        const worker = options.launch(context, transport);
        this.attach(worker, transport);
        return { terminate: () => worker.terminate().then(() => {}) };
      },
      startFailed: (pid, error, active) => {
        const resource = this.supervisor.get(pid)?.descriptors.get(2)?.resource;
        const bytes = new TextEncoder().encode(`bun-wasm: ${error instanceof Error ? error.message : error}\n`);
        if (resource?.kind === "pipe" || resource?.kind === "terminal") {
          const write = resource.tryWrite;
          if (!write) throw new ProcessError(ProcessErrno.NOTSUP, "startup diagnostic requires immediate stderr writes");
          return drainStartupDiagnostic(bytes, bytes => write.call(resource, [bytes]), active);
        }
        if (pid === 1) return drainStartupDiagnostic(bytes, bytes => {
          try { return writeSync(2, bytes); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EAGAIN" || (error as NodeJS.ErrnoException).code === "EWOULDBLOCK") return -ProcessErrno.AGAIN;
            throw error;
          }
        }, active);
      },
      onError: options.onError,
    });
    const state = workerProcessState(this.root);
    const publications = new PipePublicationRegistry({ wake: state.wake });
    publications.registerProcess(state.pid);
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
      if (message?.type === "runtime-proc") void this.broker.handle(message, pid);
    });
    worker.on("error", error => {
      const record = this.supervisor.get(pid);
      if (record && startStatus(record.outcome) !== 0) {
        // The supervisor's startup diagnostic sink runs only after terminal selection wins.
        this.supervisor.failStart(pid, error);
        return;
      }
      const bytes = new TextEncoder().encode(`node-host: ${error instanceof Error ? error.stack : error}\n`);
      const stderr = record?.descriptors.get(2)?.resource;
      if (stderr?.kind === "pipe" || stderr?.kind === "terminal") stderr.write([bytes]);
      else if (pid === 1) writeSync(2, bytes);
      this.supervisor.exit(pid, 126);
    });
    worker.on("exit", code => {
      this.workers.delete(pid);
      this.supervisor.exit(pid, code);
      this.broker.pump(); this.pipes.pump();
    });
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    clearInterval(this.timer);
    this.inputSource?.off("data", this.onInput);
    this.inputSource?.off("end", this.onInputEnd);
    this.inputSource?.off("error", this.onInputEnd);
    this.inputSource?.pause();
    this.inputQueue.length = 0;
    this.broker.dispose(); this.supervisor.dispose(); this.pipes.dispose(); this.input.dispose();
    const stops = Array.from(this.workers.values(), worker => worker.terminate());
    this.workers.clear();
    this.disposal = Promise.allSettled(stops).then(() => this.files.dispose());
    return this.disposal;
  }
}

export async function nodeModule(options: { args: readonly string[]; baseModule: WebAssembly.Module; wasmPath: string }): Promise<WebAssembly.Module> {
  if (!isToolCommand(options.args)) return options.baseModule;
  return WebAssembly.compile(readFileSync(join(dirname(options.wasmPath), "bun-tools.wasm")));
}
