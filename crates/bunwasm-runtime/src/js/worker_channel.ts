(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const encoder = new TextEncoder();
  const AGAIN = -2;

  function open(input: number, output: number): BunWasm.WorkerChannel {
    const decoder = new TextDecoder();
    const outgoing: Uint8Array[] = [];
    let offset = 0;
    let incoming = "";
    let ended = false;
    let writeClosed = false;
    function flush() {
      let progress = false;
      for (let i = 0; i < 32 && outgoing.length; i++) {
        const written = native.hostWrite(output, outgoing[0].subarray(offset));
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
      pump(receive) {
        let progress = flush();
        for (let i = 0; i < 32 && !ended; i++) {
          const bytes = native.hostRead(input);
          if (bytes === AGAIN) break;
          if (typeof bytes === "number") { ended = true; break; }
          progress = true;
          incoming += decoder.decode(bytes, { stream: true });
          if (incoming.length > 64 * 1024 * 1024) throw new Error("Worker message exceeds 64 MiB");
          let end = incoming.indexOf("\n");
          while (end >= 0) {
            const line = incoming.slice(0, end);
            incoming = incoming.slice(end + 1);
            receive(JSON.parse(line));
            end = incoming.indexOf("\n");
          }
        }
        if (ended && incoming.length) throw new Error("Incomplete worker message");
        return flush() || progress;
      },
      close() { native.hostClose(input); native.hostClose(output); ended = true; outgoing.length = 0; },
      get pending() { return outgoing.length > 0; },
      get ended() { return ended; },
    };
  }
  return { open };
})
