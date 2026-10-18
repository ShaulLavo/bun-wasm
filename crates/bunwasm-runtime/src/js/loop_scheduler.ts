(function (internal: { runTimers(): number; pumpIo(): boolean; pumpSignals(): boolean }) {
  "use strict";
  const callbacks = internal.runTimers;
  let phase: "callbacks" | "io" = "callbacks";
  internal.runTimers = () => {
    // Entry modules and promise jobs can block after Rust's initial signal poll.
    // Dispatch at the poll/check boundary, then yield so handler jobs drain
    // before the next immediate or timer. Never enter JS from an engine poll.
    if (internal.pumpSignals()) return 0;
    if (phase === "io") {
      phase = "callbacks";
      if (internal.pumpIo()) return 0;
    }
    const next = callbacks();
    if (next === 0) phase = "io";
    return next;
  };
})
