(function (internal: BunWasm.Internal) {
  "use strict";
  const { Readable, Writable } = internal.builtin("node:stream");
  const { Buffer } = internal.require("buffer");
  function readable(source: ReadableStream<Uint8Array>) {
    const stream = new Readable({ read() {} });
    const drained = (async () => {
      const reader = source.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { stream.push(null); return; }
        stream.push(Buffer.from(value));
      }
    })().catch(error => stream.destroy(error));
    return { stream, drained };
  }
  function writable(sink: { write(chunk: unknown): unknown; end(): void }) {
    return new Writable({
      write(chunk, encoding, callback) {
        try { sink.write(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk); callback(); }
        catch (error) { callback(error); }
      },
      final(callback) { sink.end(); callback(); },
    });
  }
  return { readable, writable };
})
