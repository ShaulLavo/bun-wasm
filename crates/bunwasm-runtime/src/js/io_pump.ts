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

  return function pumpIo(waiters: Set<BunWasm.IoWaiter>): boolean {
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
