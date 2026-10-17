(function (internal: { runTimers(): number; pumpIo(): boolean }) {
  "use strict";
  const callbacks = internal.runTimers;
  let phase: "callbacks" | "io" = "callbacks";
  internal.runTimers = () => {
    if (phase === "io") {
      phase = "callbacks";
      if (internal.pumpIo()) return 0;
    }
    const next = callbacks();
    if (next === 0) phase = "io";
    return next;
  };
})
