(function (internal: Pick<BunWasm.Internal, "native">) {
  function step(waiters: Set<BunWasm.IoWaiter>, waiter: BunWasm.IoWaiter): boolean {
    try {
      const result = waiter.step();
      if (result === true) waiters.delete(waiter);
      return result === true || result === "progress";
    } catch (error) {
      if (!waiter.permanent) waiters.delete(waiter);
      if (!waiter.fail) throw error;
      waiter.fail(error);
      return true;
    }
  }

  function stepSet(waiters: Set<BunWasm.IoWaiter>): boolean {
    const size = waiters.size;
    if (size === 0) return false;
    if (size === 1) {
      const only = waiters.values().next().value;
      return only !== undefined ? step(waiters, only) : false;
    }
    let progressed = false;
    for (const waiter of Array.from(waiters)) {
      progressed = step(waiters, waiter) || progressed;
    }
    return progressed;
  }

  return function pumpIo(
    waiters: Set<BunWasm.IoWaiter>,
    watchWaiters?: Set<BunWasm.IoWaiter>,
  ): boolean {
    if (watchWaiters !== undefined) {
      let progressed = false;
      if (watchWaiters.size > 0 && internal.native.fsWatchReady()) {
        progressed = stepSet(watchWaiters);
      }
      if (waiters.size > 0) {
        progressed = stepSet(waiters) || progressed;
      }
      return progressed;
    }
    if (waiters.size === 0) return false;
    const turn = Array.from(waiters).sort((a, b) => Number(b.watch === true) - Number(a.watch === true));
    const watchesReady = turn[0]?.watch !== true || internal.native.fsWatchReady();
    let progressed = false;
    for (const waiter of turn) {
      if (waiter.watch === true && !watchesReady) continue;
      progressed = step(waiters, waiter) || progressed;
    }
    return progressed;
  };
})
