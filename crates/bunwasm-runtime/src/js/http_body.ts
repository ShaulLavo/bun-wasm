(function () {
  type Pair = [string, string];
  type Framing = { kind: "none" } | { kind: "fixed"; length: number } | { kind: "chunked" } | { kind: "eof" };
  type Phase = { kind: "fixed"; remaining: number } | { kind: "size" } | { kind: "data"; remaining: number } | { kind: "crlf" } | { kind: "trailers" } | { kind: "eof" } | { kind: "done" };
  type Output = { kind: "data"; bytes: Uint8Array } | { kind: "trailers"; pairs: Pair[] } | { kind: "end" };
  type Decoded = { output: Output[]; remainder: Uint8Array };
  const fail = () => Object.assign(new Error("Parse Error: Invalid chunked response"), { code: "HPE_INVALID_CHUNK_SIZE" });
  function parseError(code: string, reason: string): Error {
    return Object.assign(new Error(`Parse Error: ${reason}`), { code, reason });
  }
  function responseFraming(rawHeaders: readonly string[], method: string, status: number): Framing {
    let length: number | undefined;
    let finalCoding: string | undefined;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i].toLowerCase();
      const value = rawHeaders[i + 1];
      if (name === "content-length") {
        if (length !== undefined) throw parseError("HPE_UNEXPECTED_CONTENT_LENGTH", "Duplicate Content-Length");
        if (finalCoding !== undefined) throw parseError("HPE_INVALID_CONTENT_LENGTH", "Content-Length can't be present with Transfer-Encoding");
        if (!/^[0-9]+$/.test(value)) throw parseError("HPE_INVALID_CONTENT_LENGTH", value ? "Invalid character in Content-Length" : "Empty Content-Length");
        if (!Number.isSafeInteger(Number(value))) throw parseError("HPE_INVALID_CONTENT_LENGTH", "Content-Length overflow");
        length = Number(value);
      }
      if (name !== "transfer-encoding") continue;
      if (length !== undefined) throw parseError("HPE_INVALID_TRANSFER_ENCODING", "Transfer-Encoding can't be present with Content-Length");
      if (!value.trim()) throw parseError("HPE_INVALID_TRANSFER_ENCODING", "Empty Transfer-Encoding");
      finalCoding = value.slice(value.lastIndexOf(",") + 1).trim().toLowerCase();
    }
    if (method === "HEAD" || status < 200 || status === 204 || status === 304) return { kind: "none" };
    if (finalCoding !== undefined) return { kind: finalCoding === "chunked" ? "chunked" : "eof" };
    return length === undefined ? { kind: "eof" } : { kind: "fixed", length };
  }
  const text = (bytes: Uint8Array) => Array.from(bytes, byte => String.fromCharCode(byte)).join("");
  function unexpectedResponseError(bytes: Uint8Array, persistent: boolean): Error | undefined {
    if (!persistent) return parseError("HPE_CLOSED_CONNECTION", "Data after `Connection: close`");
    const prefix = text(bytes.subarray(0, 5));
    const recognized = ["HTTP/", "RTSP/", "ICE/"].some(expected => expected.startsWith(prefix) || prefix.startsWith(expected));
    return recognized ? undefined : parseError("HPE_INVALID_CONSTANT", "Expected HTTP/, RTSP/ or ICE/");
  }
  function lineEnd(bytes: Uint8Array): number {
    for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
    return -1;
  }
  class BodyDecoder {
    private phase: Phase;
    private buffer = new Uint8Array(0);
    private trailers: Pair[] = [];
    constructor(framing: Framing) {
      if (framing.kind === "fixed" && (!Number.isSafeInteger(framing.length) || framing.length < 0)) throw parseError("HPE_INVALID_CONTENT_LENGTH", "Invalid Content-Length");
      if (framing.kind === "fixed") this.phase = { kind: "fixed", remaining: framing.length };
      else if (framing.kind === "chunked") this.phase = { kind: "size" };
      else if (framing.kind === "eof") this.phase = { kind: "eof" };
      else this.phase = { kind: "fixed", remaining: 0 };
    }
    push(bytes: Uint8Array): Decoded {
      const buffer = new Uint8Array(this.buffer.length + bytes.length);
      buffer.set(this.buffer);
      buffer.set(bytes, this.buffer.length);
      this.buffer = buffer;
      const output: Output[] = [];
      while (this.step(output)) {}
      const remainder = this.phase.kind === "done" ? this.buffer : new Uint8Array(0);
      if (remainder.length) this.buffer = new Uint8Array(0);
      return { output, remainder };
    }
    end(): Output[] {
      if (this.phase.kind === "done") return [];
      if (this.phase.kind !== "eof") throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
      this.phase = { kind: "done" };
      return [{ kind: "end" }];
    }
    private step(output: Output[]): boolean {
      switch (this.phase.kind) {
        case "done": return false;
        case "eof": return this.emitBytes(this.buffer.length, output);
        case "fixed": return this.readData(this.phase.remaining, false, output);
        case "data": return this.readData(this.phase.remaining, true, output);
        case "size": return this.readSize();
        case "crlf": return this.readCrlf();
        case "trailers": return this.readTrailer(output);
      }
    }
    private emitBytes(count: number, output: Output[]): boolean {
      if (!count) return false;
      output.push({ kind: "data", bytes: this.buffer.slice(0, count) });
      this.buffer = this.buffer.slice(count);
      return true;
    }
    private readData(remaining: number, chunked: boolean, output: Output[]): boolean {
      if (remaining === 0) {
        this.phase = { kind: chunked ? "crlf" : "done" };
        if (!chunked) output.push({ kind: "end" });
        return true;
      }
      const count = Math.min(remaining, this.buffer.length);
      if (!this.emitBytes(count, output)) return false;
      this.phase = { kind: chunked ? "data" : "fixed", remaining: remaining - count };
      return true;
    }
    private readSize(): boolean {
      const end = lineEnd(this.buffer);
      if (end < 0) return false;
      const size = text(this.buffer.subarray(0, end)).split(";", 1)[0];
      if (!/^[0-9a-f]+$/i.test(size)) throw fail();
      const count = Number.parseInt(size, 16);
      if (!Number.isSafeInteger(count)) throw fail();
      this.buffer = this.buffer.slice(end + 2);
      this.phase = count ? { kind: "data", remaining: count } : { kind: "trailers" };
      return true;
    }
    private readCrlf(): boolean {
      if (this.buffer.length < 2) return false;
      if (this.buffer[0] !== 13 || this.buffer[1] !== 10) throw fail();
      this.buffer = this.buffer.slice(2);
      this.phase = { kind: "size" };
      return true;
    }
    private readTrailer(output: Output[]): boolean {
      const end = lineEnd(this.buffer);
      if (end < 0) return false;
      const line = text(this.buffer.subarray(0, end));
      this.buffer = this.buffer.slice(end + 2);
      if (line) {
        const colon = line.indexOf(":");
        if (colon < 1) throw fail();
        this.trailers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
        return true;
      }
      output.push({ kind: "trailers", pairs: this.trailers }, { kind: "end" });
      this.phase = { kind: "done" };
      return true;
    }
  }
  return { BodyDecoder, responseFraming, unexpectedResponseError };
})
