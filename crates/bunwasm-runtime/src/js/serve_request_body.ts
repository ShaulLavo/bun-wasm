type ServeBodyFraming = { kind: "fixed"; length: number } | { kind: "chunked" };
type ServeBodyOutput = { kind: "data"; bytes: Uint8Array<ArrayBuffer> } | { kind: "trailers"; pairs: [string, string][] } | { kind: "end" };
type ServeBodyDecoder = { push(bytes: Uint8Array): { output: ServeBodyOutput[]; remainder: Uint8Array } };

(function (internal: { require(name: "http_body"): { BodyDecoder: new (framing: ServeBodyFraming) => ServeBodyDecoder } }) {
  type Decoder = ServeBodyDecoder;
  // Unread body bytes the stream holds before the connection stops reading.
  const HIGH_WATER = 256 * 1024;

  // A Bun.serve request body that is still arriving when its handler starts, as in Bun:
  // the handler reads the bytes as they come, and the connection stops reading while
  // HIGH_WATER bytes wait unread. If the client goes away first, or the response is sent
  // first, reads fail with an AbortError and the rest of the body is decoded and dropped.
  //
  // Bun.serve's maxRequestBodySize caps the bytes a body may bring: once more arrive, reads fail
  // with Bun's error and push() throws TooLarge, so the connection answers 413 and closes.
  class RequestUpload {
    readonly stream: ReadableStream<Uint8Array>;
    private controller: ReadableByteStreamController | null = null;
    private finished = false;
    private received = 0;
    private readonly decoder: Decoder;
    constructor(chunked: boolean, length: number, onDemand: () => void, private readonly limit = Infinity) {
      this.decoder = new (internal.require("http_body").BodyDecoder)(chunked ? { kind: "chunked" } : { kind: "fixed", length });
      this.stream = new ReadableStream({
        type: "bytes",
        start: controller => { this.controller = controller; },
        pull: () => onDemand(),
        cancel: () => { this.finished = true; },
      }, { highWaterMark: HIGH_WATER });
    }
    // Whether the connection should read more: room in the stream, or bytes only to drop.
    wantsMore(): boolean {
      return this.finished || (this.controller?.desiredSize ?? 0) > 0;
    }
    // Body bytes from the connection. Returns what follows the body once it is complete,
    // or null while more is due. Throws on a malformed chunked body.
    push(bytes: Uint8Array): Uint8Array | null {
      const { output, remainder } = this.decoder.push(bytes);
      let complete = false;
      for (const item of output) {
        if (item.kind === "end") complete = true;
        if (item.kind !== "data") continue;
        this.received += item.bytes.length;
        if (this.received > this.limit) throw this.overflow();
        if (!this.finished) this.controller?.enqueue(item.bytes);
      }
      if (!complete) return null;
      if (!this.finished) {
        this.finished = true;
        this.controller?.close();
        this.controller?.byobRequest?.respond(0);
      }
      return remainder;
    }
    abort(): void {
      if (this.finished) return;
      this.finished = true;
      this.controller?.error(new DOMException("The connection was closed.", "AbortError"));
    }
    private overflow(): TooLarge {
      if (!this.finished) {
        this.finished = true;
        this.controller?.error(tooLargeError());
      }
      return new TooLarge();
    }
  }
  class TooLarge extends Error {}
  function tooLargeError(): Error {
    return new Error("Request body exceeded maxRequestBodySize");
  }
  // The body of a request that arrived whole but over the cap: reading it fails as in Bun.
  function tooLargeBody(): ReadableStream<Uint8Array> {
    return new ReadableStream({ start(controller) { controller.error(tooLargeError()); } });
  }
  return { RequestUpload, TooLarge, tooLargeBody };
})
