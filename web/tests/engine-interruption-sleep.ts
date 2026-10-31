import { probeCell, type snapshotProbe } from "./engine-interruption-probe";

export const sleepSyncDurationMs = 1_000;
// A 1 s sleep needs about 100 of the service's bounded 10 ms waits. Leave ample
// headroom for spurious wakes and scheduling, but reject a pending-signal poll spin.
export const sleepSyncActivityLimit = 512;

/** These sources run in the real Bun worker; unit tests do not emulate Bun.sleepSync. */
export function sleepSyncSignalGuest(handled: boolean): string {
  const prelude = "const fs=require('node:fs');";
  if (handled) return prelude + `
    let handled=0;
    process.on('SIGUSR1',()=>{handled++;fs.writeSync(2,'sigusr1-handled\\n');});
    fs.writeSync(2,'ready\\nsleep-entered\\n');
    const started=Date.now();
    Bun.sleepSync(${sleepSyncDurationMs});
    fs.writeSync(2,'sleep-done '+(Date.now()-started)+' '+handled+'\\n');
    setImmediate(()=>fs.writeSync(2,'after-pump '+handled+'\\n'));`;
  return prelude + `
    try {
      fs.writeSync(2,'ready\\nsleep-entered\\n');
      Bun.sleepSync(${sleepSyncDurationMs});
      fs.writeSync(2,'after-sleep\\n');
    } catch(error) { fs.writeSync(2,'CATCH-RAN\\n'); }
    finally { fs.writeSync(2,'FINALLY-RAN\\n'); }
    fs.writeSync(2,'AFTER-RAN\\n');`;
}

/** Observe the production imported poll, including calls that return without ever
 * waiting. Counting native waits alone cannot reject the handled-pending spin. */
export function observeProcessPoll(imports: WebAssembly.Imports, probe: Int32Array): void {
  const process = imports.runtime_proc;
  const poll = process?.poll;
  if (typeof poll !== "function") throw new Error("sleepSync proof requires the production runtime_proc.poll import");
  process!.poll = (pointer: number, count: number, timeout: number, output: number) => {
    Atomics.add(probe, probeCell.processPollCalls, 1);
    try { return poll(pointer, count, timeout, output); }
    catch (error) { Atomics.add(probe, probeCell.processPollThrows, 1); throw error; }
  };
}

type Evidence = ReturnType<typeof snapshotProbe>;
function boundedActivity(evidence: Evidence): void {
  if (evidence.processPollCalls <= 0 || evidence.processPollCalls >= sleepSyncActivityLimit
    || evidence.idleWaitEntries <= 0 || evidence.idleWaitEntries >= sleepSyncActivityLimit
    || evidence.idleWaitBlocked <= 0) {
    throw new Error(`sleepSync must block with bounded production poll/wait activity: polls=${evidence.processPollCalls}, waits=${evidence.idleWaitEntries}, blocked=${evidence.idleWaitBlocked}`);
  }
}

export function assertHandledSleepSync(stderr: string, evidence: Evidence): number {
  const match = /^ready\nsleep-entered\nsleep-done (\d+) 0\nsigusr1-handled\nafter-pump 1\n$/.exec(stderr);
  if (!match) throw new Error(`sleepSync must preserve exactly one SIGUSR1 callback until after synchronous sleep: ${JSON.stringify(stderr)}`);
  const elapsed = Number(match[1]);
  // Allow only clock quantization, not a shortened sleep. The wide upper bound
  // tolerates a scheduled-away browser without hiding an early handled return.
  if (elapsed < sleepSyncDurationMs - 10 || elapsed > 5 * sleepSyncDurationMs) {
    throw new Error(`sleepSync duration was not preserved: ${elapsed}ms`);
  }
  boundedActivity(evidence);
  if (evidence.runReturned !== 1 || evidence.startLeft !== 1 || evidence.startNormalReturn + evidence.startWasiExit !== 1
    || evidence.startOtherException !== 0 || evidence.processPollThrows !== 0) {
    throw new Error("handled sleepSync must complete the actual _start normally");
  }
  return elapsed;
}

export function assertFatalSleepSync(stderr: string, evidence: Evidence): void {
  if (stderr !== "ready\nsleep-entered\n" || evidence.catchWrites !== 0
    || evidence.finallyWrites !== 0 || evidence.afterWrites !== 0) {
    throw new Error(`default SIGUSR1 must not return from sleepSync or enter catch/finally: ${JSON.stringify(stderr)}`);
  }
  boundedActivity(evidence);
  if (evidence.processPollThrows !== 1 || evidence.startFatalSignal !== 10
    || evidence.startOtherException !== 1 || evidence.startNormalReturn !== 0
    || evidence.startWasiExit !== 0 || evidence.startLeft !== 1 || evidence.runReturned !== 1) {
    throw new Error("default SIGUSR1 must unwind from the actual sleeping poll through _start");
  }
}
