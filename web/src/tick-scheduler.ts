// Browser/Node host tick checkpoint scheduler for process.nextTick.
// Synchronous ticks queued inside a guest task (runEntry, pump, emitBeforeExit)
// drain immediately when that task returns, before V8's microtask checkpoint
// executes Promise.prototype.then or native `await` continuations.
// Ticks queued during a host microtask checkpoint (after a guest task finished,
// including inside Promise.prototype.then or chained native `await` reactions)
// schedule a host macrotask checkpoint and drain at the start of the next turn,
// once V8's microtask queue is completely empty and ahead of the next timer or
// immediate. Ticks queued during a host unhandledRejection / rejectionHandled
// callback drain right after that rejection pass finishes (via host
// process.nextTick on Node or an ahead-of-listener queueMicrotask in browsers),
// before follow-up Promise microtasks queued inside the rejection listeners.
// Ticks queued outside any guest task before the host loop starts
// fall back to queueMicrotask so standalone host harnesses still drain them.

export interface TickScheduler {
  readonly queued: boolean;
  schedule(): void;
  runTask<T>(fn: () => T): T;
  runRejectionCallback<T>(fn: () => T, scheduleAfterPass: (callback: () => void) => void): T;
  drainBeforeTurn(): boolean;
  drainNow(): void;
  reset(): void;
}

export function createTickScheduler(
  runTicks: () => void,
  scheduleCheckpoint: () => void,
  queueFallbackMicrotask: (callback: () => void) => void,
  isExited: () => boolean,
): TickScheduler {
  let queued = false;
  let taskDepth = 0;
  let scheduledInTask = false;
  let afterGuestTask = false;
  let deferredToTurn = false;
  let rejectionDepth = 0;
  let rejectionFlushScheduled = false;
  let rejectionTickPending = false;

  function drainNow(): void {
    if (!queued || isExited()) return;
    queued = false;
    scheduledInTask = false;
    deferredToTurn = false;
    rejectionTickPending = false;
    runTicks();
  }

  function flushRejectionTicks(): void {
    rejectionFlushScheduled = false;
    if (!rejectionTickPending || !queued || isExited()) {
      rejectionTickPending = false;
      return;
    }
    rejectionTickPending = false;
    taskDepth++;
    try {
      drainNow();
    } finally {
      taskDepth--;
      if (taskDepth === 0) {
        if (scheduledInTask && queued && !isExited()) drainNow();
        afterGuestTask = true;
      }
    }
  }

  return {
    get queued() {
      return queued;
    },
    schedule() {
      if (isExited()) return;
      if (rejectionDepth > 0) {
        queued = true;
        deferredToTurn = false;
        rejectionTickPending = true;
        return;
      }
      if (queued) return;
      queued = true;
      if (taskDepth > 0) {
        scheduledInTask = true;
        return;
      }
      if (afterGuestTask) {
        deferredToTurn = true;
        scheduleCheckpoint();
        return;
      }
      queueFallbackMicrotask(drainNow);
    },
    runTask<T>(fn: () => T): T {
      taskDepth++;
      try {
        return fn();
      } finally {
        taskDepth--;
        if (taskDepth === 0) {
          if (scheduledInTask && queued && !isExited()) drainNow();
          afterGuestTask = true;
        }
      }
    },
    runRejectionCallback<T>(fn: () => T, scheduleAfterPass: (callback: () => void) => void): T {
      if (!rejectionFlushScheduled && !isExited()) {
        rejectionFlushScheduled = true;
        scheduleAfterPass(flushRejectionTicks);
      }
      rejectionDepth++;
      try {
        return fn();
      } finally {
        rejectionDepth--;
      }
    },
    drainBeforeTurn(): boolean {
      if (!deferredToTurn || !queued || isExited()) {
        afterGuestTask = false;
        return false;
      }
      taskDepth++;
      try {
        drainNow();
      } finally {
        taskDepth--;
        afterGuestTask = true;
      }
      return true;
    },
    drainNow,
    reset() {
      queued = false;
      taskDepth = 0;
      scheduledInTask = false;
      afterGuestTask = false;
      deferredToTurn = false;
      rejectionDepth = 0;
      rejectionFlushScheduled = false;
      rejectionTickPending = false;
    },
  };
}
