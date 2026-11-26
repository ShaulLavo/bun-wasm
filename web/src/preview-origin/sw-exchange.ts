// One HTTP request relayed from the preview-origin service worker to the IDE page.
import type { PreviewHostInput, PreviewHostOutput } from "waffle/browser/preview-host";

export type ResponseHead = Extract<PreviewHostOutput, { type: "head" }>;

export interface HttpExchangeOptions {
  /** Posts one input for this exchange to the IDE page. */
  send(input: PreviewHostInput): void;
  /** Builds the browser response once the head arrived. */
  respond(head: ResponseHead, body: ReadableStream<Uint8Array>): Promise<Response> | Response;
  /** The answer when the exchange ends before any head. */
  failed(message: string): Response;
  /** Called once, when the exchange no longer needs its slot. */
  released(): void;
  signal?: AbortSignal;
  /** A hang cap for the response head, never a speed limit. */
  headTimeoutMs: number;
}

/** Streams a response body with one pull credit per chunk, as Waffle's dispatcher expects. */
export class HttpExchange {
  readonly response: Promise<Response>;
  private readonly settle = Promise.withResolvers<Response>();
  private readonly stream: ReadableStream<Uint8Array>;
  // ReadableStream.start runs synchronously during construction.
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private state: "head" | "body" | "done" = "head";
  private demanded = false;
  private unacknowledged = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.cancel();

  constructor(private readonly options: HttpExchangeOptions) {
    this.response = this.settle.promise;
    this.stream = new ReadableStream<Uint8Array>({
      start: controller => { this.controller = controller; },
      pull: () => this.pull(),
      cancel: () => this.cancel(),
    }, { highWaterMark: 0 });
    this.timer = setTimeout(() => this.fail("Preview server timed out waiting for response headers", true), options.headTimeoutMs);
    // The caller opens no exchange for a request that is already aborted, so only a later abort is heard here.
    options.signal?.addEventListener("abort", this.abort, { once: true });
  }

  output(message: PreviewHostOutput): void {
    if (this.state === "done") return;
    switch (message.type) {
      case "accepted": return;
      case "head": this.head(message); return;
      case "data": this.data(message.chunk); return;
      case "end": this.end(); return;
      case "error": this.fail(message.message, true); return;
    }
  }

  /** The transport or the IDE page went away. */
  fail(message: string, tellPeer = false): void {
    if (this.state === "done") return;
    const before = this.state;
    this.release(tellPeer);
    if (before === "head") this.settle.resolve(this.options.failed(message));
    else this.controller.error(new TypeError(message));
  }

  private head(message: ResponseHead): void {
    if (this.state !== "head") { this.fail("Duplicate preview response head", true); return; }
    this.state = "body";
    clearTimeout(this.timer);
    Promise.resolve()
      .then(() => this.options.respond(message, this.stream))
      .then(response => this.settle.resolve(response), error => this.settle.resolve(this.options.failed(String(error))));
  }

  private data(chunk: Uint8Array): void {
    if (this.state !== "body") { this.fail("Preview body arrived before its head", true); return; }
    this.unacknowledged = true;
    this.controller.enqueue(chunk);
    if (this.demanded) this.acknowledge();
  }

  private end(): void {
    if (this.state === "head") { this.fail("Preview server closed the connection before response headers"); return; }
    this.release(false);
    this.controller.close();
  }

  private pull(): void {
    this.demanded = true;
    if (this.state === "body" && this.unacknowledged) this.acknowledge();
  }

  private acknowledge(): void {
    this.demanded = false;
    this.unacknowledged = false;
    this.options.send({ type: "pull" });
  }

  /** The page stopped reading: tell the IDE, which closes the guest connection. */
  private cancel(): void {
    if (this.state === "done") return;
    const before = this.state;
    this.release(true);
    if (before === "head") this.settle.resolve(this.options.failed("Preview request aborted"));
    // A no-op when the reader itself cancelled the stream.
    else this.controller.error(new DOMException("Preview request aborted", "AbortError"));
  }

  private release(tellPeer: boolean): void {
    this.state = "done";
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.abort);
    if (tellPeer) this.options.send({ type: "end" });
    this.options.released();
  }
}
