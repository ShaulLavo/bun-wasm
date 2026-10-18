import { WasiExit } from "waffle/core";
import { ProcessSignalExit } from "waffle/proc/abi";
import { RuntimeWorkerSignal } from "waffle/browser/worker";

// Test-only evidence shared between the page and the instrumented guest worker.
// Counts come from real WASI imports / _start, never the supervisor's logical exit.
export const probeCell = {
  checkpoints: 0,
  checkpointAfterSignal: 1,
  checkpointReturned: 2,
  checkpointThrew: 3,
  checkpointSignal: 4,
  handledSignal: 5,
  startEntered: 6,
  startLeft: 7,
  runReturned: 8,
  terminateRequests: 9,
  catchWrites: 10,
  finallyWrites: 11,
  afterWrites: 12,
  slotMasked: 13,
  writes: 14,
  readyWrites: 15,
  lastHostSlot: 16,
  loopFinishedWrites: 17,
  handledBeforeLoopFinished: 18,
  pendingPreservedBeforeLoopFinished: 19,
  pendingLostAtCheckpoint: 20,
  checkpointNonzero: 21,
  idleWaitEntries: 22,
  idleWaiting: 23,
  idleWaitReturns: 24,
  idleWaitBlocked: 25,
  idleWaitOk: 26,
  idleWaitTimedOut: 27,
  idleWaitNotEqual: 28,
  idleWaitActiveGeneration: 29,
  idleWaitSampleGeneration: 30,
  idleWaitSampleResult: 31,
  idleWaitSampleCompleted: 32,
  nativeInterruptRequested: 33,
  nativeInterruptInjected: 34,
  startNormalReturn: 35,
  startWasiExit: 36,
  startOtherException: 37,
  startWasiExitCode: 38,
  checkpointFatalSignal: 39,
  startFatalSignal: 40,
  processPollCalls: 41,
  processPollThrows: 42,
} as const;
export const probeLength = 43;
export interface EngineInterruptionOptions { evidence: SharedArrayBuffer; hooks: boolean; observeCheckpoints: boolean; idleWaitTimeoutMs: number; }

export function snapshotProbe(probe: Int32Array): Record<keyof typeof probeCell, number> {
  return Object.fromEntries(Object.entries(probeCell).map(([key, index]) => [key, Atomics.load(probe, index)])) as Record<keyof typeof probeCell, number>;
}

export function engineInterruptionFailure(label: string, error: unknown, diagnostics: () => unknown): Error {
  let context: unknown;
  try { context = diagnostics(); }
  catch (diagnosticError) { context = { diagnosticError: String(diagnosticError) }; }
  return new Error(`${label}: ${String(error)}; diagnostics=${JSON.stringify(context)}`, { cause: error });
}

/** Decorate only the guest's actual imported WASI functions, preserving their behavior. */
export function observeEngineImports(imports: WebAssembly.Imports, probe: Int32Array,
  memory: () => WebAssembly.Memory, signalState: Int32Array, observeCheckpoints = true): void {
  const wasi = imports.wasi_snapshot_preview1;
  if (!wasi) throw new Error("engine interruption guest has no preview1 imports");
  const process = imports.runtime_proc;
  const signal = process?.signal;
  if (typeof signal !== "function") throw new Error("engine interruption guest has no runtime_proc.signal import");
  if (observeCheckpoints) process!.signal = (number: number, mode: number) => {
    const checkpoint = number === 0 && mode === 4, dequeue = number === 0 && mode === 0;
    if (!checkpoint && !dequeue) return signal(number, mode);
    // A generic transport keeps requestedSignal as a sticky wake hint after a handled
    // signal is dequeued. Scan the authoritative per-signal pending cells instead, so a
    // mode-4 checkpoint cannot mistake an old request for a live pending delivery.
    let pendingBefore = 0;
    if (checkpoint && Atomics.load(probe, probeCell.loopFinishedWrites) === 0) {
      for (let candidate = 1; candidate <= 64; candidate++) {
        if (Atomics.load(signalState, candidate) & 4) { pendingBefore = candidate; break; }
      }
    }
    const signalBefore = checkpoint ? pendingBefore : 0;
    if (checkpoint) {
      Atomics.add(probe, probeCell.checkpoints, 1);
      if (signalBefore) Atomics.add(probe, probeCell.checkpointAfterSignal, 1);
    }
    try {
      let delivered: number;
      if (checkpoint && Atomics.compareExchange(probe, probeCell.nativeInterruptRequested, 1, 0) === 1) {
        // Return the actual direct ABI negative response. No host call, fabricated outcome
        // or throwing callback may be responsible for this native-engine unwind proof.
        delivered = -1;
        Atomics.add(probe, probeCell.nativeInterruptInjected, 1);
      } else delivered = signal(number, mode) as number;
      if (checkpoint) {
        Atomics.add(probe, probeCell.checkpointReturned, 1);
        if (signalBefore) Atomics.store(probe, probeCell.checkpointSignal, signalBefore);
        if (delivered !== 0) Atomics.add(probe, probeCell.checkpointNonzero, 1);
        if (pendingBefore) Atomics.add(probe, Atomics.load(signalState, 2) & 4
          ? probeCell.pendingPreservedBeforeLoopFinished : probeCell.pendingLostAtCheckpoint, 1);
      } else if (delivered > 0) {
        Atomics.store(probe, probeCell.handledSignal, delivered);
        if (Atomics.load(probe, probeCell.loopFinishedWrites) === 0) Atomics.add(probe, probeCell.handledBeforeLoopFinished, 1);
      }
      return delivered;
    } catch (error) {
      if (checkpoint) {
        Atomics.add(probe, probeCell.checkpointThrew, 1);
        // Only a production terminal exception identifies this fatal checkpoint; a
        // selected outcome cannot promote a coincidental RuntimeError into evidence.
        if (error instanceof RuntimeWorkerSignal || error instanceof ProcessSignalExit) {
          if (!signalBefore) Atomics.add(probe, probeCell.checkpointAfterSignal, 1);
          Atomics.store(probe, probeCell.checkpointSignal, error.signal);
          Atomics.store(probe, probeCell.checkpointFatalSignal, error.signal);
        }
      }
      throw error;
    }
  };
  const write = wasi.fd_write;
  if (typeof write !== "function") throw new Error("engine interruption guest has no fd_write import");
  const decoder = new TextDecoder();
  const markers = [["ready", probeCell.readyWrites], ["loop-finished", probeCell.loopFinishedWrites],
    ["CATCH-RAN", probeCell.catchWrites], ["FINALLY-RAN", probeCell.finallyWrites], ["AFTER-RAN", probeCell.afterWrites]] as const;
  // Raw diagnostics can quote the source containing marker literals. Match complete
  // output records, carrying only possible marker prefixes across calls per fd.
  // A non-matching line stays ignored until newline; arbitrarily long source
  // excerpts therefore cannot grow this state or reset into a mid-line marker.
  const partialLines = new Map<number, string | null>();
  wasi.fd_write = (fd: number, vectors: number, count: number, written: number) => {
    // Observe attempts BEFORE the real import rejects a revoked guest. Otherwise the
    // supervisor's closed pipe could conceal an incorrectly executed catch/finally.
    if (fd === 1 || fd === 2) {
      const buffer = memory().buffer, view = new DataView(buffer);
      let text = "";
      for (let index = 0; index < count; index++) {
        const pointer = view.getUint32(vectors + index * 8, true);
        const length = view.getUint32(vectors + index * 8 + 4, true);
        // Chromium's TextDecoder rejects resizable WASM buffers. The fixed owned
        // byte copy is a decoder representation requirement, not a guest-memory view.
        text += decoder.decode(new Uint8Array(buffer, pointer, length).slice(), { stream: true });
      }
      text += decoder.decode();
      Atomics.add(probe, probeCell.writes, 1);
      const previousLine = partialLines.get(fd);
      let line: string | null = previousLine === undefined ? "" : previousLine;
      for (const character of text) {
        if (character === "\n") {
          const cell = markers.find(([marker]) => marker === line)?.[1];
          if (cell !== undefined) Atomics.add(probe, cell, 1);
          line = "";
        } else if (line !== null) {
          const next: string = line + character;
          line = markers.some(([marker]) => marker.startsWith(next)) ? next : null;
        }
      }
      partialLines.set(fd, line);
    }
    return write(fd, vectors, count, written);
  };
}

/** Test-only idle proof; never installed in timed CPU overhead runs. */
export function observeEventLoopWait(probe: Int32Array, word: Int32Array,
  target: Pick<typeof Atomics, "wait"> = Atomics, timeoutOverrideMs = 0): () => void {
  const native = target.wait;
  target.wait = (array, index, value, timeout) => {
    const observed = array.buffer === word.buffer && array.byteOffset + index * array.BYTES_PER_ELEMENT === word.byteOffset
      && (timeout === undefined || timeout > 0);
    if (!observed) return Reflect.apply(native, target, [array, index, value, timeout]);
    const generation = Atomics.add(probe, probeCell.idleWaitEntries, 1) + 1;
    Atomics.store(probe, probeCell.idleWaitActiveGeneration, generation);
    Atomics.store(probe, probeCell.idleWaiting, 1);
    try {
      const result = Reflect.apply(native, target, [array, index, value, timeoutOverrideMs || timeout]);
      Atomics.add(probe, probeCell.idleWaitReturns, 1);
      // not-equal never slept: it cannot substantiate actual native blocking.
      if (result === "ok" || result === "timed-out") Atomics.add(probe, probeCell.idleWaitBlocked, 1);
      if (result === "ok") Atomics.add(probe, probeCell.idleWaitOk, 1);
      else if (result === "timed-out") Atomics.add(probe, probeCell.idleWaitTimedOut, 1);
      else if (result === "not-equal") Atomics.add(probe, probeCell.idleWaitNotEqual, 1);
      if (Atomics.load(probe, probeCell.idleWaitSampleGeneration) === generation) {
        Atomics.store(probe, probeCell.idleWaitSampleResult, result === "ok" ? 1 : result === "timed-out" ? 2 : 3);
        Atomics.store(probe, probeCell.idleWaitSampleCompleted, generation);
      }
      return result;
    } finally { Atomics.store(probe, probeCell.idleWaiting, 0); Atomics.store(probe, probeCell.idleWaitActiveGeneration, 0); }
  };
  return () => { target.wait = native; };
}

export function assertFatalEngineCompletion(evidence: ReturnType<typeof snapshotProbe>, signal: number): void {
  if (signal <= 0 || evidence.checkpointFatalSignal !== signal || evidence.startFatalSignal !== signal
    || evidence.checkpointThrew !== 1 || evidence.startOtherException !== 1
    || evidence.startNormalReturn !== 0 || evidence.startWasiExit !== 0) {
    throw new Error(`default signal completion requires matching typed fatal checkpoint and _start throws: expected=${signal}, checkpoint=${evidence.checkpointFatalSignal}, start=${evidence.startFatalSignal}, threw=${evidence.checkpointThrew}, other=${evidence.startOtherException}, normal=${evidence.startNormalReturn}, wasi=${evidence.startWasiExit}`);
  }
}

export function assertNativeEngineCompletion(evidence: ReturnType<typeof snapshotProbe>): void {
  if (evidence.startOtherException !== 0 || evidence.startNormalReturn + evidence.startWasiExit !== 1) {
    throw new Error(`native engine completion used an unexpected exception or missing normal/typed WASI exit: normal=${evidence.startNormalReturn}, wasi=${evidence.startWasiExit}, other=${evidence.startOtherException}`);
  }
}

export function assertCausalIdleWake(evidence: ReturnType<typeof snapshotProbe>, generation: number): void {
  if (evidence.idleWaitSampleCompleted !== generation || evidence.idleWaitSampleResult !== 1) {
    throw new Error(`sampled idle wait generation ${generation} did not return native ok: completed=${evidence.idleWaitSampleCompleted}, result=${evidence.idleWaitSampleResult}`);
  }
}

/** Mutation control: suppress only this exact shared wait-cell address. */
export function suppressBudgetNotifications(word: Int32Array,
  target: Pick<typeof Atomics, "notify"> = Atomics): { count(): number; restore(): void } {
  const native = target.notify;
  let suppressed = 0;
  target.notify = (array, index, count) => {
    if (array.buffer === word.buffer && array.byteOffset + index * array.BYTES_PER_ELEMENT === word.byteOffset) { suppressed++; return 0; }
    return Reflect.apply(native, target, [array, index, count]);
  };
  return { count: () => suppressed, restore() { target.notify = native; } };
}

/** Called after production slot installation, immediately before the real _start. */
export function observedEngineStart(exports: WebAssembly.Exports, probe: Int32Array, hooks: boolean): () => unknown {
  if (typeof exports._start !== "function") throw new Error("guest has no _start");
  const start = exports._start;
  return () => {
    if (!hooks) throw new Error("No hook-disabled baseline: the guest installs its runtime_proc engine callback unconditionally; masking a removed Bun slot or returning zero from the import cannot disable that callback");
    Atomics.add(probe, probeCell.startEntered, 1);
    try {
      const result = start();
      Atomics.add(probe, probeCell.startNormalReturn, 1);
      return result;
    } catch (error) {
      if (error instanceof WasiExit) {
        Atomics.add(probe, probeCell.startWasiExit, 1);
        Atomics.store(probe, probeCell.startWasiExitCode, error.code);
      } else {
        // Keep typed fatal throws in "other" so native true-return admission
        // remains strict; default-fatal admission additionally checks their type.
        Atomics.add(probe, probeCell.startOtherException, 1);
        if (error instanceof RuntimeWorkerSignal || error instanceof ProcessSignalExit) {
          Atomics.store(probe, probeCell.startFatalSignal, error.signal);
        }
      }
      throw error;
    } finally { Atomics.add(probe, probeCell.startLeft, 1); }
  };
}
