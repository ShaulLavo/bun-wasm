import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const path = new URL("../../crates/bunwasm-runtime/src/js/loop_scheduler.ts", import.meta.url);
const source = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false }).transformSync(readFileSync(path, "utf8"));
const install = runInNewContext(source);

function scheduler() {
  const order: string[] = [];
  const jobs: (() => void)[] = [];
  let pending = false;
  let handled = 0;
  let callbacks = 0;
  const internal = {
    pumpSignals() {
      if (!pending) return false;
      pending = false;
      handled++;
      order.push("sigusr1-handled");
      jobs.push(() => order.push("handler-job"));
      return true;
    },
    pumpIo() { order.push("io"); return false; },
    runTimers() { callbacks++; order.push(`after-pump ${handled}`); return -1; },
  };
  install(internal);
  return {
    internal, order,
    arriveDuringJob() {
      // JSC evaluates the entry module inside the Rust loop's job drain, after
      // its initial signal poll. The synchronous wait must not dispatch JS.
      pending = true;
      order.push(`sleep-done 1000 ${handled}`);
    },
    drainJobs() { for (const job of jobs.splice(0)) job(); },
    callbacks: () => callbacks,
  };
}

test("a signal arriving during an engine job precedes the next check callback", () => {
  const f = scheduler();
  expect(f.internal.pumpSignals()).toBe(false);
  f.arriveDuringJob();
  expect(f.internal.runTimers()).toBe(0);
  expect(f.callbacks()).toBe(0);
  f.drainJobs();
  expect(f.internal.runTimers()).toBe(-1);
  expect(f.order).toEqual(["sleep-done 1000 0", "sigusr1-handled", "handler-job", "after-pump 1"]);
});

test("a consumed signal neither dispatches twice nor keeps an idle loop alive", () => {
  const f = scheduler();
  f.arriveDuringJob();
  f.internal.runTimers();
  f.drainJobs();
  expect(f.internal.runTimers()).toBe(-1);
  expect(f.order.filter(value => value === "sigusr1-handled")).toHaveLength(1);
  expect(f.callbacks()).toBe(1);
});

test("a signal handler that resends from a microtask cannot starve callbacks or I/O", () => {
  let pending = true;
  let handled = 0;
  let callbacks = 0;
  let io = 0;
  const jobs: (() => void)[] = [];
  const internal = {
    pumpSignals() {
      if (!pending) return false;
      pending = false;
      handled++;
      jobs.push(() => { pending = true; });
      return true;
    },
    pumpIo() { io++; return false; },
    runTimers() { callbacks++; return 0; },
  };
  install(internal);
  for (let turn = 0; turn < 1000; turn++) {
    // Match Rust: poll signals, drain handler jobs, then run the scheduler.
    internal.pumpSignals();
    for (const job of jobs.splice(0)) job();
    internal.runTimers();
  }
  expect(handled).toBeGreaterThan(0);
  expect(callbacks).toBeGreaterThanOrEqual(500);
  expect(io).toBeGreaterThanOrEqual(499);
});

test("an I/O yield does not grant a second signal-driven deferral before callbacks", () => {
  let pending = false;
  let callbacks = 0;
  let signals = 0;
  const internal = {
    pumpSignals() { if (!pending) return false; pending = false; signals++; return true; },
    pumpIo() { return true; },
    runTimers() { callbacks++; return 0; },
  };
  install(internal);
  internal.runTimers();
  pending = true;
  internal.runTimers(); // Signal checkpoint yields for handler jobs.
  pending = true;
  internal.runTimers(); // Existing I/O turn yields without resetting the bound.
  internal.runTimers(); // A callback must run before another checkpoint yield.
  expect(callbacks).toBe(2);
  expect(signals).toBe(1);
  expect(pending).toBe(true);
});

for (const executable of [process.execPath, "node"]) {
  test(`native ${executable} reaches an immediate during microtask self-signalling`, () => {
    const guest = `
      process.on('SIGUSR1', () => queueMicrotask(() => process.kill(process.pid, 'SIGUSR1')));
      process.kill(process.pid, 'SIGUSR1');
      setImmediate(() => { console.log('after-pump'); process.exit(0); });
    `;
    // spawnSync owns termination if this control unexpectedly fails to exit.
    const result = spawnSync(executable, ["-e", guest], { encoding: "utf8", timeout: 4000, killSignal: "SIGKILL" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("after-pump\n");
  });
}

test("signal delivery preserves the pending I/O turn between callback turns", () => {
  const f = scheduler();
  // Install around a callback that reports another ready turn.
  const internal = {
    pumpSignals: f.internal.pumpSignals,
    pumpIo: f.internal.pumpIo,
    runTimers() { f.order.push("callback"); return 0; },
  };
  install(internal);
  internal.runTimers();
  f.arriveDuringJob();
  internal.runTimers();
  f.drainJobs();
  internal.runTimers();
  expect(f.order).toEqual(["callback", "sleep-done 1000 0", "sigusr1-handled", "handler-job", "io", "callback"]);
});
