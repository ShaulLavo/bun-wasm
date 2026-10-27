/*
 * Portions of this code are derived from the Node.js project (https://nodejs.org/),
 * originally developed by Node.js contributors and Joyent, Inc.
 *
 * Copyright Node.js contributors. All rights reserved.
 * Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * Modifications were made to the original code.
 */
// Ported from Bun src/js/node/http2.ts. See docs/bun-patches/http2-request-compatibility-class.md.
(function (internal: {
  builtin(name: "node:process"): { nextTick(callback: () => void): void };
  builtin(name: "node:stream"): {
    Readable: new(options: object) => BunWasm.NodeReadable & {
      readableEnded: boolean;
      _readableState: { resumeScheduled: boolean };
    };
  };
  require(name: "node_stream_core"): {
    validators: { validateString(value: unknown, name: string): void };
    errors: { codes: Record<string, new(...args: unknown[]) => Error> };
  };
}) {
  const { validators, errors } = internal.require("node_stream_core");
  const { Readable } = internal.builtin("node:stream");
  const process = internal.builtin("node:process");
  type Headers = Record<string, unknown>;
  interface Http2Stream extends BunWasm.NodeEmitter {
    destroyed: boolean;
    readable: boolean;
    session?: { socket: object; setTimeout(msecs: number, callback?: () => void): unknown };
    pause(): void;
    resume(): void;
    setTimeout(msecs: number, callback?: () => void): unknown;
  }
  const requests = new WeakMap<Http2Stream, Http2ServerRequest>();
  const sockets = new WeakMap<Http2Stream, Http2Stream>();
  const receiveTrailers = Symbol("trailers");
  const abort = Symbol("abort");
  const close = Symbol("close");
  function onData(this: Http2Stream, chunk: unknown): void {
    const request = requests.get(this);
    if (request && !request.push(chunk)) this.pause();
  }
  function onEnd(this: Http2Stream): void { requests.get(this)?.push(null); }
  function onTrailers(this: Http2Stream, headers: Headers, _flags: number, raw: string[]): void {
    requests.get(this)?.[receiveTrailers](headers, raw);
  }
  function onError(): void { /* Bun's compatibility objects do not forward stream errors. */ }
  function onAborted(this: Http2Stream): void { requests.get(this)?.[abort](); }
  function onClose(this: Http2Stream): void { requests.get(this)?.[close](); }
  function socketTarget(stream: Http2Stream, prop: string | symbol): object {
    if (["write", "read", "pause", "resume"].includes(String(prop))) {
      throw Object.assign(new Error("HTTP/2 sockets should not be directly manipulated (e.g. read and written)"), { code: "ERR_HTTP2_NO_SOCKET_MANIPULATION" });
    }
    if (["on", "once", "end", "emit", "destroy", "writable", "destroyed", "readable"].includes(String(prop))) return stream;
    if (prop === "setTimeout") return stream.session ?? stream;
    return stream.session?.socket ?? stream;
  }
  const socketHandler: ProxyHandler<Http2Stream> = {
    has(stream, prop) { return prop in stream || prop in (stream.session?.socket ?? stream); },
    get(stream, prop) {
      if (prop === "readable") return !stream.destroyed && (requests.get(stream)?.readable ?? stream.readable);
      const target = socketTarget(stream, prop);
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(stream, prop, value: unknown) { return Reflect.set(socketTarget(stream, prop), prop, value); },
    getPrototypeOf(stream) { return Object.getPrototypeOf(stream.session?.socket ?? stream); },
  };
  class Http2ServerRequest extends Readable {
    #stream: Http2Stream;
    #headers: Headers;
    #rawHeaders: string[] | undefined;
    #trailers: Headers = {};
    #rawTrailers: string[] = [];
    #state = { closed: false, didRead: false, aborted: false };
    constructor(stream: Http2Stream, headers: Headers, options?: object, rawHeaders?: string[]) {
      super({ autoDestroy: false, ...options });
      this.#stream = stream;
      this.#headers = headers;
      this.#rawHeaders = rawHeaders;
      requests.set(stream, this);
      stream.on("trailers", (...args: unknown[]) => Reflect.apply(onTrailers, stream, args));
      stream.on("end", onEnd);
      stream.on("error", onError);
      stream.on("aborted", onAborted);
      stream.on("close", onClose);
      stream.on("timeout", () => this.emit("timeout"));
      this.on("pause", () => stream.pause());
      this.on("resume", () => stream.resume());
    }
    get aborted() { return this.#state.aborted; }
    get complete() { return this.aborted || this.readableEnded || this.#state.closed || this.#stream.destroyed; }
    get stream() { return this.#stream; }
    get headers() { return this.#headers; }
    get rawHeaders() { return this.#rawHeaders; }
    get trailers() { return this.#trailers; }
    get rawTrailers() { return this.#rawTrailers; }
    get httpVersionMajor() { return 2; }
    get httpVersionMinor() { return 0; }
    get httpVersion() { return "2.0"; }
    get socket(): Http2Stream {
      let socket = sockets.get(this.#stream);
      if (!socket) { socket = new Proxy(this.#stream, socketHandler); sockets.set(this.#stream, socket); }
      return socket;
    }
    get connection() { return this.socket; }
    _read(_size: number): void {
      if (this.#state.didRead) { process.nextTick(() => this.#stream.resume()); return; }
      this.#state.didRead = true;
      this.#stream.on("data", onData);
    }
    get method() { return this.#headers[":method"]; }
    set method(value: unknown) {
      validators.validateString(value, "method");
      if (!String(value).trim()) throw new errors.codes.ERR_INVALID_ARG_VALUE("method", value);
      this.#headers[":method"] = value;
    }
    get authority() { return this.#headers[":authority"] !== undefined ? this.#headers[":authority"] : this.#headers.host; }
    get scheme() { return this.#headers[":scheme"]; }
    get url() { return this.#headers[":path"]; }
    set url(value: unknown) { this.#headers[":path"] = value; }
    setTimeout(msecs: number, callback?: () => void): this {
      if (!this.#state.closed) this.#stream.setTimeout(msecs, callback);
      return this;
    }
    [receiveTrailers](headers: Headers, raw: string[]): void {
      Object.assign(this.#trailers, headers);
      this.#rawTrailers.push(...raw);
    }
    [abort](): void {
      if (this.#state.closed) return;
      this.#state.aborted = true;
      this.emit("aborted");
    }
    [close](): void {
      this.#state.closed = true;
      this.push(null);
      if (!this.#state.didRead && !this._readableState.resumeScheduled) this.resume();
      requests.delete(this.#stream);
      this.emit("close");
    }
  }
  return Http2ServerRequest;
})
