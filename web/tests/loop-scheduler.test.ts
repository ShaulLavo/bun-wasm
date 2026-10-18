import { expect, test } from "bun:test";
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
