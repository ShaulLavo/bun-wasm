type ServeBodyFraming = { kind: "fixed"; length: number } | { kind: "chunked" };
type ServeBodyOutput = { kind: "data"; bytes: Uint8Array<ArrayBuffer> } | { kind: "trailers"; pairs: [string, string][] } | { kind: "end" };
type ServeBodyDecoder = { push(bytes: Uint8Array): { output: ServeBodyOutput[]; remainder: Uint8Array } };

(function (internal: { require(name: "http_body"): { BodyDecoder: new (framing: ServeBodyFraming) => ServeBodyDecoder } }) {
  type Decoder = ServeBodyDecoder;

  // A Bun.serve request body that is still arriving when its handler starts, as in Bun:
  // the handler reads the bytes as they come. If the client goes away first, reads fail
  // with an AbortError.
  class RequestUpload {
    readonly stream: ReadableStream<Uint8Array>;
    private controller: ReadableByteStreamController | null = null;
    private finished = false;
    private readonly decoder: Decoder;
    constructor(chunked: boolean, length: number) {
      this.decoder = new (internal.require("http_body").BodyDecoder)(chunked ? { kind: "chunked" } : { kind: "fixed", length });
      this.stream = new ReadableStream({
        type: "bytes",
        start: controller => { this.controller = controller; },
        cancel: () => { this.finished = true; },
      });
    }
    // Body bytes from the connection. Returns what follows the body once it is complete,
    // or null while more is due. Throws on a malformed chunked body.
    push(bytes: Uint8Array): Uint8Array | null {
      const { output, remainder } = this.decoder.push(bytes);
      let complete = false;
      for (const item of output) {
        if (item.kind === "end") complete = true;
        else if (item.kind === "data" && !this.finished) this.controller?.enqueue(item.bytes);
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
  }
  return { RequestUpload };
})
