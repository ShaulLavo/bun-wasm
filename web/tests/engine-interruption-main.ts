import { SharedFilesystem } from "../src/shared-fs";
import { SubprocessBroker } from "../src/subprocess-broker";
import { SubprocessHost } from "../src/subprocess";
import type { Engine, RunRequest } from "../src/worker";
import { startRun, type Run } from "../src/runner";
import { preview1SignalClockGuest } from "./engine-interruption-preview1";
import { createFilesystemIdentity } from "../../runtime/fs";
import { assertCausalIdleWake, assertNativeEngineCompletion, probeCell, probeLength, snapshotProbe, suppressBudgetNotifications } from "./engine-interruption-probe";
import { measureInterruptionOverhead } from "./engine-interruption-benchmark";
import { handledSignalGuest, idleSignalGuest } from "./engine-interruption-guests";
import { engineInterruptionTransport } from "./engine-interruption-transport";
import { createRuntimeEngineScope, type EngineInterruptionChild as Child, type EngineInterruptionRoute, type EngineInterruptionScope, type EngineSignalDelivery } from "./engine-interruption-scope";

const NativeWorker = globalThis.Worker;
const activeWorkers = new Set<ObservedWorker>();
const guestWorkers = new Map<number, ObservedWorker>();
let hooks = true;
let observeCheckpoints = true;
let idleWaitTimeoutMs = 0;
let instrumentPreview1Root = false;
class ObservedWorker extends NativeWorker {
  readonly probe = new Int32Array(new SharedArrayBuffer(probeLength * 4));
  deferStop = false;
  transport?: ReturnType<typeof engineInterruptionTransport>;
  readonly diagnostics: unknown[] = [];
  constructor(url: string | URL, options?: WorkerOptions) {
    const target = new URL(url, location.href);
    super(instrumentPreview1Root && target.pathname.endsWith("/worker.js")
      ? new URL("./engine-interruption-worker.js", target).href : url, options);
    activeWorkers.add(this);
    this.addEventListener("error", event => this.diagnostics.push({ error: event.message }));
    this.addEventListener("message", event => {
      if (["phase", "error", "exit"].includes(event.data?.type)) this.diagnostics.push(event.data);
    });
  }
  override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    if (message && typeof message === "object" && "module" in message && "engine" in message) {
      const request = message as RunRequest;
      this.deferStop = request.engine !== "browser" || request.adapter === "preview1";
      this.transport = engineInterruptionTransport(request);
      guestWorkers.set(request.child?.pid ?? request.pid!, this);
      message = { ...request, engineInterruption: { evidence: this.probe.buffer, hooks, observeCheckpoints, idleWaitTimeoutMs } };
    }
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
  override terminate(): void {
    Atomics.add(this.probe, probeCell.terminateRequests, 1);
    if (!this.deferStop) this.forceTerminate();
  }
  forceTerminate(): void { activeWorkers.delete(this); super.terminate(); }
}
// Install teardown before creating the filesystem or any guest worker. In particular,
// default-action tests deliberately suppress the supervisor's physical backstop.
globalThis.Worker = ObservedWorker;
let filesystem: SharedFilesystem | undefined;
const scopes = new Set<Awaited<ReturnType<typeof scope>>>();
let destroyed = false;
function destroy(): void {
  if (destroyed) return;
  destroyed = true;
  for (const owned of scopes) owned.dispose();
  filesystem?.dispose();
  for (const worker of activeWorkers) worker.forceTerminate();
  globalThis.Worker = NativeWorker;
}
addEventListener("pagehide", destroy, { once: true });
Object.assign(globalThis, { engineInterruptionHarness: { destroy } });
const watchdog = setTimeout(destroy, new URLSearchParams(location.search).has("benchmark") ? 480_000 : 180_000);
const decoder = new TextDecoder();
const checks: { engine: Engine; name: string; route?: EngineInterruptionRoute; delivery?: string; evidence: unknown; elapsedMs?: number }[] = [];
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 2));
function equal(actual: unknown, expected: unknown, label: string): void { if (actual !== expected) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }
function truth(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
async function until(condition: () => boolean, label: string | (() => string), timeout = 15_000): Promise<void> {
  const end = performance.now() + timeout;
  while (!condition()) { if (destroyed || performance.now() > end) throw new Error(`${typeof label === "function" ? label() : label} timed out`); await pause(); }
}
function assertDeferredHandledSignal(worker: ObservedWorker): void {
  const evidence = snapshotProbe(worker.probe);
  equal(evidence.handledSignal, 2, "event-loop mode0 call dequeued SIGINT after yield");
  truth(evidence.pendingPreservedBeforeLoopFinished > 0, "mode4 checkpoint preserved authoritative pending SIGINT during synchronous CPU work");
  equal(evidence.pendingLostAtCheckpoint, 0, "mode4 never consumes the shared pending bit");
  equal(evidence.handledBeforeLoopFinished, 0, "no mode0 dequeue before synchronous CPU work yields");
  equal(evidence.checkpointNonzero, 0, "mode4 is a non-dequeue fatal checkpoint");
}
function legacyScope(module: WebAssembly.Module, engine: Engine, adapter: "bun" | "preview1" = "bun"): EngineInterruptionScope {
  const fs = filesystem!;
  const workerName = engine === "browser" && adapter !== "preview1" ? "worker.js" : "engine-interruption-worker.js";
  const broker = new SubprocessBroker(new URL(`./${workerName}`, location.href).href, fs);
  broker.register("bun", { module, adapter, engine });
  const children = new Map<number, Child>();
  const host = new SubprocessHost({
    output() {}, onChildClose: pid => broker.close(1, pid),
    launch(meta, transport) {
      const identity = createFilesystemIdentity(fs.client.connection);
      children.set(transport.pid, { pid: transport.pid, jobId: transport.jobId,
        requestedSignal: new Int32Array(transport.requestedSignal), signalState: new Int32Array(transport.signalState), stdout: "", stderr: "" });
      broker.spawn({ executable: "bun", argv: meta.argv, pid: transport.pid, parentPid: transport.parentPid,
        jobId: transport.jobId, cwd: "/home/user", env: {}, filesystem: identity, child: transport,
        trace: false, slots: "imports", spawnBroker: true });
      return { revoke() { fs.revoke(identity); }, terminate() {} };
    },
  });
  return { broker, children,
    drain(child) {
      for (const fd of [1, 2]) for (;;) {
        const bytes = host.read(host.pipe(child.pid, fd));
        if (!(bytes instanceof Uint8Array)) break;
        if (fd === 1) child.stdout += decoder.decode(bytes); else child.stderr += decoder.decode(bytes);
      }
    },
    spawn(source) {
      const pid = host.spawn(JSON.stringify({ executable: "bun", argv: ["bun", "-e", source] }));
      truth(pid > 0, `spawn failed: ${pid}`);
      const child = children.get(pid); truth(child, "spawn transport missing"); return child;
    },
    wait: child => host.wait(child.pid),
    async kill(child, signal, delivery = "host") {
      if (delivery === "host") return host.kill(child.pid, signal);
      if (delivery === "page-killJob") await broker.killJob(child.jobId, signal);
      else await broker.kill(child.pid, signal);
      return 0;
    },
    dispose() { broker.dispose(); host.dispose(); },
  };
}
async function scope(module: WebAssembly.Module, engine: Engine, route: EngineInterruptionRoute = "legacy", adapter: "bun" | "preview1" = "bun") {
  const base = route === "runtimeProcess" ? await createRuntimeEngineScope(module, engine, filesystem!) : legacyScope(module, engine, adapter);
  const owned = { ...base,
    async ready(child: Child): Promise<ObservedWorker> {
      try { await until(() => { base.drain(child); return child.stderr.includes("ready\n"); }, "guest ready"); }
      catch (error) {
        base.drain(child);
        const worker = guestWorkers.get(child.pid);
        throw new Error(`${String(error)}; route=${route} stdout=${JSON.stringify(child.stdout)} stderr=${JSON.stringify(child.stderr)} status=${base.wait(child)} worker=${JSON.stringify(worker?.diagnostics)} probe=${JSON.stringify(worker && snapshotProbe(worker.probe))}`);
      }
      const worker = guestWorkers.get(child.pid); truth(worker, "guest worker not observed");
      equal(worker.transport?.route, route, "actual production request follows selected route");
      return worker;
    },
    async exit(child: Child, status: number): Promise<void> {
      await until(() => { base.drain(child); return base.wait(child) !== -2; }, `guest exit (${child.stderr})`);
      base.drain(child); equal(base.wait(child), status, `exit status (${child.stderr})`);
    },
    dispose(): void {
      base.dispose();
      // Logical broker state can forget a guest before its physical backstop runs.
      for (const child of base.children.values()) {
        const worker = guestWorkers.get(child.pid); worker?.forceTerminate(); guestWorkers.delete(child.pid);
      }
      scopes.delete(owned);
    },
  };
  scopes.add(owned); return owned;
}
async function testDefault(module: WebAssembly.Module, engine: Engine, signal: 2 | 15, nestedHandler = false, route: EngineInterruptionRoute = "legacy"): Promise<void> {
  const owned = await scope(module, engine, route);
  try {
    // fd 1 is buffered even through fs.writeSync; fd 2 is unbuffered here.
    const loop = `try { while (true) {} } catch (error) { fs.writeSync(2,'CATCH-RAN\\n'); } finally { fs.writeSync(2,'FINALLY-RAN\\n'); } fs.writeSync(2,'AFTER-RAN\\n');`;
    const child = owned.spawn(nestedHandler
      ? handledSignalGuest(true)
      : `const fs=require('node:fs'); fs.writeSync(2,'ready\\n'); ${loop}`);
    const worker = await owned.ready(child);
    // Let the synchronous readiness import return before signaling pure-JS work.
    // Default cases never yield; nested cases first finish finite CPU work, then
    // dispatch handled SIGINT on the event loop before entering the guarded loop.
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    equal(Atomics.load(worker.probe, probeCell.startLeft), 0, "guest is still executing before the signal");
    if (nestedHandler) {
      equal(await owned.kill(child, 2), 0, "initial handled SIGINT accepted");
      await until(() => { owned.drain(child); return child.stderr.includes("handler-ready\n"); }, "CPU loop entered registered SIGINT handler");
      equal(owned.wait(child), -2, "registered handler remains alive inside its nested CPU loop");
      assertDeferredHandledSignal(worker);
      equal(child.stderr, "ready\nloop-finished\nhandler-ready\n", "handler entered only after synchronous CPU work yielded");
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    const started = performance.now();
    equal(await owned.kill(child, signal), 0, "signal accepted");
    await owned.exit(child, 128 + signal);
    const result = await owned.broker.wait(child.pid);
    equal(result.kind, "signaled", "typed signal outcome"); equal(result.code, signal, "selected signal");
    if (engine === "browser") {
      await until(() => !activeWorkers.has(worker), "Bun light physical termination requested");
      truth(Atomics.load(worker.probe, probeCell.terminateRequests) > 0, "Bun light still calls native Worker.terminate");
    } else {
      await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1,
        () => `${engine} real _start unwind after signal ${signal}; evidence=${JSON.stringify(snapshotProbe(worker.probe))}`);
      const evidence = snapshotProbe(worker.probe);
      truth(evidence.checkpointAfterSignal > 0, "CPU-bound engine entered actual slot18 checkpoint after signal");
      equal(evidence.checkpointSignal, signal, "checkpoint observed selected signal");
      truth(evidence.checkpointThrew > 0, "host callback propagated terminal unwind");
      equal(evidence.checkpointNonzero, 0, "mode4 checkpoint does not dequeue handled signals");
      equal(evidence.startEntered, 1, "real _start called once"); equal(evidence.startLeft, 1, "real _start returned/unwound");
      equal(evidence.catchWrites, 0, "catch cannot attempt output after default action");
      equal(evidence.finallyWrites, 0, "finally cannot attempt output after default action");
      equal(evidence.afterWrites, 0, "code after default action cannot attempt output");
      truth(activeWorkers.has(worker), "proof obtained while native terminate remained disabled");
    }
    checks.push({ engine, route, delivery: route === "legacy" ? "host" : "page-kill",
      name: `${route === "runtimeProcess" ? "runtimeProcess-page-" : ""}${nestedHandler ? "nested-SIGINT-handler-" : ""}default-${signal}-status-${128 + signal}`,
      evidence: snapshotProbe(worker.probe), elapsedMs: performance.now() - started });
  } finally { owned.dispose(); }
}
async function testNativeInterrupt(module: WebAssembly.Module, engine: Engine): Promise<void> {
  const owned = await scope(module, engine);
  try {
    const child = owned.spawn(`const fs=require('node:fs'); fs.writeSync(2,'ready\\n'); try { while(true){} } catch(error) { fs.writeSync(2,'CATCH-RAN\\n'); } finally { fs.writeSync(2,'FINALLY-RAN\\n'); } fs.writeSync(2,'AFTER-RAN\\n');`);
    const worker = await owned.ready(child);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    equal(Atomics.load(worker.probe, probeCell.startLeft), 0, "native interrupt guest remains CPU-bound");
    Atomics.store(worker.probe, probeCell.nativeInterruptRequested, 1);
    await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1,
      () => `${engine} native true-return callback _start unwind; evidence=${JSON.stringify(snapshotProbe(worker.probe))}`);
    await until(() => { owned.drain(child); return owned.wait(child) !== -2; }, "native interrupt ordinary outcome");
    const result = await owned.broker.wait(child.pid);
    equal(result.kind, "exited", "native interrupt does not fabricate a selected fatal host outcome");
    equal(Atomics.load(child.requestedSignal, 0), 0, "no host signal was requested");
    const evidence = snapshotProbe(worker.probe);
    assertNativeEngineCompletion(evidence);
    if (evidence.startWasiExit) equal(evidence.startWasiExitCode, result.code, "typed WASI exit matches ordinary process outcome");
    equal(evidence.nativeInterruptInjected, 1, "exactly one real op4 negative response injected");
    equal(evidence.checkpointNonzero, 1, "actual callback returned one native termination request");
    truth(evidence.checkpointReturned > 0, "callback returned rather than throwing");
    equal(evidence.checkpointThrew, 0, "no checkpoint host exception caused native-path unwind");
    equal(evidence.startEntered, 1, "native path entered real _start once"); equal(evidence.startLeft, 1, "native engine left real _start");
    equal(evidence.catchWrites, 0, "interrupted frame catch did not run");
    equal(evidence.finallyWrites, 0, "interrupted frame finally did not run");
    equal(evidence.afterWrites, 0, "interrupted frame continuation did not run");
    truth(activeWorkers.has(worker), "native-path proof obtained without physical Worker.terminate");
    // This covers this interrupted frame, not a prohibition on future VM entries
    // used by runtime error reporting or cleanup after native termination.
    checks.push({ engine, route: "legacy", delivery: "native-callback", name: "native-interrupt-true-unwinds-current-frame", evidence: { ...evidence, outcome: result } });
  } finally { owned.dispose(); }
}
async function testHandled(module: WebAssembly.Module, engine: Engine, route: EngineInterruptionRoute = "legacy"): Promise<void> {
  const owned = await scope(module, engine, route);
  try {
    const child = owned.spawn(handledSignalGuest());
    const worker = await owned.ready(child);
    equal(Atomics.load(child.signalState, 2) & 3, 2, "handler registered before readiness");
    equal(await owned.kill(child, 2), 0, "handled SIGINT accepted");
    await owned.exit(child, 23);
    await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1, "handled loop returned from _start");
    const result = await owned.broker.wait(child.pid);
    equal(result.kind, "exited", "handler retains ordinary chosen exit"); equal(result.code, 23, "handler chosen status");
    equal(child.stdout, "continued 1 true\n", "ordinary continuation after queued handler");
    equal(child.stderr, "ready\nloop-finished\nhandled\n", "Node ordering: synchronous work finishes before handled callback");
    assertDeferredHandledSignal(worker);
    checks.push({ engine, route, delivery: route === "legacy" ? "host" : "page-kill",
      name: `${route === "runtimeProcess" ? "runtimeProcess-page-" : ""}handled-SIGINT-queued-until-yield-and-exits-23`, evidence: snapshotProbe(worker.probe) });
  } finally { owned.dispose(); }
}
async function testIdleHandled(module: WebAssembly.Module, engine: Engine, route: EngineInterruptionRoute = "legacy", pageDelivered = false): Promise<void> {
  async function runTrial(suppressNotify: boolean, delivery: EngineSignalDelivery) {
    const owned = await scope(module, engine, route);
    let mutation: ReturnType<typeof suppressBudgetNotifications> | undefined;
    try {
      const child = owned.spawn(idleSignalGuest);
      const worker = await owned.ready(child);
      equal(Atomics.load(child.signalState, 2) & 3, 2, "idle SIGINT handler registered");
      await until(() => Atomics.load(worker.probe, probeCell.idleWaiting) === 1, "guest entered stretched ordinary event-loop budget wait");
      const generation = Atomics.load(worker.probe, probeCell.idleWaitActiveGeneration);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      equal(Atomics.load(worker.probe, probeCell.idleWaitActiveGeneration), generation, "same long wait generation remains entered");
      equal(Atomics.load(worker.probe, probeCell.idleWaiting), 1, "idle wait is still entered immediately before kill");
      Atomics.store(worker.probe, probeCell.idleWaitSampleGeneration, generation);
      if (suppressNotify) mutation = suppressBudgetNotifications(worker.transport!.waitWord);
      const started = performance.now();
      equal(await owned.kill(child, 2, delivery), 0, "idle handled SIGINT accepted");
      await until(() => { owned.drain(child); return child.stderr.includes("idle-handled\n"); }, "idle event-loop dispatched SIGINT");
      const handlerLatencyMs = performance.now() - started;
      await owned.exit(child, 23);
      await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1, "idle handler guest _start returned");
      const result = await owned.broker.wait(child.pid);
      equal(result.kind, "exited", "idle handler retains ordinary exit"); equal(result.code, 23, "idle chosen status");
      equal(child.stderr, "ready\nidle-handled\n", "idle handler output");
      const evidence = snapshotProbe(worker.probe);
      equal(evidence.handledSignal, 2, "idle event loop dequeued authoritative pending SIGINT with mode0");
      equal(Atomics.load(child.signalState, 2) & 4, 0, "idle event loop cleared shared pending bit");
      equal(evidence.checkpointNonzero, 0, "idle mode4 checkpoint never dequeues");
      let causalRejection: string | undefined;
      if (suppressNotify) {
        truth(mutation!.count() > 0, "negative control actually suppressed process-budget notification");
        try { assertCausalIdleWake(evidence, generation); } catch (error) { causalRejection = String(error); }
        truth(causalRejection, "notify-removal mutant must fail the identical positive causal-wake admission");
        equal(evidence.idleWaitSampleCompleted, generation, "negative control completed sampled native wait");
        equal(evidence.idleWaitSampleResult, 2, "notify-removal mutant timed out rather than receiving native ok");
        truth(handlerLatencyMs >= 250, "removed notify must not hide behind production4ms timeout");
      } else assertCausalIdleWake(evidence, generation);
      return { delivery, handlerLatencyMs, generation, suppressedNotifications: mutation?.count() ?? 0, causalRejection, evidence };
    } finally { mutation?.restore(); owned.dispose(); }
  }
  // Only idle test workers receive this long timeout. Production scheduling and
  // all other waits remain unchanged; CPU benchmark interception stays disabled.
  idleWaitTimeoutMs = 1_000;
  try {
    const deliveries: EngineSignalDelivery[] = pageDelivered ? ["page-kill", "page-killJob"] : ["host"];
    const negativeControls: Awaited<ReturnType<typeof runTrial>>[] = [];
    const trials: (Awaited<ReturnType<typeof runTrial>> & { warmup: boolean })[] = [];
    for (const delivery of deliveries) {
      negativeControls.push(await runTrial(true, delivery));
      for (let trial = 0; trial < 8; trial++) trials.push({ warmup: trial === 0, ...await runTrial(false, delivery) });
    }
    const times = trials.filter(trial => !trial.warmup).map(trial => trial.handlerLatencyMs);
    times.sort((a, b) => a - b);
    const medianMs = times[Math.floor(times.length / 2)]!, maxMs = times[times.length - 1]!;
    const enforceLatency = new URLSearchParams(location.search).has("benchmark");
    checks.push({ engine, route, delivery: deliveries.join("+"),
      name: `${pageDelivered ? `${route}-page-kill-and-killJob-` : ""}idle-handled-SIGINT-notifies-blocked-generation-and-exits-23`, evidence: {
      nativeWaitTimeoutMs: 1_000, warmupTrials: deliveries.length, measuredTrials: 7 * deliveries.length, medianMs, maxMs,
      medianBudgetMs: 10, maxBudgetMs: 50, latencyGateEnforced: enforceLatency, negativeControl: negativeControls[0], negativeControls, trials,
      method: `${route}/${deliveries.join("+")} to unbuffered handler stderr, drained every2ms; idle-only native process-budget wait stretched to1s; exact sampled generation must return native ok; notify-removal negative control must time out and fail identical causal admission; pending-state dequeue remains separate from wake generation`,
    } });
    if (enforceLatency) {
      truth(medianMs < 10, `${engine} idle SIGINT median ${medianMs}ms must be <10ms on a quiet benchmark host`);
      truth(maxMs < 50, `${engine} idle SIGINT max ${maxMs}ms must be <50ms on a quiet benchmark host`);
    }
  } finally { idleWaitTimeoutMs = 0; }
}
async function testPreview1Clock(root: boolean): Promise<void> {
  const module = new WebAssembly.Module(preview1SignalClockGuest());
  async function runTrial(suppressNotify: boolean) {
    let owned: Awaited<ReturnType<typeof scope>> | undefined;
    let run: Run | undefined;
    let rootSettled = false;
    let worker: ObservedWorker | undefined;
    let mutation: ReturnType<typeof suppressBudgetNotifications> | undefined;
    let child: Child | undefined;
    let stdout = "", stderr = "";
    try {
      if (root) {
        instrumentPreview1Root = true;
        try {
          run = startRun({ engine: "browser", adapter: "preview1", module, args: [], env: { PWD: "/home/user" },
            filesystem: filesystem!, moduleScope: false }, {
            stdout(bytes) { stdout += decoder.decode(bytes); }, stderr(bytes) { stderr += decoder.decode(bytes); },
          });
        } finally { instrumentPreview1Root = false; }
        void run.done.then(() => { rootSettled = true; });
        await until(() => stderr.includes("ready\n"), "actual legacy Preview1 root ready");
        worker = guestWorkers.get(1);
      } else {
        owned = await scope(module, "browser", "legacy", "preview1");
        child = owned.spawn(""); worker = await owned.ready(child);
      }
      truth(worker, "actual Preview1 production worker observed");
      const observed = worker;
      equal(observed.transport?.route, "legacy", "signal-only imports retain legacy route");
      await until(() => Atomics.load(observed.probe, probeCell.idleWaiting) === 1, "Preview1 clock entered actual shared interrupt wait");
      const generation = Atomics.load(observed.probe, probeCell.idleWaitActiveGeneration);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      equal(Atomics.load(observed.probe, probeCell.idleWaitActiveGeneration), generation, "same Preview1 clock wait remains entered");
      equal(Atomics.load(observed.probe, probeCell.idleWaiting), 1, "Preview1 clock is blocked before page kill");
      Atomics.store(observed.probe, probeCell.idleWaitSampleGeneration, generation);
      if (suppressNotify) mutation = suppressBudgetNotifications(observed.transport!.waitWord);
      const started = performance.now();
      if (root) run!.kill(2); else equal(await owned!.kill(child!, 2, "page-kill"), 0, "page Preview1 SIGINT accepted");
      await until(() => {
        if (!root) { owned!.drain(child!); stdout = child!.stdout; stderr = child!.stderr; }
        return stderr.includes("poll-eintr\n");
      }, "Preview1 poll_oneoff returned EINTR and dequeued SIGINT");
      const latencyMs = performance.now() - started;
      if (root) {
        const result = await run!.done; equal(result.error, undefined, "Preview1 root did not crash");
        equal(result.code, 23, "Preview1 root ordinary exit");
      } else { await owned!.exit(child!, 23); owned!.drain(child!); stdout = child!.stdout; stderr = child!.stderr; }
      await until(() => Atomics.load(observed.probe, probeCell.runReturned) === 1, "Preview1 actual _start returned");
      equal(stdout, "", "Preview1 stdout is empty");
      equal(stderr, "ready\npoll-eintr\npoll-clean\n", "EINTR, authoritative dequeue and final nonsticky clock wait");
      equal(Atomics.load(observed.transport!.signalState, 2) & 4, 0, "Preview1 pending bit consumed only by interrupted");
      const evidence = snapshotProbe(observed.probe);
      assertNativeEngineCompletion(evidence);
      let causalRejection: string | undefined;
      if (suppressNotify) {
        truth(mutation!.count() > 0, "Preview1 mutant suppressed exact interrupt notification");
        try { assertCausalIdleWake(evidence, generation); } catch (error) { causalRejection = String(error); }
        truth(causalRejection, "Preview1 notify-removal mutant fails identical causal admission");
        equal(evidence.idleWaitSampleResult, 2, "Preview1 notify-removal native wait timed out");
        truth(latencyMs >= 250, "Preview1 removed notify cannot hide behind short rescan");
      } else {
        assertCausalIdleWake(evidence, generation);
        if (new URLSearchParams(location.search).has("benchmark")) truth(latencyMs < 50, "Preview1 page signal must wake clock promptly");
      }
      return { root, latencyMs, generation, suppressedNotifications: mutation?.count() ?? 0, causalRejection, evidence };
    } finally {
      instrumentPreview1Root = false; mutation?.restore();
      if (run && !rootSettled) run.kill(9);
      owned?.dispose();
      if (root) { (worker ?? guestWorkers.get(1))?.forceTerminate(); guestWorkers.delete(1); }
    }
  }
  idleWaitTimeoutMs = 1_000;
  try {
    const negativeControl = await runTrial(true), positive = await runTrial(false);
    checks.push({ engine: "browser", route: "legacy", delivery: root ? "real-startRun-killJob" : "page-kill",
      name: `legacy-preview1-${root ? "root" : "child"}-clock-EINTR-dequeue-and-nonsticky-wait`,
      evidence: { nativeWaitTimeoutMs: 1_000, negativeControl, positive } });
  } finally { idleWaitTimeoutMs = 0; }
}
async function benchmark(module: WebAssembly.Module, engine: Engine, pristine?: WebAssembly.Module): Promise<object> {
  // Correctness cases observe real callbacks. Do NOT add per-checkpoint Atomics,
  // decoder or proxy work to the timed production import path.
  observeCheckpoints = false;
  try {
    const result = await measureInterruptionOverhead(async (mode, source) => {
      hooks = mode !== "candidate-masked";
      const owned = await scope(mode === "pristine" ? pristine! : module, engine);
      try {
        const child = owned.spawn(source);
        await owned.exit(child, 0);
        const worker = guestWorkers.get(child.pid); truth(worker, "benchmark worker missing");
        await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1, "benchmark _start returned");
        const match = /BENCH (\d+) (\d+)/.exec(child.stdout); truth(match, `benchmark output: ${child.stdout} ${child.stderr}`);
        equal(Atomics.load(worker.probe, probeCell.slotMasked), hooks ? 0 : 1, "disabled baseline masks optional signal slot before _start");
        return { milliseconds: Number(match[1]), checksum: Number(match[2]) };
      } finally { owned.dispose(); }
    }, Boolean(pristine));
    return { engine, ...result };
  } finally { hooks = true; observeCheckpoints = true; }
}

void (async () => {
  const benchmarks: unknown[] = [];
  const artifacts: { engine: Engine; name: string; sha256: string }[] = [];
  try {
    truth(crossOriginIsolated, "engine interruption requires cross-origin isolation");
    filesystem = new SharedFilesystem();
    await filesystem.mkdirp("/home/user"); await filesystem.flush();
    for (const [engine, name] of [["quickjs", "bun.wasm"], ["jsc", "bun-jsc.wasm"], ["browser", "bun-browser.wasm"]] as const) {
      const response = await fetch(`/${name}`); truth(response.ok, `fresh artifact ${name}: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      artifacts.push({ engine, name, sha256: hash });
      const module = await WebAssembly.compile(bytes);
      const boot = await scope(module, engine);
      try {
        const child = boot.spawn("require('node:fs').writeSync(2,'boot\\n');");
        await boot.exit(child, 0);
        equal(child.stderr, "boot\n", `${engine} guest bootstrap`);
      } finally { boot.dispose(); }
      await testDefault(module, engine, 2); await testDefault(module, engine, 15);
      if (engine !== "browser") {
        await testNativeInterrupt(module, engine);
        await testHandled(module, engine);
        await testDefault(module, engine, 15, true);
        await testIdleHandled(module, engine);
        await testDefault(module, engine, 2, false, "runtimeProcess");
        await testDefault(module, engine, 15, false, "runtimeProcess");
        await testHandled(module, engine, "runtimeProcess");
        await testDefault(module, engine, 15, true, "runtimeProcess");
        await testIdleHandled(module, engine, "legacy", true);
        await testIdleHandled(module, engine, "runtimeProcess", true);
        const query = new URLSearchParams(location.search);
        if (query.has("benchmark")) {
          let pristine: WebAssembly.Module | undefined, pristineSha256: string | undefined;
          if (query.has("baseline")) {
            const response = await fetch(`/baseline/${name}`); truth(response.ok, `pristine baseline ${name}: HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            pristineSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
            truth(pristineSha256 !== hash, "pristine baseline must not reuse candidate bytes");
            pristine = await WebAssembly.compile(bytes);
          }
          benchmarks.push({ wasmSha256: hash, pristineSha256, ...await benchmark(module, engine, pristine) });
        }
      }
    }
    await testPreview1Clock(true); await testPreview1Clock(false);
    destroy();
    equal(activeWorkers.size, 0, "all test-owned workers, including stuck guests, terminated");
    Object.assign(globalThis, { engineInterruptionResult: { ok: true, artifacts, checks, benchmarks, cleanup: { activeWorkers: activeWorkers.size } } });
  } catch (error) {
    destroy();
    Object.assign(globalThis, { engineInterruptionResult: { ok: false, artifacts, checks, benchmarks, error: error instanceof Error ? error.stack : String(error), cleanup: { activeWorkers: activeWorkers.size } } });
  } finally { clearTimeout(watchdog); }
})();
