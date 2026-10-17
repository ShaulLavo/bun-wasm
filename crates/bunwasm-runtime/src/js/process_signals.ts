(function (internal: BunWasm.Internal) {
  "use strict";
  return function signalDispatcher(process: BunWasm.NodeEmitter, names: ReadonlyMap<number, readonly string[]>) {
    let dispatching = false;
    return function pumpSignals(): boolean {
      // All cooperative entry paths share this guard, including broken-pipe
      // handling. Engine checkpoints leave signals pending; they never call JS.
      if (dispatching) return false;
      dispatching = true;
      let progress = false;
      try {
        for (;;) {
          const number = internal.native.hostSignal(0, 0);
          if (number <= 0) return progress;
          const events = names.get(number);
          if (!events) throw new Error(`Cannot dispatch signal ${number}`);
          // Dequeue before dispatch. A once listener may restore DEFAULT without
          // reclassifying the already-selected handled delivery. As in Node, aliases
          // are separate events: emit each name once, with that name as its argument.
          for (const name of events) process.emit(name, name);
          progress = true;
        }
      } finally {
        dispatching = false;
      }
    };
  };
})
