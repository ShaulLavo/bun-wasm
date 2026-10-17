import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { createFilesystemIdentity, revokeFilesystem } from "../../runtime/fs";
import { outcomeWord } from "../../runtime/proc/outcome";
import { createSignalState, setSignalDisposition, SIGNAL_PENDING } from "../../runtime/proc/signals";
import { createWorkerProcessTransport, workerProcessState } from "../../runtime/proc/worker-client";
import { SubprocessBroker } from "../src/subprocess-broker";
import { createProcessBudget } from "../src/subprocess";
import type { SharedFilesystem } from "../src/shared-fs";

type Mode = "legacy" | "generic-host" | "generic-poll";
async function proveWake(mode: Mode, operation: "kill" | "killJob", suppressNotify: boolean) {
  // This run owns one worker, one delivery timer, and its broker. Teardown is installed before spawn;
  // shared words are test-local and have no external owner or persistent backing.
  const budget = createProcessBudget();
  const transport = createWorkerProcessTransport({ capacity: 2 });
  transport.data = { filesystem: createFilesystemIdentity() };
  const state = workerProcessState(transport);
  const signals = mode === "legacy" ? { signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)),
    requestedSignal: new Int32Array(new SharedArrayBuffer(4)), outcome: outcomeWord() } : state.signals;
  const filesystem = { revoke: revokeFilesystem, reap() {}, client: { sweep() {} } } as unknown as SharedFilesystem;
  const broker = new SubprocessBroker("http://localhost/worker.js", filesystem, { budget,
    root: mode === "legacy" ? { pid: 1, job: 1, ...signals } : undefined });
  const selected = mode === "generic-poll" ? state.wake : new Int32Array(budget, 4, 1);
  const before = Atomics.load(selected, 0);
  const nativeNotify = Atomics.notify;
  let worker: Worker | undefined, deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  let sampledGeneration = 0, suppressed = 0;
  try {
    if (mode !== "legacy") await broker.adoptRuntimeRoot(transport);
    setSignalDisposition(signals.signalState, 2, 2);
    if (suppressNotify) Atomics.notify = ((word: Int32Array, index: number, count?: number) => {
      if (word.buffer === selected.buffer && word.byteOffset + index * 4 === selected.byteOffset) { suppressed++; return 0; }
      return nativeNotify(word, index, count);
    }) as typeof Atomics.notify;
    const result = await new Promise<{ generation: number; result: string; pending: number; interrupt: number; sequence: number }>((resolve, reject) => {
      worker = new Worker(new URL("./fixtures/signal-wake-worker.ts", import.meta.url), { workerData: { mode, budget, signals, wake: state.wake } });
      worker.on("error", reject);
      worker.on("exit", code => { if (code !== 0) reject(new Error(`signal wait worker exited ${code}`)); });
      worker.on("message", message => {
        if (message.phase === "waiting" && !deliveryTimer) {
          sampledGeneration = message.generation;
          deliveryTimer = setTimeout(() => {
            const delivered = operation === "kill" ? broker.kill(1, 2) : broker.killJob(1, 2);
            void delivered.catch(reject);
          }, 20);
        } else if (message.phase === "done") resolve(message);
      });
    });
    expect(result.generation).toBe(sampledGeneration);
    expect(result.pending & SIGNAL_PENDING).toBe(SIGNAL_PENDING);
    expect(result.interrupt).toBe(2);
    // Same sampled native wait, not a subsequent timeout rescan or a pre-wait not-equal race.
    expect(result.result).toBe(suppressNotify ? "timed-out" : "ok");
    expect(result.sequence).toBeGreaterThan(before);
    if (suppressNotify) expect(suppressed).toBeGreaterThan(0);
  } finally {
    Atomics.notify = nativeNotify;
    if (deliveryTimer) clearTimeout(deliveryTimer);
    if (worker) await worker.terminate();
    broker.dispose();
  }
}

for (const mode of ["legacy", "generic-host", "generic-poll"] as const) {
  for (const operation of ["kill", "killJob"] as const) {
    test(`${mode} page ${operation} wakes the sampled production wait`, () => proveWake(mode, operation, false));
    test(`${mode} page ${operation} loses causal wake when only its notify is removed`, () => proveWake(mode, operation, true));
  }
}
