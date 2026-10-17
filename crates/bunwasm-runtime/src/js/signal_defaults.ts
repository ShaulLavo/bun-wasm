(function (internal: {
  native: { hostCaps: { signal: boolean }; hostSignal(signal: number, mode: number): number };
}) {
  "use strict";
  const native = internal.native;
  if (native.hostCaps.signal && native.hostSignal(13, 1) < 0) {
    throw new Error("Cannot initialize the SIGPIPE disposition");
  }
})
