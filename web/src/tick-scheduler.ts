// Browser/Node host tick checkpoint scheduler for process.nextTick.
// Synchronous ticks queued inside a guest task (runEntry, pump, emitBeforeExit)
// drain immediately when that task returns, before V8's microtask checkpoint
// executes Promise.prototype.then or native `await` continuations.
// Ticks queued during a host microtask checkpoint (after a guest task finished,
// including inside Promise.prototype.then or chained native `await` reactions)
// schedule a host macrotask checkpoint and drain at the start of the next turn,
// once V8's microtask queue is completely empty and ahead of the next timer or
// immediate. Ticks queued outside any guest task before the host loop starts
// fall back to queueMicrotask so standalone host harnesses still drain them.

export interface TickScheduler {
  readonly queued: boolean;
  schedule(): void;
  runTask<T>(fn: () => T): T;
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

  function drainNow(): void {
    if (!queued || isExited()) return;
    queued = false;
    scheduledInTask = false;
    deferredToTurn = false;
    runTicks();
  }

  return {
    get queued() {
      return queued;
    },
    schedule() {
      if (queued || isExited()) return;
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
    },
  };
}
