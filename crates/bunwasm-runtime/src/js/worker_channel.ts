(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const encoder = new TextEncoder();
  const AGAIN = -6;
  const READABLE = 0;
  const WRITABLE = 1;

  // One 16-byte procPoll subscription: u32 kind, u32 id, u64 userdata.
  function subscription(kind: number, id: number): Uint8Array {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, kind, true);
    view.setUint32(4, id >>> 0, true);
    return bytes;
  }

  function open(input: number, output: number): BunWasm.WorkerChannel {
    const decoder = new TextDecoder();
    const outgoing: Uint8Array[] = [];
    let offset = 0;
    let incoming = "";
    let ended = false;
    let writeClosed = false;
    function fail(message: string): never {
      incoming = "";
      ended = true;
      throw new Error(message);
    }
    function flush() {
      let progress = false;
      for (let i = 0; i < 32 && outgoing.length; i++) {
        const written = native.procWrite(output, outgoing[0].subarray(offset));
        if (written === AGAIN) break;
        if (written < 0) { writeClosed = true; outgoing.length = 0; offset = 0; break; }
        offset += written;
        if (offset === outgoing[0].length) { outgoing.shift(); offset = 0; }
        progress = progress || written > 0;
      }
      return progress;
    }
    return {
      send(frame) { if (!writeClosed) outgoing.push(encoder.encode(JSON.stringify(frame) + "\n")); flush(); },
      drain() {
        // Sleep until the pipe can take more, never longer than the poll bound.
        while (outgoing.length) if (!flush()) native.procPoll(subscription(WRITABLE, output), 100);
      },
      subscriptions() {
        const reading = ended ? new Uint8Array(0) : subscription(READABLE, input);
        return outgoing.length && !writeClosed ? internal.concatBytes([reading, subscription(WRITABLE, output)]) : reading;
      },
      pump(receive) {
        let progress = flush();
        for (let i = 0; i < 32 && !ended; i++) {
          const bytes = native.procRead(input);
          if (bytes === AGAIN) break;
          if (typeof bytes === "number") { ended = true; break; }
          progress = true;
          incoming += decoder.decode(bytes, { stream: true });
          if (incoming.length > 64 * 1024 * 1024) fail("Worker message exceeds 64 MiB");
          let end = incoming.indexOf("\n");
          while (end >= 0) {
            const line = incoming.slice(0, end);
            incoming = incoming.slice(end + 1);
            receive(JSON.parse(line));
            end = incoming.indexOf("\n");
          }
        }
        if (ended && incoming.length) fail("Incomplete worker message");
        return flush() || progress;
      },
      close() { native.procClose(input); native.procClose(output); ended = true; incoming = ""; outgoing.length = 0; },
      get pending() { return outgoing.length > 0; },
      get ended() { return ended; },
    };
  }
  return { open };
})
