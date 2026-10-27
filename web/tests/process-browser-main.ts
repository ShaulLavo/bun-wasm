import { controlLoad } from "waffle/proc/control";
import { createRuntime, type Runtime, type RuntimeOptions, type ProcessService } from "waffle";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { bunLauncher, preview1Launcher } from "../src/bun-launcher";
import { DescriptorTable } from "waffle/core/descriptors";
import { FilesystemClient, createProcessFilesystemIdentity, revokeFilesystem, reapFilesystem, type FilesystemIdentity } from "waffle/fs";
import { ProcessABI } from "waffle/proc/abi";
import { ProcessError, ProcessErrno, type ProcessExit, type SpawnRequest } from "waffle/proc/types";
import { readOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessSlots, workerProcessState, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import { processFixture, type ProcessFixture } from "./process-fixtures";
import { measureProcessStarts } from "./process-benchmark";

type ExecutableRegistration = { module: WebAssembly.Module | (() => Promise<WebAssembly.Module>); adapter: "preview1" | "bun"; cooperative?: true; engine?: "quickjs" };
const decoder = new TextDecoder();
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1));
function equal(actual: unknown, expected: unknown, label: string) { if (actual !== expected) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }
function truth(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
const checks: string[] = [];
const activeWorkers = new Set<Worker>();
let currentTest = "startup";
const workerProgress: { url: string; events: unknown[] }[] = [];
Object.assign(globalThis, { processProgress: () => ({ checks, currentTest, activeWorkers: activeWorkers.size, workers: workerProgress }) });
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); activeWorkers.add(this);
    const progress: { url: string; events: unknown[] } = { url: String(url), events: [] }; workerProgress.push(progress);
    this.addEventListener("error", event => progress.events.push({ error: event.message }));
    this.addEventListener("message", event => {
      if (["phase", "exit", "error"].includes(event.data?.type)) progress.events.push(event.data);
    });
  }
  override terminate() { activeWorkers.delete(this); super.terminate(); }
};
let activeRuntime: Runtime | undefined;
// Original preview1 bytes call the generic runtime_proc ABI directly: no Bun artifact or slots.
const modules = new Map<ProcessFixture, WebAssembly.Module>();
function module(mode: ProcessFixture) { let result = modules.get(mode); if (!result) { result = new WebAssembly.Module(processFixture(mode)); modules.set(mode, result); } return result; }
type Controller = ReturnType<typeof controller>;
interface Child {
  owner: Controller; pid: number; transport: WorkerProcessTransport;
  state: ReturnType<typeof workerProcessState>; filesystem: FilesystemIdentity;
  readers: number[]; stdout: string; stderr: string;
  result: Promise<ProcessExit>; status?: number;
}
// Human-readable fixture labels are not executable names at the runtime boundary.
const fixtureExecutable = (name: string) => name.startsWith("/") ? name : `/bin/${name}`;
function controller(transport: WorkerProcessTransport, service: ProcessService, runtime: Runtime, publish: (transport: WorkerProcessTransport, owner: Controller, admission: Promise<void>) => void, failures: unknown[]) {
  const descriptors = new DescriptorTable();
  const identity = (transport.data as { filesystem: FilesystemIdentity }).filesystem;
  const fs = new FilesystemClient(runtime.filesystem.connect(identity));
  const memory = new WebAssembly.Memory({ initial: 1 });
  const postMessage = (message: Parameters<ProcessService["runtimeMessage"]>[0]) => {
    const admission = service.runtimeMessage(message, client.pid);
    if (message.operation === "spawn") publish(message.transport, owned, admission);
    void admission.catch(error => { failures.push(error); });
  };
  const pipes = new WorkerPipeHost({ transport, postMessage,
    registry: (transport.data as { pipeRegistry: ConstructorParameters<typeof WorkerPipeHost>[0]["registry"] }).pipeRegistry });
  const client = new WorkerProcessClient({ transport, descriptors, codec: pipes.codec(), postMessage,
    createPipe: () => pipes.createPipe(), revokeProcess: pid => pipes.revokeProcess(pid),
    prepareSpawn: pid => {
      const filesystem = createProcessFilesystemIdentity(identity);
      try { pipes.registry.registerProcess(pid); }
      catch (error) { revokeFilesystem(filesystem); reapFilesystem(filesystem); throw error; }
      return {
        data: { filesystem, pipeRegistry: pipes.registry.handle() },
        cancel() { revokeFilesystem(filesystem); reapFilesystem(filesystem); pipes.registry.collectProcess(pid); },
      };
    },
  });
  const abi = new ProcessABI({ memory, descriptors, fs, pid: client.pid, service: client, signals: client.signals,
    wake: client.wake, createPipe: () => client.createPipe() });
  const owned = { client, abi, memory, descriptors, transport, dispose() { descriptors.dispose(); fs.dispose(); } };
  return owned;
}
async function scope(entries: Record<string, ExecutableRegistration>, options: RuntimeOptions = {}, owner?: Runtime) {
  const runtime = owner ?? createRuntime({ ...options, filesystem: { workerURL: new URL("./fs-worker.js", location.href) } });
  activeRuntime = runtime;
  const filesystem = runtime.filesystem;
  const children = new Map<number, Child>(), controllers: Controller[] = [], failures: unknown[] = [];
  let service: ProcessService | undefined, root: WorkerProcessTransport | undefined;
  try {
    if (!owner) {
      await filesystem.mkdirp("/home/user"); await filesystem.flush();
      const workerUrl = new URL("./worker.js", location.href).href;
      runtime.registerAdapter("preview1", preview1Launcher({ workerUrl }));
      runtime.registerAdapter("bun:quickjs", bunLauncher("quickjs", { runtime, workerUrl }));
    }
    await filesystem.mkdirp("/bin");
    for (const [name, entry] of Object.entries(entries)) {
      const path = fixtureExecutable(name);
      await filesystem.writeFile(path, "process fixture");
      runtime.registerProgram(path,
        { module: entry.module, adapter: entry.adapter === "bun" ? "bun:quickjs" : "preview1", cooperative: true });
    }
    await filesystem.flush();
    service = await runtime.processes();
    root = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
    root.data = { filesystem: filesystem.createIdentity() };
    await service.adoptRuntimeRoot(root);
    function publish(transport: WorkerProcessTransport, owner: Controller, admission: Promise<void>) {
      const state = workerProcessState(transport);
      const result = admission.then(() => service!.ready()).then(supervisor => supervisor.waitForExit(state.parentPid, state.pid));
      const child: Child = { owner, pid: state.pid, transport, state,
        filesystem: (transport.data as { filesystem: FilesystemIdentity }).filesystem, readers: [], stdout: "", stderr: "", result };
      children.set(state.pid, child);
      void result.then(outcome => { child.status = outcome.kind === "start-failed" ? outcome.error === "ENOENT" ? 127 : 126 : outcome.status; });
    }
    function makeController(transport: WorkerProcessTransport) {
      const result = controller(transport, service!, runtime, publish, failures); controllers.push(result); return result;
    }
    const rootController = makeController(root);
    function spawn(executable: string, meta: Partial<SpawnRequest> = {}, parent?: Child): Child {
      const caller = parent ? makeController(parent.transport) : rootController;
      const view = new DataView(caller.memory.buffer), bindings: { parent: number; child: number }[] = [], readers: number[] = [];
      for (const fd of [0, 1, 2]) {
        equal(caller.abi.imports.pipe!(0), 0, "runtime_proc.pipe");
        const read = view.getUint32(0, true), write = view.getUint32(4, true);
        bindings.push({ parent: fd === 0 ? read : write, child: fd }); readers.push(fd === 0 ? write : read);
      }
      const request: SpawnRequest = { executable: fixtureExecutable(executable), argv: [executable], cwd: "/home/user", env: { PATH: "/bin" }, job: parent?.state.job ?? 0, fds: bindings, ...meta };
      const bytes = new TextEncoder().encode(JSON.stringify(request)); new Uint8Array(caller.memory.buffer, 64, bytes.length).set(bytes);
      const pid = caller.abi.imports.spawn!(64, bytes.length);
      truth(pid > 0, `generic spawn returns a pid synchronously: ${pid}`);
      const child = children.get(pid); truth(child, "generic publication retains transport before spawn returns"); child.readers = readers;
      for (const binding of bindings) caller.descriptors.close(binding.parent);
      caller.descriptors.close(readers[0]!); // EOF stdin; keep stdout/stderr readers until explicit closure.
      return child;
    }
    return { service, children, spawn, filesystem,
      wait: (pid: number) => children.get(pid)!.result,
      async dispose() {
        const errors: unknown[] = failures.slice();
        try { await service!.rootExit(workerProcessState(root!).pid, 0); } catch (error) { errors.push(error); }
        for (const owned of controllers.reverse()) try { owned.dispose(); } catch (error) { errors.push(error); }
        if (!owner) {
          try { await runtime.dispose(); } catch (error) { errors.push(error); }
          finally { if (activeRuntime === runtime) activeRuntime = undefined; }
        }
        if (errors.length) throw new AggregateError(errors, "process fixture cleanup failed");
      },
      check() { if (failures.length) throw new AggregateError(failures, "generic controller message failed"); },
    };
  } catch (error) {
    for (const owned of controllers.reverse()) owned.dispose();
    if (!owner) { await runtime.dispose(); if (activeRuntime === runtime) activeRuntime = undefined; }
    throw error;
  }
}
function drain(child: Child) {
  for (const fd of [1, 2]) for (;;) {
    const length = child.owner.abi.imports.read!(child.readers[fd]!, 4096, 4096);
    if (length <= 0) break;
    const text = decoder.decode(new Uint8Array(child.owner.memory.buffer, 4096, length));
    if (fd === 1) child.stdout += text; else child.stderr += text;
  }
}
// This signal/job harness observes without collecting: assertions below still inspect
// the process's signal cells. Generic ABI consuming waits are covered by browser-runtime-proc.
function waitStatus(child: Child) { return child.status ?? -2; }
async function until(condition: () => boolean, label: string) {
  const end = performance.now() + 10_000;
  for (;;) { if (condition()) return; if (performance.now() > end) throw new Error(`${label} timed out`); await pause(); }
}
async function ready(child: Child) { await until(() => { drain(child); return child.stdout.includes("ready\n"); }, `pid ${child.pid} first output (${child.stderr})`); }
async function exit(child: Child, expected: number) {
  await until(() => { drain(child); return waitStatus(child) !== -2; }, `pid ${child.pid} exit`);
  drain(child); equal(waitStatus(child), expected, `pid ${child.pid} status (${child.stderr})`);
}
async function test(name: string, run: () => Promise<void>) { currentTest = name; await run(); checks.push(name); }

try {
  truth(crossOriginIsolated, "process tests require cross-origin isolation");
  await test("generic-preview1-without-bun-slots", async () => {
    truth(WebAssembly.Module.imports(module("exit")).every(entry => entry.module === "runtime_proc" || entry.module === "wasi_snapshot_preview1"), "fixture must not import Bun slots");
    const s = await scope({ tiny: { module: module("exit"), adapter: "preview1", cooperative: true } });
    try { const child = s.spawn("tiny"); await exit(child, 0); equal(child.stdout, "ready\n", "preview1 stdout"); equal(child.stderr, "", "preview1 stderr"); }
    finally { await s.dispose(); }
  });
  for (const [signal, status] of [[2, 130], [15, 143], [13, 141], [9, 137]]) {
    await test(`cpu-default-signal-${signal}-status-${status}`, async () => {
      const s = await scope({ spin: { module: module("default"), adapter: "preview1", cooperative: true } });
      try {
        const child = s.spawn("spin"); await ready(child);
        const recorded = s.wait(child.pid);
        await s.service.kill(child.pid, signal!);
        await exit(child, status!);
        const result = await recorded;
        equal(result.kind, "signaled", "signal outcome kind"); equal(result.code, signal, "unregistered signal is claimed by the supervisor");
        equal(controlLoad(child.state.signals.signalState, signal!), 0, "default signal never becomes pending handled work");
        truth(controlLoad(new Int32Array(child.filesystem.revocations[0]!), 0) !== 0, "signal default action revokes filesystem access");
      } finally { await s.dispose(); }
    });
  }
  for (const mode of ["epipe", "epipe-ignored"] as const) await test(`${mode}-keeps-own-exit-42-not-SIGPIPE-141`, async () => {
    const s = await scope({ epipe: { module: module(mode), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("epipe");
      // Close before async activation, guaranteeing the guest's ordinary fd_write sees EPIPE.
      equal(child.owner.descriptors.close(child.readers[1]!), true, "close reader");
      const recorded = s.wait(child.pid); await exit(child, 42);
      equal((await recorded).kind, "exited", "handled EPIPE is not default SIGPIPE"); equal(child.stderr, "", "handled EPIPE stderr");
    } finally { await s.dispose(); }
  });
  for (const [mode, signal, status] of [["handled", 2, 0], ["handled-term", 15, 0], ["handled-term-23", 15, 23], ["handled-term-143", 15, 143], ["handled-pipe", 13, 42]] as const) {
    await test(`${mode}-signal-${signal}-keeps-own-exit-${status}`, async () => {
      const s = await scope({ handled: { module: module(mode), adapter: "preview1", cooperative: true } });
      try {
        const child = s.spawn("handled"); await ready(child); const recorded = s.wait(child.pid);
        equal(controlLoad(child.state.signals.signalState, signal), 2, "handler registered before readiness");
        await s.service.kill(child.pid, signal); await exit(child, status);
        const result = await recorded;
        equal(result.kind, "exited", "handled signal preserves ordinary exit kind"); equal(result.code, status, "own exit code is not inferred to be a signal");
      } finally { await s.dispose(); }
    });
  }
  await test("ignored-PIPE-never-pends-or-revokes-and-guest-keeps-own-zero", async () => {
    const s = await scope({ ignored: { module: module("ignored-pipe"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("ignored"); await ready(child);
      const interruptBefore = controlLoad(child.state.signals.interrupt, 0);
      await s.service.kill(child.pid, 13);
      equal(controlLoad(child.state.signals.signalState, 13), 1, "ignored PIPE has no pending bit");
      equal(controlLoad(child.state.signals.interrupt, 0), interruptBefore, "ignored PIPE does not request an interrupt wake");
      equal(waitStatus(child), -2, "ignored PIPE leaves guest alive");
      equal(controlLoad(new Int32Array(child.filesystem.revocations[0]!), 0), 0, "ignored PIPE does not revoke filesystem");
      const recorded = s.wait(child.pid);
      await s.service.kill(child.pid, 2); await exit(child, 0);
      equal((await recorded).kind, "exited", "ignored PIPE cannot overwrite later ordinary exit");
    } finally { await s.dispose(); }
  });
  await test("last-handler-removal-restores-default-for-next-INT", async () => {
    const s = await scope({ once: { module: module("removed"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("once"); await ready(child);
      await s.service.kill(child.pid, 2);
      await until(() => { drain(child); return child.stdout.includes("handling\n"); }, "once handler removed acknowledgement");
      equal(controlLoad(child.state.signals.signalState, 2), 0, "last removal resets disposition and clears consumed pending");
      equal(waitStatus(child), -2, "removal cannot reinterpret already consumed first signal");
      const recorded = s.wait(child.pid);
      await s.service.kill(child.pid, 2); await exit(child, 130);
      equal((await recorded).kind, "signaled", "second INT applies restored default");
    } finally { await s.dispose(); }
  });
  await test("explicit-default-signal-remains-typed-signal-outcome", async () => {
    const s = await scope({ explicit: { module: module("explicit-default"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("explicit"); await ready(child); const recorded = s.wait(child.pid);
      await s.service.kill(child.pid, 2); await exit(child, 130);
      const result = await recorded; equal(result.kind, "signaled", "explicit default trap is typed"); equal(result.code, 2, "explicit default signal");
    } finally { await s.dispose(); }
  });
  await test("handled-INT-then-unrelated-trap-not-signal-default", async () => {
    const s = await scope({ trap: { module: module("handled-trap"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("trap"); await ready(child); const recorded = s.wait(child.pid);
      await s.service.kill(child.pid, 2); await exit(child, 1);
      equal((await recorded).kind, "exited", "arbitrary RuntimeError must not be inferred to be SIGINT");
    } finally { await s.dispose(); }
  });
  await test("KILL-during-active-INT-handler-status-137", async () => {
    const s = await scope({ handler: { module: module("handling"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("handler"); await ready(child);
      equal(child.owner.abi.imports.kill!(child.pid, 2), 0, "guest runtime_proc.kill publishes the shared request");
      await until(() => { drain(child); return child.stdout.includes("handling\n"); }, "signal handler output");
      // The acknowledgement proves dequeue completed; no arbitrary delay is needed.
      equal(controlLoad(child.state.signals.signalState, 2), 2, "INT pending bit was consumed, disposition remains handled");
      equal(waitStatus(child), -2, "catchable INT must not force termination");
      equal(controlLoad(new Int32Array(child.filesystem.revocations[0]!), 0), 0, "handled INT must not revoke");
      const recorded = s.wait(child.pid); await s.service.kill(child.pid, 9); await exit(child, 137);
      equal((await recorded).code, 9, "KILL overrides an in-progress handler");
      equal(child.stdout.split("handling\n").length - 1, 1, "broker observation never redelivers a consumed INT request");
    } finally { await s.dispose(); }
  });
  await test("mixed-job-members-apply-their-own-default-handled-ignored-dispositions", async () => {
    const s = await scope({ active: { module: module("handling"), adapter: "preview1", cooperative: true }, unhandled: { module: module("default"), adapter: "preview1", cooperative: true }, ignored: { module: module("ignored-int"), adapter: "preview1", cooperative: true } });
    try {
      const parent = s.spawn("active", { job: 0 }); await ready(parent);
      const unhandled = s.spawn("unhandled", {}, parent), ignored = s.spawn("ignored", {}, parent);
      await Promise.all([ready(unhandled), ready(ignored)]);
      equal(unhandled.state.job, parent.state.job, "default child shares foreground job");
      equal(ignored.state.job, parent.state.job, "ignored child shares foreground job");
      const unhandledExit = s.wait(unhandled.pid);
      await s.service.killJob(parent.state.job, 2);
      await exit(unhandled, 130);
      await until(() => { drain(parent); return parent.stdout.includes("handling\n"); }, "mixed job handled acknowledgement");
      equal((await unhandledExit).kind, "signaled", "default member exits on INT");
      equal(waitStatus(parent), -2, "handled member remains alive");
      equal(waitStatus(ignored), -2, "ignored member remains alive");
      equal(controlLoad(ignored.state.signals.signalState, 2), 1, "ignored member never queues INT");
      for (const child of [parent, ignored]) equal(controlLoad(new Int32Array(child.filesystem.revocations[0]!), 0), 0, "nondefault member keeps filesystem capability");
      const remaining = Promise.all([s.wait(parent.pid), s.wait(ignored.pid)]);
      await s.service.killJob(parent.state.job, 9);
      for (const result of await remaining) { equal(result.kind, "signaled", "KILL ignores member dispositions"); equal(result.status, 137, "KILL member status"); }
      await exit(parent, 137);
      equal((await unhandledExit).status, 130, "later job KILL cannot overwrite completed INT outcome");
    } finally { await s.dispose(); }
  });
  await test("delayed-first-activation-does-not-block-other-shell-task", async () => {
    let release!: () => void; let activationCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const s = await scope({ tiny: { module: module("exit"), adapter: "preview1", cooperative: true } }, { processHost: options => new BrowserProcessBroker({ ...options, activate: async () => { activationCalls++; await gate; return import("waffle/proc"); } }) });
    try {
      const child = s.spawn("tiny");
      equal(waitStatus(child), -2, "delayed spawn returns before activation");
      let ticks = 0;
      for (let i = 0; i < 5; i++) { await pause(); ticks++; equal(waitStatus(child), -2, "unrelated async task can run before activation"); }
      equal(ticks, 5, "other shell task progressed"); equal(activationCalls, 1, "activation shared once");
      release(); await exit(child, 0);
    } finally { release(); await s.dispose(); }
  });
  await test("shared-module-loader-compiles-once-for-concurrent-children", async () => {
    let loads = 0;
    const s = await scope({ tiny: { module: async () => { loads++; await pause(); return module("exit"); }, adapter: "preview1", cooperative: true } });
    try { const children = [s.spawn("tiny"), s.spawn("tiny")]; await Promise.all(children.map(child => exit(child, 0))); equal(loads, 1, "registry caches compiled module promise"); }
    finally { await s.dispose(); }
  });
  await test("start-failures-are-asynchronous-127-and-126", async () => {
    const s = await scope({ broken: { module: async () => { throw new Error("deliberate executable load failure"); }, adapter: "preview1", cooperative: true }, unrunnable: { module: module("unrunnable"), adapter: "preview1", cooperative: true } });
    try {
      const missing = s.spawn("missing"); const broken = s.spawn("broken"); const unrunnable = s.spawn("unrunnable");
      await Promise.all([exit(missing, 127), exit(broken, 126), exit(unrunnable, 126)]);
      const missingResult = await s.wait(missing.pid), brokenResult = await s.wait(broken.pid);
      equal(missingResult.kind, "start-failed", "missing program is a typed startup failure");
      truth(missingResult.kind === "start-failed", "missing startup failure"); equal(missingResult.error, "ENOENT", "missing registry executable");
      equal(brokenResult.kind, "start-failed", "failed compile/load is a startup failure");
      equal((await s.wait(unrunnable.pid)).kind, "start-failed", "unknown imports refuse registered executable at instantiation");
    } finally { await s.dispose(); }
  });
  await test("foreground-descendants-reaped-background-survives-next-command", async () => {
    const s = await scope({ spin: { module: module("default"), adapter: "preview1", cooperative: true }, tiny: { module: module("exit"), adapter: "preview1", cooperative: true } });
    try {
      const foreground = s.spawn("spin", { job: 0 }); await ready(foreground);
      const descendant = s.spawn("spin", {}, foreground);
      const background = s.spawn("spin", { job: -1 });
      await Promise.all([ready(descendant), ready(background)]);
      equal(descendant.state.parentPid, foreground.pid, "descendant parent");
      equal(descendant.state.job, foreground.state.job, "descendant inherits foreground job");
      truth(background.state.job !== foreground.state.job, "background has independent job");
      truth(descendant.pid !== descendant.state.job, "job identity is not child pid");
      // Register controller observations before completion can reap the orphan's record.
      // The foreground guest loses its child-control capability when its own process exits.
      const jobExits = Promise.all([s.wait(foreground.pid), s.wait(descendant.pid)]);
      await s.service.killJob(foreground.state.job, 2);
      for (const result of await jobExits) {
        equal(result.kind, "signaled", "foreground job member has a signal outcome");
        equal(result.code, 2, "foreground job member records INT");
        equal(result.status, 130, "controller observes foreground job member status");
      }
      await exit(foreground, 130);
      truth(readOutcome(foreground.state.signals.outcome), "parent has selected its terminal outcome");
      truth(controlLoad(new Int32Array(foreground.filesystem.revocations[0]!), 0) !== 0, "exited parent guest capability is revoked");
      const supervisor = await s.service.ready();
      await until(() => supervisor.jobEmpty(foreground.state.parentPid, foreground.state.job), "foreground job host-work fences");
      supervisor.reapJob(foreground.state.parentPid, foreground.state.job);
      await until(() => supervisor.get(descendant.pid) === undefined, "completed foreground descendant record reaped");
      equal(waitStatus(background), -2, "Ctrl+C leaves unrelated background child alive");
      for (const fd of [1, 2]) foreground.owner.descriptors.close(foreground.readers[fd]!);
      const next = s.spawn("tiny", { job: 0 }); await exit(next, 0);
      equal(waitStatus(background), -2, "background survives subsequent command completion");
      await s.service.killJob(background.state.job, 15); await exit(background, 143);
    } finally { await s.dispose(); }
  });
  await test("pids-never-reuse-when-completed-process-capacity-is-released", async () => {
    const s = await scope({ tiny: { module: module("exit"), adapter: "preview1", cooperative: true } });
    try {
      let previous = 1; let retired: Child | undefined;
      for (let index = 0; index < 8; index++) {
        const child = s.spawn("tiny"); truth(child.pid > previous, "pids are monotonic"); previous = child.pid;
        if (retired) assertRetiredCapability(retired);
        await exit(child, 0);
        for (const fd of [1, 2]) child.owner.descriptors.close(child.readers[fd]!);
        const supervisor = await s.service.ready();
        await until(() => supervisor.jobEmpty(child.state.parentPid, child.state.job), "completed job releases host-work capacity");
        supervisor.reapJob(child.state.parentPid, child.state.job);
        equal(supervisor.get(child.pid), undefined, "completed child metadata is reaped before next admission");
        equal(Array.from(supervisor.table.values()).length, 1, "only the controller consumes live process capacity");
        retired = child;
      }
    } finally { await s.dispose(); }
  });
  const query = new URLSearchParams(location.search);
  if (query.has("artifact")) {
    await test("actual-Bun-unawaited-child-survives-parent-and-releases-capacity-eight-times", async () => {
      const response = await fetch("/bun.wasm"); if (!response.ok) throw new Error(`existing bun.wasm: HTTP ${response.status}`);
      const compiled = await WebAssembly.compileStreaming(response);
      const s = await scope({ bun: { module: compiled, adapter: "bun", engine: "quickjs" } });
      try {
        for (let iteration = 0; iteration < 8; iteration++) {
          const permit = `/orphan-permit-${iteration}`, marker = `/orphan-done-${iteration}`;
          const childCode = `const fs=require('node:fs'); while(!fs.existsSync(${JSON.stringify(permit)})) await Bun.sleep(2); fs.writeFileSync(${JSON.stringify(marker)},'done');`;
          const parentCode = `Bun.spawn(['bun','-e',${JSON.stringify(childCode)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}).unref(); console.log('parent');`;
          const parent = s.spawn("bun", { argv: ["bun", "-e", parentCode] });
          await exit(parent, 0); equal(parent.stdout, "parent\n", "real guest parent exited without waiting for child");
          const liveDescendants = () => workerProcessSlots(parent.transport).filter(slot => { const state = workerProcessState(parent.transport, slot); return state.parentPid === parent.pid && controlLoad(state.confirmed, 0) === 0; });
          truth(liveDescendants().length > 0, "unawaited child still owns capacity after its parent exits");
          equal(await s.filesystem.readFile(marker), undefined, "orphan has not been allowed to finish before parent exit");
          await s.filesystem.writeFile(permit, "go");
          await waitForOrphanMarker(() => s.filesystem.readFile(marker), iteration);
          await until(() => liveDescendants().length === 0, "orphan completion releases capacity without a living parent waiter");
          for (const fd of [1, 2]) parent.owner.descriptors.close(parent.readers[fd]!);
          const supervisor = await s.service.ready();
          await until(() => supervisor.jobEmpty(parent.state.parentPid, parent.state.job), "orphan job quiescence");
          supervisor.reapJob(parent.state.parentPid, parent.state.job);
          await until(() => Array.from(supervisor.table.values()).length === 1, "closed parent and completed orphan release process metadata");
          equal(supervisor.get(parent.pid), undefined, "closed parent record reaped");
        }
      } finally { await s.dispose(); }
    });
  }
  let benchmark: Awaited<ReturnType<typeof measureProcessStarts>> | undefined;
  if (query.has("benchmark")) {
    // Filesystem startup is outside both candidate and baseline timing intervals. All
    // samples share the page owner, while each cold module gets a distinct registration.
    const owner = createRuntime({ filesystem: { workerURL: new URL("./fs-worker.js", location.href) } });
    activeRuntime = owner;
    try {
      await owner.filesystem.mkdirp("/home/user"); await owner.filesystem.flush();
      const workerUrl = new URL("./worker.js", location.href).href;
      owner.registerAdapter("preview1", preview1Launcher({ workerUrl }));
      owner.registerAdapter("bun:quickjs", bunLauncher("quickjs", { runtime: owner, workerUrl }));
      let sample = 0;
      benchmark = await measureProcessStarts(async (compiled, started) => {
        const executable = `bun-benchmark-${++sample}`;
        const s = await scope({ [executable]: { module: compiled, adapter: "bun", engine: "quickjs" } }, {}, owner);
        try {
          const child = s.spawn(executable, { argv: ["bun", "-e", "console.log('ready')"] });
          await ready(child); const firstOutputMs = performance.now() - started;
          await exit(child, 0); equal(child.stdout, "ready\n", "benchmark stdout"); equal(child.stderr, "", "benchmark stderr");
          return { firstOutputMs, exitMs: performance.now() - started };
        } finally { await s.dispose(); }
      });
    } finally {
      await owner.dispose(); activeRuntime = undefined;
    }
  }
  await activeRuntime?.dispose(); await pause();
  equal(activeWorkers.size, 0, "every task-created guest and filesystem worker was terminated");
  Object.assign(globalThis, { processResult: { ok: true, checks, benchmark, cleanup: { activeWorkers: activeWorkers.size } } });
} catch (error) {
  Object.assign(globalThis, { processResult: { ok: false, checks, error: String(error), stack: error instanceof Error ? error.stack : undefined } });
} finally {
  try { await activeRuntime?.dispose(); }
  catch (error) { Object.assign(globalThis, { processResult: { ok: false, checks, cleanupError: String(error) } }); }
  finally { for (const worker of activeWorkers) worker.terminate(); globalThis.Worker = NativeWorker; }
}

function assertRetiredCapability(child: Child) {
  let rejected = false;
  try { controlLoad(child.state.signals.interrupt, 0); }
  catch (error) { rejected = error instanceof ProcessError && error.errno === ProcessErrno.SRCH; }
  truth(rejected, "retired process capability cannot observe a reused directory slot");
}
async function waitForOrphanMarker(read: () => Promise<Uint8Array | undefined>, iteration: number) {
  const end = performance.now() + 10_000;
  while (decoder.decode(await read()) !== "done") {
    if (performance.now() > end) throw new Error(`orphan ${iteration} lost filesystem access after parent exit`);
    await pause();
  }
}
