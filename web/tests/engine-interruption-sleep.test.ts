import { expect, test } from "bun:test";
import { ProcessSignalExit } from "waffle/proc/abi";
import { probeCell, probeLength, snapshotProbe } from "./engine-interruption-probe";
import { assertFatalSleepSync, assertHandledSleepSync, observeProcessPoll, sleepSyncActivityLimit, sleepSyncDurationMs, sleepSyncSignalGuest } from "./engine-interruption-sleep";

function evidence() {
  const probe = new Int32Array(new SharedArrayBuffer(probeLength * 4));
  return { probe, snapshot: () => snapshotProbe(probe) };
}
function completedHandled() {
  return { ...evidence().snapshot(), processPollCalls: 40, idleWaitEntries: 100, idleWaitBlocked: 100,
    runReturned: 1, startLeft: 1, startWasiExit: 1 };
}
function completedFatal() {
  return { ...evidence().snapshot(), processPollCalls: 1, processPollThrows: 1,
    idleWaitEntries: 1, idleWaitBlocked: 1, startFatalSignal: 10,
    startOtherException: 1, startLeft: 1, runReturned: 1 };
}
const handledOutput = "ready\nsleep-entered\nsleep-done 1000 0\nsigusr1-handled\nafter-pump 1\n";
const fatalOutput = "ready\nsleep-entered\n";

test("sleepSync fixtures compile and use the real Bun sleep and cooperative continuation", () => {
  for (const handled of [true, false]) {
    const source = sleepSyncSignalGuest(handled);
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain(`Bun.sleepSync(${sleepSyncDurationMs})`);
    expect(source).toContain("ready\\nsleep-entered\\n");
    expect(source).not.toContain("process.exit");
    if (handled) {
      expect(source).toContain("process.on('SIGUSR1'");
      expect(source).toContain("setImmediate(");
    } else {
      expect(source).toContain("after-sleep");
      expect(source).toContain("CATCH-RAN");
      expect(source).toContain("FINALLY-RAN");
      expect(source).toContain("AFTER-RAN");
    }
  }
});

test("sleepSync proof counts actual poll calls even when the import never blocks", () => {
  const f = evidence(), calls: number[][] = [];
  const imports: WebAssembly.Imports = { runtime_proc: {
    poll(...args: number[]) { calls.push(args); return -6; },
  } };
  observeProcessPoll(imports, f.probe);
  for (let index = 0; index < 3; index++) expect((imports.runtime_proc!.poll as Function)(16, 0, 25, 32)).toBe(-6);
  expect(calls).toEqual([[16, 0, 25, 32], [16, 0, 25, 32], [16, 0, 25, 32]]);
  expect(f.snapshot().processPollCalls).toBe(3);
  expect(f.snapshot().processPollThrows).toBe(0);
  expect(f.snapshot().idleWaitEntries).toBe(0);
});

test("sleepSync poll instrumentation preserves the exact production fatal exception", () => {
  const f = evidence(), fatal = new ProcessSignalExit(10);
  const imports: WebAssembly.Imports = { runtime_proc: { poll() { throw fatal; } } };
  observeProcessPoll(imports, f.probe);
  expect(() => (imports.runtime_proc!.poll as Function)(0, 0, 25, 0)).toThrow(fatal);
  expect(Atomics.load(f.probe, probeCell.processPollCalls)).toBe(1);
  expect(Atomics.load(f.probe, probeCell.processPollThrows)).toBe(1);
  expect(f.snapshot().startFatalSignal).toBe(0); // Poll instrumentation cannot fabricate _start evidence.
});

test("sleepSync proof cannot replace a missing production poll with a fake", () => {
  expect(() => observeProcessPoll({ runtime_proc: {} }, evidence().probe)).toThrow("production runtime_proc.poll");
});

test("handled sleepSync admits preserved duration, one deferred callback and bounded real activity", () => {
  expect(assertHandledSleepSync(handledOutput, completedHandled())).toBe(1_000);
  expect(assertHandledSleepSync(handledOutput, { ...completedHandled(), processPollCalls: 80, idleWaitEntries: 120 })).toBe(1_000);
});

for (const [name, output] of [
  ["callback during synchronous sleep", handledOutput.replace("sleep-done 1000 0", "sleep-done 1000 1")],
  ["early callback output", "ready\nsleep-entered\nsigusr1-handled\nsleep-done 1000 1\nafter-pump 1\n"],
  ["lost callback", handledOutput.replace("sigusr1-handled\n", "").replace("after-pump 1", "after-pump 0")],
  ["duplicate callback", handledOutput.replace("sigusr1-handled\n", "sigusr1-handled\nsigusr1-handled\n")],
  ["shortened sleep", handledOutput.replace("1000", "250")],
  ["unbounded sleep", handledOutput.replace("1000", "6000")],
] as const) test(`handled sleepSync rejects ${name}`, () => {
  expect(() => assertHandledSleepSync(output, completedHandled())).toThrow();
});

for (const mutation of [
  { processPollCalls: sleepSyncActivityLimit }, // Busy-spin can have very few native waits.
  { idleWaitEntries: sleepSyncActivityLimit },
  { processPollCalls: 0 },
  { idleWaitEntries: 0 },
  { idleWaitBlocked: 0 },
  { processPollThrows: 1 },
  { runReturned: 0 },
  { startLeft: 0 },
  { startOtherException: 1 },
]) test(`handled sleepSync rejects false activity/completion evidence ${JSON.stringify(mutation)}`, () => {
  expect(() => assertHandledSleepSync(handledOutput, { ...completedHandled(), ...mutation })).toThrow();
});

test("fatal sleepSync admits actual poll unwind and forbids all post-sleep markers", () => {
  expect(() => assertFatalSleepSync(fatalOutput, completedFatal())).not.toThrow();
  for (const marker of ["after-sleep\n", "CATCH-RAN\n", "FINALLY-RAN\n", "AFTER-RAN\n"]) {
    expect(() => assertFatalSleepSync(fatalOutput + marker, completedFatal())).toThrow();
  }
});

for (const mutation of [
  { processPollThrows: 0 },
  { startFatalSignal: 0 },
  { startFatalSignal: 15 },
  { startNormalReturn: 1 },
  { startWasiExit: 1 },
  { startOtherException: 0 },
  { startLeft: 0 },
  { runReturned: 0 },
  { processPollCalls: sleepSyncActivityLimit },
  { idleWaitBlocked: 0 },
  { catchWrites: 1 },
  { finallyWrites: 1 },
  { afterWrites: 1 },
]) test(`fatal sleepSync rejects fabricated exit evidence ${JSON.stringify(mutation)}`, () => {
  expect(() => assertFatalSleepSync(fatalOutput, { ...completedFatal(), ...mutation })).toThrow();
});
