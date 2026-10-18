(function (internal: { runTimers(): number; pumpIo(): boolean; pumpSignals(): boolean }) {
  "use strict";
  const callbacks = internal.runTimers;
  let phase: "callbacks" | "io" = "callbacks";
  let signalDeferred = false;
  internal.runTimers = () => {
    // Entry modules and promise jobs can block after Rust's initial signal poll.
    // Yield once for handler jobs, then let I/O and callbacks make progress even
    // if a handler resends from a microtask. Never enter JS from an engine poll.
    if (!signalDeferred && internal.pumpSignals()) {
      signalDeferred = true;
      return 0;
    }
    if (phase === "io") {
      phase = "callbacks";
      if (internal.pumpIo()) return 0;
    }
    const next = callbacks();
    signalDeferred = false;
    if (next === 0) phase = "io";
    return next;
  };
})
