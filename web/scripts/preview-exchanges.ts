import type { Duplex } from "node:stream";
import type { PreviewHostInput, PreviewHostOpen, PreviewHostOutput } from "waffle/browser/preview-host";
import { MAX_FRAME } from "../src/preview-owner-protocol";

export interface NativeExchangeTransport {
  open(request: PreviewHostOpen, output: (message: PreviewHostOutput) => void, fail: () => void): string;
  input(id: string, message: PreviewHostInput): void;
  retire(id: string): void;
  connected(): boolean;
}

export class NativeHTTPExchange {
  private id = "";
  private ended = false;
  private receivedHead = false;
  private demanded = false;
  private unacknowledged = false;
  private readonly response = Promise.withResolvers<Response>();
  private readonly stream: ReadableStream<Uint8Array>;
  // ReadableStream.start runs synchronously during construction.
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly abort = () => this.finish(new Error("Preview request cancelled"));

  constructor(private readonly request: Request, private readonly transport: NativeExchangeTransport) {
    this.stream = new ReadableStream({
      start: controller => { this.controller = controller; },
      pull: () => this.pull(),
      cancel: () => this.finish(undefined, true),
    }, { highWaterMark: 0 });
  }
  start(open: PreviewHostOpen): Promise<Response> {
    this.request.signal.addEventListener("abort", this.abort, { once: true });
    try { this.id = this.transport.open(open, message => this.output(message), this.abort); }
    catch { this.finish(new Error("Preview exchange unavailable")); }
    if (this.request.signal.aborted) this.abort();
    return this.response.promise;
  }
  private pull(): void {
    this.demanded = true;
    if (!this.ended && this.unacknowledged) this.acknowledge();
  }
  private acknowledge(): void {
    this.demanded = false; this.unacknowledged = false;
    this.transport.input(this.id, { type: "pull" });
  }
  private output(message: PreviewHostOutput): void {
    if (this.ended) return;
    switch (message.type) {
      case "accepted": return;
      case "error": this.finish(new Error("Preview dispatcher rejected request")); return;
      case "head": this.head(message); return;
      case "end": this.finish(this.receivedHead ? undefined : new Error("Missing preview head")); return;
      case "data": this.data(message.chunk); return;
    }
  }
  private head(message: Extract<PreviewHostOutput, { type: "head" }>): void {
    if (this.receivedHead) { this.finish(new Error("Duplicate preview response head")); return; }
    this.receivedHead = true;
    const bodyless = this.request.method === "HEAD" || [204, 205, 304].includes(message.status);
    this.response.resolve(new Response(bodyless ? null : this.stream, { status: message.status, statusText: message.statusText, headers: message.headers }));
    if (bodyless) this.finish();
  }
  private data(chunk: Uint8Array<ArrayBuffer>): void {
    if (!this.receivedHead || this.unacknowledged) { this.finish(new Error("Preview body exceeded pull credit")); return; }
    this.unacknowledged = true;
    this.controller.enqueue(chunk);
    if (this.demanded) this.acknowledge();
  }
  private finish(error?: Error, cancelled = false): void {
    if (this.ended) return;
    this.ended = true;
    this.request.signal.removeEventListener("abort", this.abort);
    try {
      if (this.id && this.transport.connected()) this.transport.input(this.id, { type: "end" });
    } finally {
      if (this.id) this.transport.retire(this.id);
      if (error) { this.controller.error(error); this.response.reject(error); }
      else if (!cancelled) this.controller.close();
    }
  }
}

export class NativeSocketExchange {
  private id = "";
  private ended = false;
  private accepted = false;
  constructor(private readonly socket: Duplex, private readonly head: Buffer, private readonly transport: NativeExchangeTransport) {}

  start(open: PreviewHostOpen): void {
    this.socket.pause();
    this.socket.on("data", (chunk: Buffer) => this.input(chunk));
    this.socket.once("close", () => this.finish());
    this.socket.once("error", () => this.finish());
    try { this.id = this.transport.open(open, message => this.output(message), () => this.finish()); }
    catch { this.finish(); }
  }
  private input(chunk: Buffer): void {
    try { this.transport.input(this.id, { type: "data", chunk: Uint8Array.from(chunk) }); }
    catch { this.finish(); }
  }
  private output(message: PreviewHostOutput): void {
    if (this.ended) return;
    if (message.type === "accepted") { this.accept(); return; }
    if (message.type !== "data") { this.finish(message.type === "end"); return; }
    if (!this.accepted || this.socket.writableLength > MAX_FRAME) { this.finish(); return; }
    this.socket.write(message.chunk);
  }
  private accept(): void {
    if (this.accepted) { this.finish(); return; }
    this.accepted = true;
    if (this.head.byteLength) this.transport.input(this.id, { type: "data", chunk: Uint8Array.from(this.head) });
    this.socket.resume();
  }
  private finish(graceful = false): void {
    if (this.ended) return;
    this.ended = true;
    if (graceful) this.socket.end(); else this.socket.destroy();
    if (this.id) this.transport.retire(this.id);
    if (this.id && this.transport.connected()) this.transport.input(this.id, { type: "end" });
  }
}
