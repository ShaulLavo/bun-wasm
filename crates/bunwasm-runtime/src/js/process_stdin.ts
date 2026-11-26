// Node stream behavior over Waffle's nonblocking descriptor reader and readiness waiters.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const readErrors: Record<number, readonly [string, number | undefined]> = {
    2: ["EACCES", -13], 4: ["EADDRNOTAVAIL", -99], 8: ["EBADF", -9], 21: ["EFAULT", -14], 27: ["EINTR", -4],
    28: ["EINVAL", -22], 29: ["EIO", -5], 31: ["EISDIR", -21], 48: ["ENOMEM", -12],
    52: ["ENOSYS", -38], 58: ["ENOTSUP", -95], 61: ["EOVERFLOW", -75],
    63: ["EPERM", -1], 64: ["EPIPE", -32], 76: ["ENOTCAPABLE", undefined],
  };
  function readError(result: number) {
    const [code, errno] = readErrors[-result] || [`E${-result}`, undefined];
    return Object.assign(new Error(`read ${code}`), { code, errno, syscall: "read" });
  }
  return function makeReader(): BunWasm.ProcessReader {
    const { Readable } = internal.builtin("node:stream");
    const frames = internal.require("resource_frame");
    const subscription = new Uint8Array(16); // READABLE = 0, fd = 0, userdata = 0.
    let waiter: BunWasm.IoWaiter | undefined;
    // The pending read's frame: data and end from a read run in the frame that started it, as
    // under Bun. A read requested while one is pending joins it. The stream reads ahead while
    // paused, where Bun does not read at all: such a read belongs to the frame that resumes.
    let frame: BunWasm.ResourceFrame | undefined;
    let readAhead = false;
    let referenced = true;
    let paused = false;
    function updateReference() {
      if (waiter) waiter.ref = referenced && !paused;
    }
    function step(): boolean {
      if (stream.destroyed) return true;
      const chunk = native.procRead(0, 65536);
      if (chunk === -6) return false; // WASI EAGAIN, wait for descriptor readiness.
      // This read is over; a push may start the next one, with its own waiter and frame.
      const finished = frame;
      waiter = undefined;
      frame = undefined;
      try {
        if (typeof chunk === "number" && chunk < 0) throw readError(chunk);
        if (typeof chunk === "number") stream.push(null);
        else stream.push(internal.require("buffer").Buffer.from(chunk));
      } finally {
        finished?.release();
      }
      return true;
    }
    function read() {
      if (waiter || stream.destroyed) return;
      internal.require("net");
      readAhead = paused;
      frame = frames.capture();
      waiter = internal.addIoWaiter(frame.bind({ step, ref: referenced && !paused, subscriptions: () => subscription, fail }));
    }
    function fail(error: unknown) {
      waiter = undefined;
      stream.destroy(error);
    }
    function destroy(error: unknown, callback: (error?: unknown) => void) {
      if (waiter) waiter.ref = false;
      const pending = frame;
      frame = undefined;
      try {
        // Closing only our descriptor releases the pipe reader; Waffle owns the endpoint.
        const result = native.procClose(0);
        callback(error ?? (result < 0 ? readError(result) : undefined));
      } finally {
        pending?.release();
      }
    }
    const stream = Object.assign(new Readable({ read, destroy, highWaterMark: 65536 }), {
      fd: 0,
      isTTY: native.isatty(0),
      isRaw: false,
      // Without a terminal session (piped input, or a host that has none) this changes nothing.
      setRawMode(raw: boolean) {
        const failure = native.terminalSetRawMode?.(Boolean(raw));
        if (failure) throw Object.assign(new Error(`setRawMode ${failure}`), { code: "EIO", syscall: "setRawMode" });
        if (native.terminalSetRawMode) stream.isRaw = Boolean(raw);
        return stream;
      },
      ref() { referenced = true; updateReference(); return stream; },
      unref() { referenced = false; updateReference(); return stream; },
    });
    stream.on("pause", () => { paused = true; updateReference(); });
    stream.on("resume", () => {
      paused = false;
      if (waiter && readAhead) restartRead(waiter);
      updateReference();
    });
    function restartRead(pending: BunWasm.IoWaiter) {
      internal.removeIoWaiter(pending);
      frame?.release();
      waiter = undefined;
      read();
    }
    return stream;
  };
})
