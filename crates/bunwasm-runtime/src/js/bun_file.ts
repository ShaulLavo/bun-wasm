(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const chunkSize = 64 * 1024;
  type Target = string | number;

  function validateDescriptor(fd: number) {
    const bounds = Number.isInteger(fd) ? ">= 0 && <= 2147483647" : "an integer";
    if (Number.isInteger(fd) && fd >= 0 && fd <= 2147483647) return fd;
    throw Object.assign(new RangeError(`The value of "fd" is out of range. It must be ${bounds}. Received ${fd}`), { code: "ERR_OUT_OF_RANGE" });
  }

  function reader(target: Target, start: number, end: number | undefined, streaming: boolean) {
    let fd: number | undefined;
    let owned = false;
    let finished = false;
    let position = 0;
    let limit = Infinity;
    let positional = false;
    let skip = 0;

    function close() {
      finished = true;
      if (!owned || fd === undefined) return;
      const descriptor = fd;
      fd = undefined;
      native.close(descriptor);
    }

    function open() {
      if (typeof target === "number") fd = target;
      else { fd = native.open(target, "r"); owned = true; }
      const stat = native.fstat(fd);
      const regular = (stat.mode & 0o170000) === 0o100000;
      positional = regular && (streaming || typeof target === "string" || start !== 0 || end !== undefined);
      const total = regular ? stat.size : Infinity;
      position = start < 0 ? Math.max(total + start, 0) : Math.min(start, total);
      limit = end === undefined ? total : end < 0 ? Math.max(total + end, 0) : Math.min(end, total);
      if (!positional) skip = position;
    }

    function next(): Uint8Array<ArrayBuffer> | undefined {
      if (finished) return;
      try {
        if (fd === undefined) open();
        return read();
      } catch (error) {
        close();
        throw error;
      }
    }

    function read(): Uint8Array<ArrayBuffer> | undefined {
      if (fd === undefined) throw new Error("BunFile reader is not open");
      while (skip > 0) {
        const bytes = native.read(fd, Math.min(chunkSize, skip), -1);
        if (!bytes.length) { close(); return; }
        skip -= bytes.length;
      }
      const length = Math.min(chunkSize, Math.max(0, limit - position));
      if (!length) { close(); return; }
      const bytes = native.read(fd, length, positional ? position : -1);
      position += bytes.length;
      if (!bytes.length || position >= limit) close();
      return bytes.length ? bytes : undefined;
    }
    return { next, close };
  }

  function bytes(target: Target, start: number, end: number | undefined) {
    const source = reader(target, start, end, false);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (let chunk = source.next(); chunk !== undefined; chunk = source.next()) {
        chunks.push(chunk);
        total += chunk.length;
      }
    } finally { source.close(); }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  }

  function stream(target: Target, start: number, end: number | undefined) {
    const source = reader(target, start, end, true);
    const { ReadableStream } = internal.require("streams");
    return new ReadableStream({
      type: "bytes",
      pull(controller) {
        const bytes = source.next();
        if (bytes === undefined) {
          controller.close();
          controller.byobRequest?.respond(0);
          return;
        }
        controller.enqueue(bytes);
      },
      cancel: source.close,
    }, { highWaterMark: 0 });
  }
  return { bytes, stream, validateDescriptor };
})
