import { createRuntime, type Runtime, type ProcessService } from "waffle";
import { createWorkerProcessTransport, workerProcessState, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { installBunAdapters, type BunAdapterOptions } from "../../src/bun-adapter.js";
import { runtimeProcFixture } from "./runtime-proc-fixtures";
import { bunRuntimeProcFixture, bunRuntimeProcScenarios } from "./bun-runtime-proc-fixtures";

const parameters = new URLSearchParams(location.search);
const engine = parameters.get("engine") ?? "browser";
if (engine !== "browser" && engine !== "quickjs" && engine !== "jsc") throw new Error(`unknown engine ${engine}`);
const publishedDefault = parameters.has("published-default");
const name = parameters.get("scenario") ?? "nested";
const scenario = bunRuntimeProcScenarios.find(item => item.name === name);
const nativeWorker = globalThis.Worker;
const workers = new Set<Worker>();
const operations: string[] = [];
const launches: { pid: number; parentPid: number; job: number; executable: string; argv: string[] }[] = [];
const exits: { worker: number; type: string; code: number; message?: string }[] = [];
const errors: string[] = [];
const confirmedExits: { pid: number; parentPid: number; job: number; status: number | null; kind: string }[] = [];
let workersCreated = 0;
// Passive accounting only: every message and all production worker code remain unchanged.
globalThis.Worker = class extends nativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); workers.add(this); const worker = ++workersCreated;
    this.addEventListener("message", ({ data }) => {
      if (data.type === "runtime-proc") {
        operations.push(data.operation);
        if (data.operation === "spawn") {
          const state = workerProcessState(data.transport);
          launches.push({ pid: state.pid, parentPid: state.parentPid, job: state.job, executable: data.request.executable, argv: data.request.argv });
        }
      }
      if (data.type === "exit" || data.type === "error") exits.push({ worker, type: data.type, code: data.code, message: data.message });
    });
    this.addEventListener("error", event => errors.push(event.message));
  }
  override terminate() { workers.delete(this); super.terminate(); }
};
function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
async function until(condition: () => boolean, label: string) {
  const deadline = performance.now() + 30_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
let runtime: Runtime | undefined;
let installation: Awaited<ReturnType<typeof installBunAdapters>> | undefined;
let rootWorker: Worker | undefined;
let rootConnection: ReturnType<Runtime["filesystem"]["fork"]> | undefined;
let result: Record<string, unknown> | undefined;
let stdout = "", stderr = "";
let disposedWhileLive = false;
const diagnostics = () => ({ scenario: name, stdout, stderr, operations, launches, exits, confirmedExits, errors,
  cleanup: { activeWorkers: workers.size, workersCreated }, disposedWhileLive });
Reflect.set(globalThis, "bunRuntimeProcDiagnostics", diagnostics);
try {
  equal(crossOriginIsolated, true, "external root requires SharedArrayBuffer isolation");
  if (!scenario && name !== "generic-control") throw new Error(`unknown scenario ${name}`);
  runtime = createRuntime({ filesystem: { workerURL: new URL("./fs-worker.js", location.href) } });
  await runtime.filesystem.mkdirp("/home/user");
  await runtime.filesystem.writeFile("/home/user/preopen-data", "ROOT_PREOPEN_OK");
  if (scenario?.fileCursor) await runtime.filesystem.writeFile("/home/user/inherited-cursor", "xxcursor!");
  await runtime.filesystem.flush();
  const service: ProcessService = await runtime.processes();
  const supervisor = await service.ready();
  supervisor.onChildExit(event => confirmedExits.push({ pid: event.pid, parentPid: event.parentPid, job: event.job,
    status: event.result.status, kind: event.result.kind }));
  const module = name === "generic-control" ? new WebAssembly.Module(runtimeProcFixture()) : undefined;
  if (module) {
    runtime.registerAdapter("preview1", (context, processes) => processes.launchWorker(context, {
      workerUrl: new URL("./preview1-worker.js", location.href).href,
      request: { module: context.module, args: context.request.argv, env: context.request.env, interruptible: context.interruptible },
    }));
    await runtime.filesystem.mkdirp("/bin");
    await runtime.filesystem.writeFile("/bin/bun", "fixture");
    runtime.registerProgram("/bin/bun", { adapter: "preview1", module, cooperative: true });
  } else {
    const workerUrl = new URL("./worker.js", location.href).href;
    // Explicit opt-in only: this mode exercises the package's public default descriptor,
    // with no engine/module/asset/URL override and no local artifact fallback.
    const options: BunAdapterOptions = publishedDefault ? { workerUrl } : { workerUrl, engine,
      module: await WebAssembly.compileStreaming(fetch("./bun-guest.wasm")),
      executables: ["/bin/bun", "/bin/node"] };
    // Disposal must unregister aliases and adapters, not merely clear a private installed flag.
    const first = await installBunAdapters(runtime, options);
    first.dispose(); first.dispose();
    const unregisterProbe = runtime.registerAdapter("bun:browser", () => { throw new Error("unregister probe must never launch"); });
    unregisterProbe();
    const probeAdapter = runtime.registerAdapter("test:unregister", () => { throw new Error("alias probe must never launch"); });
    const unregisterProgram = runtime.registerProgram("/bin/bun", { adapter: "test:unregister", module: new WebAssembly.Module(runtimeProcFixture()), cooperative: true });
    unregisterProgram(); probeAdapter();
    installation = await installBunAdapters(runtime, options);
    if (name === "start-failed") await runtime.filesystem.writeFile("/bin/broken-bun", "fixture");
    if (name === "start-failed") runtime.registerProgram("/bin/broken-bun", {
      adapter: `bun:${engine}`, cooperative: true,
      module: () => { throw new Error("bun-runtime-proc-start-failed-control"); },
    });
  }
  const rootModule = module ?? new WebAssembly.Module(bunRuntimeProcFixture(scenario!));
  const pid = runtime.identities.pid(), job = runtime.identities.job();
  const transport = createWorkerProcessTransport({ pid, job, identity: runtime.identities.buffer });
  rootConnection = runtime.filesystem.fork();
  const { port, ...identity } = rootConnection;
  transport.data = { filesystem: identity };
  let acknowledged = false;
  const output = (fd: 1 | 2, bytes: Uint8Array) => {
    if (fd === 2) stderr += new TextDecoder().decode(bytes);
    else stdout += new TextDecoder().decode(bytes);
  };
  const completion = Promise.withResolvers<{ code: number; error?: string }>();
  await service.adoptRuntimeRoot(transport, { filesystem: identity, acknowledged: () => acknowledged,
    output,
    stop: () => { rootWorker?.terminate(); completion.resolve({ code: 137 }); },
  });
  rootWorker = new Worker(new URL("./preview1-worker.js", location.href), { type: "module" });
  rootWorker.onmessage = ({ data }) => {
    if (data.type === "runtime-proc") {
      void service.runtimeMessage(data as WorkerProcessMessage, pid).catch(completion.reject); return;
    }
    if (data.type === "stdout" || data.type === "stderr") output(data.type === "stderr" ? 2 : 1, data.data);
    if (data.type === "cleanup-error") { completion.reject(new Error(data.message)); return; }
    if (data.type !== "exit" && data.type !== "error") return;
    acknowledged = true;
    void service.rootExit(pid, data.code).then(() => {
      rootWorker?.terminate(); completion.resolve({ code: data.code, error: data.type === "error" ? data.message : undefined });
    }, completion.reject);
  };
  rootWorker.onerror = event => { event.preventDefault(); completion.reject(new Error(event.message)); };
  rootWorker.postMessage({ module: rootModule, args: ["external-shell", "root"], env: { PWD: "/home/user" },
    filesystem: rootConnection, runtimeProcess: transport }, [port]);
  await actOnTree(service);
  if (!disposedWhileLive) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([completion.promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("external root sequence timed out")), 60_000);
    })]).finally(() => clearTimeout(timeout));
    equal(outcome.code, 0, `external generic root exit; ${outcome.error ?? stderr}`);
    equal(outcome.error, undefined, "external root did not crash");
    verifyOutput();
    if (name !== "generic-control") equal(operations.filter(operation => operation === "reap-job").length >= scenario!.commands.length, true, "generic root consumed real job results");
    await until(() => workers.size === 1, "only page filesystem worker remains after guest completion");
    installation?.dispose(); installation?.dispose(); installation = undefined;
    await runtime!.dispose(); runtime = undefined;
  }
  await until(() => workers.size === 0, "external Runtime disposal stopped every owned worker");
  equal(errors.length, 0, "worker errors");
  result = { ok: true, ...diagnostics() };
} catch (error) {
  result = { ok: false, ...diagnostics(), error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
} finally {
  try { installation?.dispose(); await runtime?.dispose(); }
  catch (error) { result = { ...result, ok: false, teardownError: String(error) }; }
  rootConnection?.port.close();
  const forcedWorkers = workers.size;
  for (const worker of workers) worker.terminate();
  globalThis.Worker = nativeWorker;
  Reflect.set(globalThis, "bunRuntimeProcResult", { ...result, teardown: { forcedWorkers, activeWorkers: workers.size } });
}

async function actOnTree(service: ProcessService) {
  if (!scenario?.action) return;
  await until(() => stdout.includes("leader-ready\n") && stdout.includes("child-ready\n") && stdout.includes("grandchild-ready\n"), "three real Bun generations ready");
  if (scenario.action === "kill-detached") await until(() => stdout.includes("detached-ready\n"), "independent detached Bun ready");
  equal(launches.length, scenario.action === "kill-detached" ? 4 : 3, "root Bun.spawn and nested child_process all used generic process admission");
  const first = launches[0]!;
  const foreground = launches.filter(launch => launch.job === first.job);
  equal(foreground.length, 3, "all three ordinary Bun generations inherit the foreground job");
  equal(foreground[1]!.parentPid, first.pid, "Bun child ancestry");
  equal(foreground[2]!.parentPid, foreground[1]!.pid, "node child_process grandchild ancestry");
  if (scenario.action === "dispose") {
    disposedWhileLive = true;
    await runtime!.dispose(); runtime = undefined;
    return;
  }
  await service.killJob(first.job, 9);
  if (scenario.action !== "kill-detached") return;
  const detached = launches.find(launch => launch.job !== first.job)!;
  equal(detached.parentPid, first.pid, "detached child came from the same Bun leader");
  await until(() => confirmedExits.filter(exit => exit.job === first.job && exit.status === 137).length === 3, "foreground safe without detached child exit");
  equal((await service.ready()).get(detached.pid)?.result, null, "foreground kill did not stop the detached group");
  await service.killJob(detached.job, 9);
  await until(() => confirmedExits.some(exit => exit.pid === detached.pid && exit.status === 137), "owned detached cleanup");
}

function verifyOutput() {
  if (name === "generic-control") {
    equal(stdout, "child-stdout\nruntime-proc-ok\n", "existing generic ABI fixture");
    equal(stderr, "child-stderr\n", "generic inherited terminal targets");
  } else if (name === "start-failed") {
    equal(stdout, scenario!.stdout, "start failure still settles blocking wait_job");
    equal(stderr, "", "startup diagnostics stay out of guest stderr");
    const failed = confirmedExits.filter(exit => exit.kind === "start-failed");
    equal(failed.length, 1, "one typed startup refusal reached the parent");
    equal(failed[0]!.status, null, "startup refusal is not an exited guest");
  } else if (scenario!.action === "kill" || scenario!.action === "kill-detached") {
    if (!stdout.endsWith(scenario!.stdout)) throw new Error(`kill did not unblock root wait_job: ${stdout}`);
    equal(stderr, "", "kill stderr");
    equal(confirmedExits.filter(exit => exit.kind === "signaled" && exit.status === 137).length, scenario!.action === "kill-detached" ? 4 : 3, "all owned descendants reached confirmed SIGKILL outcomes");
  } else {
    equal(stdout, scenario!.stdout, "real guest stdout");
    equal(stderr, scenario!.stderr ?? "", "real guest stderr");
    if (name === "guest-kill-job-descendants") {
      equal(launches.length, 3, "external shell launched Bun, nested Bun.spawn and node child_process");
      const foreground = launches[0]!;
      for (const launch of launches) equal(launch.job, foreground.job, "nested descendants stayed in the shell's foreground job");
      equal(launches[1]!.parentPid, foreground.pid, "nested Bun.spawn ancestry");
      equal(launches[2]!.parentPid, launches[1]!.pid, "nested child_process ancestry");
      equal(operations.filter(operation => operation === "signal").length, 1, "generic root called the actual kill_job ABI");
      equal(confirmedExits.filter(exit => exit.status === 137 && exit.kind === "signaled").length, 3, "wait_job returned only after all three killed members were confirmed safe");
    }
  }
}
