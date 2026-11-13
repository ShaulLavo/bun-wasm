(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const encoder = new TextEncoder();
  const AGAIN = -6;
  /** `procWriteResult` for an attempt that never ran. */
  const UNWRITTEN = -(2 ** 63);
  /** A token crosses to `procWriteResult` as two 32-bit words. */
  const WORD = 2 ** 32;
  /**
   * This guest's write attempts, counted across every channel it opens. The core keeps the last
   * attempt that ran, whichever channel made it, so a token must name one attempt of the whole
   * guest: it is never reused, and 2 ** 53 of them outlast any guest.
   */
  let attempts = 0;
  /**
   * A write whose result has not been counted yet. It is named before the call is made and
   * stays here until its result is applied, across flushes and across channels: the core keeps
   * the result of this guest's last attempt only, so no channel writes again until this one is
   * settled. `apply` counts a result against the frame the attempt wrote, and running it twice
   * changes nothing.
   */
  type Attempt = { output: number; token: number; apply(written: number): void };
  let unsettled: Attempt | null = null;
  /** Bytes any channel of this guest has had counted, for a flush to tell whether it moved some. */
  let moved = 0;
  function finish(attempt: Attempt, written: number) {
    attempt.apply(written);
    unsettled = null;
  }
  /**
   * Counts the unsettled write, if there is one, by asking the core what it came to. When the
   * core cannot be asked, this throws and the attempt stays unsettled, to be asked about again.
   */
  function settle() {
    const attempt = unsettled;
    if (attempt) finish(attempt, native.procWriteResult(attempt.output, Math.floor(attempt.token / WORD), attempt.token % WORD));
  }
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
    /** Frames not yet written: text until its first write is tried, then bytes. */
    const outgoing: (Uint8Array | string)[] = [];
    let offset = 0;
    let incoming = "";
    let ended = false;
    let writeClosed = false;
    function fail(message: string): never {
      incoming = "";
      ended = true;
      throw new Error(message);
    }
    /** The head frame as bytes, or null when it could not be encoded this time. */
    function head() {
      const first = outgoing[0];
      if (typeof first !== "string") return first;
      try { return outgoing[0] = encoder.encode(first); }
      catch { return null; }
    }
    /** The result of this channel's last counted write. */
    let last = 0;
    /**
     * Counts what a write of `frame` from `base` came to. The offset is set, not added to, and a
     * frame that has left the queue is not counted again, so counting the same result twice
     * (after an interruption between two of these steps) changes nothing. `UNWRITTEN` means the
     * attempt never ran: the frame is still queued where it was.
     */
    function count(frame: Uint8Array, base: number, written: number) {
      last = written;
      if (written === AGAIN || written === UNWRITTEN) return;
      if (written < 0) { writeClosed = true; offset = 0; outgoing.length = 0; return; }
      if (outgoing[0] !== frame) return;
      if (base + written > offset) { moved += base + written - offset; offset = base + written; }
      if (offset < frame.length) return;
      offset = 0; outgoing.shift();
    }
    /**
     * Writes the head frame once, from where the last write left it. The attempt is named
     * before the call. A call that fails on its way to the core or back has its result asked
     * for, under this descriptor and this token, and if even that fails the attempt stays
     * unsettled and this throws. False when the pipe took nothing more.
     */
    function write() {
      // Not while an earlier write is uncounted, whichever channel made it.
      settle();
      const frame = outgoing.length ? head() : null;
      if (!frame) return false;
      const base = offset;
      const attempt: Attempt = { output, token: ++attempts, apply: written => count(frame, base, written) };
      unsettled = attempt;
      try { finish(attempt, native.procWriteOnce(output, frame.subarray(base), attempt.token)); }
      catch { settle(); }
      return last >= 0;
    }
    /**
     * Writes what the pipe takes. It never throws: whatever interrupts it, the frame stays
     * queued, whole and in order, an attempt whose result is not known stays unsettled, and the
     * next flush takes both up. A sender may therefore queue a frame at a point where it can no
     * longer report a failure.
     */
    function flush() {
      const start = moved;
      try { for (let i = 0; i < 32 && outgoing.length && write(); i++); }
      catch { /* taken up by the next flush */ }
      return moved !== start;
    }
    return {
      send(frame) { if (!writeClosed) outgoing.push(JSON.stringify(frame) + "\n"); flush(); },
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
      close() {
        native.procClose(input); native.procClose(output); ended = true; incoming = ""; outgoing.length = 0;
        // A write to a pipe that is now closed has nothing left to count.
        if (unsettled?.output === output) unsettled = null;
      },
      get pending() { return outgoing.length > 0; },
      get ended() { return ended; },
    };
  }
  return { open };
})
