import { installBunAdapters, loadBunWasm, ENGINE_BIN } from "bun-wasm";
import { createRuntime, type Runtime, type ProcessService } from "waffle";
import { DescriptorTable } from "waffle/core/descriptors";
import { createProcessFilesystemIdentity } from "waffle/fs";
import { PipePublicationRegistry } from "waffle/proc/pipes";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState } from "waffle/proc/worker-client";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";

const NativeWorker = globalThis.Worker;
const workers = new Set<Worker>();
const created: string[] = [];
const messages: unknown[] = [];
const failures: string[] = [];
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers.add(this); created.push(String(url));
    this.addEventListener("error", event => failures.push(event.message));
    this.addEventListener("message", event => {
      if (["exit", "error", "cleanup-error"].includes(event.data?.type)) messages.push(event.data);
    });
  }
  override terminate() { workers.delete(this); super.terminate(); }
};
let runtime: Runtime | undefined;
let installation: Awaited<ReturnType<typeof installBunAdapters>> | undefined;
let service: ProcessService | undefined;
let rootPid: number | undefined;
const descriptors = new DescriptorTable();
let disposal: Promise<unknown> | undefined;
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
function cleanup() {
  return disposal ??= (async () => {
    try {
      if (rootPid !== undefined) await service?.rootExit(rootPid, 0);
      installation?.dispose();
      await runtime?.dispose();
      check(workers.size === 0, `production teardown left ${workers.size} workers`);
    } finally {
      descriptors.dispose();
      for (const worker of Array.from(workers)) worker.terminate();
      globalThis.Worker = NativeWorker;
    }
    check(workers.size === 0 && runtime?.disposed, "owned runtime and workers released");
    return { workers: workers.size, runtimeDisposed: runtime.disposed, workerConstructorRestored: globalThis.Worker === NativeWorker };
  })();
}
addEventListener("pagehide", () => { void cleanup(); }, { once: true });

async function run() {
  check(crossOriginIsolated, "cross-origin isolated fixture");
  let stdout = "", stderr = "";
  const decoder = new TextDecoder();
  runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) } });
  try {
    const asset = { url: new URL("./bun.wasm", location.href).href, bytes: 15398503,
      sha256: "24bd79657c033294298565597ce1d60b4640d77756b53bae84abd1bf908add56",
      quickjs: { url: new URL("./quickjs.wasm", location.href).href, bytes: 1058884,
        sha256: "c64a2336b7d6ed5a8b44824e668bae1f17462e8979c5fb8f1093c6045dd5e977" } };
    const module = await loadBunWasm({ asset });
    installation = await installBunAdapters(runtime, { module, engine: "quickjs", workerUrl: new URL("./worker.js", location.href) });
    await runtime.filesystem.mkdirp("/fixture");
    for (const name of ["main.ts", "value.ts"]) {
      const response = await fetch(`./fixtures/${name}`);
      check(response.ok, `fixture source ${name}`);
      await runtime.filesystem.writeFile(`/fixture/${name}`, await response.text());
    }
    await runtime.filesystem.flush();
    service = await runtime.processes();
    const transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    rootPid = workerProcessState(transport).pid;
    const identity = runtime.filesystem.createIdentity();
    const registry = new PipePublicationRegistry();
    transport.data = { filesystem: identity, pipeRegistry: registry.handle() };
    await service.adoptRuntimeRoot(transport, { output(fd, bytes) {
      if (fd === 2) stderr += decoder.decode(bytes); else stdout += decoder.decode(bytes);
    } });
    for (const fd of [0, 1, 2]) check(descriptors.open({ kind: "terminal", read: () => 0,
      write: chunks => chunks.reduce((size, bytes) => size + bytes.length, 0),
      readiness: () => ({ readable: true, writable: true, hangup: fd === 0 }) }, (1n << 29n) - 1n, 0n) === fd, "stdio descriptor");
    const codec = createRuntimeTerminalCodec({ descriptors, fallback: {
      export() { throw new Error("unexpected non-terminal descriptor"); },
      import() { throw new Error("unexpected non-terminal token"); },
      discard() { throw new Error("unexpected non-terminal token"); },
    } });
    const owner = runtime, broker = service;
    const client = new WorkerProcessClient({ transport, descriptors, codec,
      prepareSpawn(pid) {
        const filesystem = createProcessFilesystemIdentity(identity);
        registry.registerProcess(pid);
        return { data: { filesystem, pipeRegistry: registry.handle() }, cancel: () => registry.collectProcess(pid) };
      },
      postMessage(message) { void broker.runtimeMessage(message, client.pid).catch(error => failures.push(String(error))); },
    });
    const executable = `${ENGINE_BIN.quickjs}/bun`;
    const pid = client.spawn(client.pid, { executable, argv: [executable, "run", "/fixture/main.ts"],
      cwd: "/fixture", env: {}, job: 0, fds: [0, 1, 2].map(fd => ({ parent: fd, child: fd })) });
    const outcome = await (await broker.ready()).waitForExit(client.pid, pid);
    check(outcome.kind === "exited" && outcome.code === 0, `ordinary outcome ${JSON.stringify(outcome)}`);
    check(stdout === "42\n" && stderr === "", `ordinary output ${JSON.stringify({ stdout, stderr })}`);
    check(failures.length === 0, JSON.stringify(failures));
    check(!owner.disposed, "caller runtime remains live until explicit cleanup");
    return { stdout, stderr, outcome, created, messages, failures };
  } finally { await cleanup(); }
}
Object.assign(globalThis, { ordinaryRuntime: { run, cleanup, diagnostics: () => ({ created, messages, failures, workers: workers.size }) } });
