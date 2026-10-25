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
    const subscription = new Uint8Array(16); // READABLE = 0, fd = 0, userdata = 0.
    let waiter: BunWasm.IoWaiter | undefined;
    let referenced = true;
    function step(): boolean {
      if (stream.destroyed) return true;
      const chunk = native.procRead(0, 65536);
      if (chunk === -6) return false; // WASI EAGAIN, wait for descriptor readiness.
      waiter = undefined;
      if (typeof chunk === "number" && chunk < 0) throw readError(chunk);
      if (typeof chunk === "number") stream.push(null);
      else stream.push(internal.require("buffer").Buffer.from(chunk));
      return true;
    }
    function read() {
      if (waiter || stream.destroyed) return;
      internal.require("net");
      waiter = internal.addIoWaiter({ step, ref: referenced, subscriptions: () => subscription, fail });
    }
    function fail(error: unknown) {
      waiter = undefined;
      stream.destroy(error);
    }
    function destroy(error: unknown, callback: (error?: unknown) => void) {
      if (waiter) waiter.ref = false;
      // Closing only our descriptor releases the pipe reader; Waffle owns the endpoint.
      const result = native.procClose(0);
      callback(error ?? (result < 0 ? readError(result) : undefined));
    }
    const stream = Object.assign(new Readable({ read, destroy, highWaterMark: 65536 }), {
      fd: 0,
      isTTY: native.isatty(0),
      setRawMode() { return stream; },
      ref() { referenced = true; if (waiter) waiter.ref = true; return stream; },
      unref() { referenced = false; if (waiter) waiter.ref = false; return stream; },
    });
    return stream;
  };
})
