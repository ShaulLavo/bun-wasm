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
// Adapted from Bun src/js/node/http2.ts. See docs/bun-patches.md.
(function (internal: {
  builtin(name: "node:process"): {
    nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
    emitWarning(message: string, type: string): void;
  };
  require(name: "node_stream_core"): {
    Stream: new(options?: unknown) => BunWasm.NodeEmitter;
    validators: {
      validateString(value: unknown, name: string): void;
      validateFunction(value: unknown, name: string): void;
      validateObject(value: unknown, name: string): void;
    };
    errors: { codes: Record<string, new(...args: unknown[]) => Error> };
  };
}) {
  const { Stream, validators, errors } = internal.require("node_stream_core");
  const process = internal.builtin("node:process");
  type Headers = Record<string, unknown>;
  type Callback = (error?: unknown) => void;
  type PushCallback = (error: unknown, response?: Http2ServerResponse) => void;
  type PushStreamCallback = (error: unknown, stream: Http2Stream) => void;
  interface Http2Stream extends BunWasm.NodeEmitter {
    headersSent: boolean;
    headRequest: boolean;
    closed?: boolean;
    destroyed: boolean;
    writable: boolean;
    readable: boolean;
    writableEnded: boolean;
    writableCorked: number;
    writableHighWaterMark: number;
    writableObjectMode: boolean;
    writableNeedDrain: boolean;
    writableFinished: boolean;
    writableLength: number;
    session?: { socket: object; setTimeout(msecs: number, callback?: Callback): unknown };
    respond(headers: Headers, options: { endStream: boolean; waitForTrailers: boolean; sendDate: boolean }): void;
    additionalHeaders(headers: Headers): void;
    sendTrailers(headers: Headers): void;
    write(chunk: unknown, encoding?: unknown, callback?: (...args: unknown[]) => void): boolean;
    end(): unknown;
    destroy(error?: unknown): unknown;
    cork(): void;
    uncork(): void;
    setTimeout(msecs: number, callback?: Callback): unknown;
    pushStream(headers: Headers, options: object, callback: PushStreamCallback): void;
  }
  const responses = new WeakMap<Http2Stream, Http2ServerResponse>();
  const sockets = new WeakMap<Http2Stream, Http2Stream>();
  const closed = Symbol("close-response");
  const trailers = new WeakMap<Http2Stream, Headers>();
  let warnedStatus = false;
  let warnedConnection = false;
  const error = (code: string, message: string, Kind = Error) => Object.assign(new Kind(message), { code });
  const headersSent = () => error("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated.");
  const invalidStream = () => error("ERR_HTTP2_INVALID_STREAM", "The stream has been destroyed");
  const invalidStatus = (code: number) => error("ERR_HTTP2_STATUS_INVALID", `Invalid status code: ${code}`, RangeError);
  const invalidToken = (name: string) => error("ERR_INVALID_HTTP_TOKEN", `Header name must be a valid HTTP token ["${name}"]`, TypeError);
  const normalize = (name: string) => name.trim().toLowerCase();

  function statusMessageWarn(): void {
    if (warnedStatus) return;
    warnedStatus = true;
    process.emitWarning("Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)", "UnsupportedWarning");
  }
  function validHeader(name: string, value: unknown): boolean {
    if (!name || name.includes(" ")) throw invalidToken(name);
    if ([":status", ":method", ":path", ":authority", ":scheme"].includes(name)) {
      throw error("ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED", "Cannot set HTTP/2 pseudo-headers", TypeError);
    }
    if (value === undefined || value === null) {
      throw error("ERR_HTTP2_INVALID_HEADER_VALUE", `Invalid value "${value}" for header "${name}"`, TypeError);
    }
    if (name !== "connection" || value === "trailers") return true;
    if (!warnedConnection) process.emitWarning("The provided connection header is not valid, the value will be dropped from the header and will never be in use.", "UnsupportedWarning");
    warnedConnection = true;
    return false;
  }
  function linkHeaderValue(value: unknown): string {
    const invalid = () => new errors.codes.ERR_INVALID_ARG_VALUE("hints", value,
      'must be an array or string of format "</styles.css>; rel=preload; as=style"');
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const link of values) {
      if (link === undefined || !/^(?:<[^>]*>)(?:\s*;\s*[^;"\s=]+(?:=(")?[^;"\s]*\1)?)*$/.test(`${link}`) || /[\r\n]/.test(`${link}`)) throw invalid();
    }
    if (typeof value !== "string" && !Array.isArray(value)) throw invalid();
    return values.join(", ");
  }
  function isCallback(value: unknown): value is (...args: unknown[]) => void { return typeof value === "function"; }
  function onStreamDrain(this: Http2Stream): void { responses.get(this)?.emit("drain"); }
  function onStreamTrailersReady(this: Http2Stream): void {
    const response = responses.get(this);
    if (response) this.sendTrailers(trailers.get(this) ?? {});
  }
  function onStreamClose(this: Http2Stream): void { responses.get(this)?.[closed](); }
  function onStreamTimeout(this: Http2ServerResponse): void { this.emit("timeout"); }
  function socketProperty(prop: string | symbol): void {
    if (["write", "read", "pause", "resume"].includes(String(prop))) {
      throw error("ERR_HTTP2_NO_SOCKET_MANIPULATION", "HTTP/2 sockets should not be directly manipulated (e.g. read and written)");
    }
  }
  function socketTarget(stream: Http2Stream, prop: string | symbol): object {
    if (["on", "once", "end", "emit", "destroy", "writable", "destroyed", "readable"].includes(String(prop))) return stream;
    if (prop === "setTimeout") return stream.session ?? stream;
    return stream.session?.socket ?? stream;
  }
  const socketHandler: ProxyHandler<Http2Stream> = {
    has(stream, prop) { return prop in stream || prop in (stream.session?.socket ?? stream); },
    get(stream, prop) {
      socketProperty(prop);
      if (prop === "readable" && stream.destroyed) return false;
      const target = socketTarget(stream, prop);
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(stream, prop, value: unknown) {
      socketProperty(prop);
      return Reflect.set(socketTarget(stream, prop), prop, value);
    },
    getPrototypeOf(stream) { return Object.getPrototypeOf(stream.session?.socket ?? stream); },
  };

  class Http2ServerResponse extends Stream {
    writable = true;
    req: unknown = undefined;
    #headers: Headers = Object.create(null);
    #stream: Http2Stream;
    #state = { closed: false, ending: false, destroyed: false, headRequest: false, sendDate: true, statusCode: 200 };
    constructor(stream: Http2Stream, options?: unknown) {
      super(options);
      this.#stream = stream;
      responses.set(stream, this);
      trailers.set(stream, Object.create(null));
      stream.on("drain", onStreamDrain);
      stream.on("close", onStreamClose);
      stream.on("wantTrailers", onStreamTrailersReady);
      stream.on("timeout", onStreamTimeout.bind(this));
    }
    get _header() { return this.headersSent; }
    get writableEnded() { return this.#state.ending; }
    get finished() { return this.#state.ending; }
    get stream() { return this.#stream; }
    get headersSent() { return this.#stream.headersSent; }
    get sendDate() { return this.#state.sendDate; }
    set sendDate(value: boolean) { this.#state.sendDate = Boolean(value); }
    get statusCode() { return this.#state.statusCode; }
    set statusCode(code: number) {
      code |= 0;
      if (code >= 100 && code < 200) throw error("ERR_HTTP2_INFO_STATUS_NOT_ALLOWED", "Informational status codes cannot be used", RangeError);
      if (code < 100 || code > 599) throw invalidStatus(code);
      this.#state.statusCode = code;
    }
    get writableCorked() { return this.#stream.writableCorked; }
    get writableHighWaterMark() { return this.#stream.writableHighWaterMark; }
    get writableObjectMode() { return this.#stream.writableObjectMode; }
    get writableNeedDrain() { return this.#stream.writableNeedDrain; }
    get writableFinished() { return this.#stream.writableFinished; }
    get writableLength() { return this.#stream.writableLength; }
    get socket(): Http2Stream | undefined {
      if (this.#state.closed) return undefined;
      let socket = sockets.get(this.#stream);
      if (!socket) { socket = new Proxy(this.#stream, socketHandler); sockets.set(this.#stream, socket); }
      return socket;
    }
    get connection() { return this.socket; }
    get statusMessage() { statusMessageWarn(); return ""; }
    set statusMessage(_message: string) { statusMessageWarn(); }
    getHeader(name: string): unknown { validators.validateString(name, "name"); return this.#headers[normalize(name)]; }
    getHeaderNames() { return Object.keys(this.#headers); }
    getHeaders(): Headers { return Object.assign(Object.create(null), this.#headers); }
    hasHeader(name: string): boolean { validators.validateString(name, "name"); return Object.hasOwn(this.#headers, normalize(name)); }
    removeHeader(name: string): void {
      validators.validateString(name, "name");
      if (this.headersSent) throw headersSent();
      name = normalize(name);
      if (name === "date") { this.#state.sendDate = false; return; }
      delete this.#headers[name];
    }
    #setHeader(name: string, value: unknown, append: boolean): void {
      name = normalize(name);
      if (!validHeader(name, value)) return;
      if (name[0] === ":" && name !== ":protocol") throw error("ERR_HTTP2_INVALID_PSEUDOHEADER", `"${name}" is an invalid pseudoheader or is used incorrectly`, TypeError);
      if (name[0] !== ":" && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) this.destroy(invalidToken(name));
      const old = this.#headers[name];
      if (!append || !old) { this.#headers[name] = value; return; }
      const previous: unknown[] = Array.isArray(old) ? old : [old];
      for (const item of Array.isArray(value) ? value : [value]) previous.push(item);
      this.#headers[name] = previous;
    }
    setHeader(name: string, value: unknown): void {
      validators.validateString(name, "name");
      if (this.headersSent) throw headersSent();
      this.#setHeader(name, value, false);
    }
    appendHeader(name: string, value: unknown): void {
      validators.validateString(name, "name");
      if (this.headersSent) throw headersSent();
      this.#setHeader(name, value, true);
    }
    setTrailer(name: string, value: unknown): void {
      validators.validateString(name, "name");
      name = normalize(name);
      validHeader(name, value);
      const values = trailers.get(this.#stream);
      if (values) values[name] = value;
    }
    addTrailers(headers: Headers): void { for (const key of Object.keys(headers)) this.setTrailer(key, headers[key]); }
    flushHeaders(): void { if (!this.#state.closed && !this.headersSent) this.writeHead(this.#state.statusCode); }
    #writeHeaders(headers: unknown): void {
      if (typeof headers !== "object") return;
      if (headers === null) throw new TypeError("Cannot convert undefined or null to object");
      if (!Array.isArray(headers)) {
        for (const [name, value] of Object.entries(headers)) this.#setHeader(name, value, false);
        return;
      }
      const pairs: [string, unknown][] = [];
      if (headers.length && Array.isArray(headers[0])) {
        for (const pair of headers) pairs.push([pair[0], pair[1]]);
      } else {
        if (headers.length % 2) throw new errors.codes.ERR_INVALID_ARG_VALUE("headers", headers);
        for (let index = 0; index < headers.length; index += 2) pairs.push([headers[index], headers[index + 1]]);
      }
      for (const [name] of pairs) this.removeHeader(name);
      for (const [name, value] of pairs) this.#setHeader(name, value, true);
    }
    writeHead(statusCode: number, statusMessage?: unknown, headers?: unknown): this {
      if (this.#state.closed || this.#stream.destroyed || this.#stream.closed) return this;
      if (this.headersSent) throw headersSent();
      if (typeof statusMessage === "string") statusMessageWarn();
      this.#writeHeaders(headers === undefined && typeof statusMessage === "object" ? statusMessage : headers);
      this.#state.statusCode = statusCode;
      this.#headers[":status"] = statusCode;
      this.#stream.respond(this.#headers, { endStream: this.#state.ending, waitForTrailers: true, sendDate: this.#state.sendDate });
      return this;
    }
    cork(): void { this.#stream.cork(); }
    uncork(): void { this.#stream.uncork(); }
    write(chunk: unknown, encoding?: unknown, callback?: (...args: unknown[]) => void): boolean {
      if (typeof encoding === "function") { const done = encoding; callback = (...args: unknown[]) => done(...args); encoding = "utf8"; }
      const failure = this.#state.ending ? new errors.codes.ERR_STREAM_WRITE_AFTER_END() : this.#state.closed ? invalidStream() : undefined;
      if (failure) {
        if (typeof callback === "function") process.nextTick(callback, failure);
        this.destroy(failure);
        return false;
      }
      if (this.#state.destroyed) return false;
      if (!this.headersSent) this.writeHead(this.#state.statusCode);
      return this.#stream.write(chunk, encoding, callback);
    }
    end(chunk?: unknown, encoding?: unknown, callback?: (...args: unknown[]) => void): this {
      if (isCallback(chunk)) { callback = chunk; chunk = null; }
      else if (isCallback(encoding)) { callback = encoding; encoding = "utf8"; }
      const stream = this.#stream;
      if ((this.#state.closed || this.#state.ending) && this.#state.headRequest === stream.headRequest) {
        if (typeof callback === "function") process.nextTick(callback);
        return this;
      }
      if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
      this.#state.headRequest = stream.headRequest;
      this.#state.ending = true;
      if (typeof callback === "function") {
        const done = callback;
        const onFinish = () => {
          stream.removeListener("finish", onFinish);
          this.removeListener("finish", onFinish);
          done();
        };
        if (stream.writableEnded) this.once("finish", callback);
        else {
          stream.once("finish", onFinish);
          this.once("finish", onFinish);
        }
      }
      if (!this.headersSent) this.writeHead(this.#state.statusCode);
      if (this.#state.closed || stream.destroyed) this[closed]();
      else stream.end();
      return this;
    }
    [closed](): void {
      if (this.#state.headRequest !== this.#stream.headRequest || !responses.has(this.#stream)) return;
      this.#state.closed = true;
      this.#stream.removeListener("wantTrailers", onStreamTrailersReady);
      responses.delete(this.#stream);
      this.emit("finish");
      this.emit("close");
    }
    destroy(failure?: unknown): void {
      if (this.#state.destroyed) return;
      this.#state.destroyed = true;
      this.#stream.destroy(failure);
    }
    setTimeout(msecs: number, callback?: Callback): void {
      if (!this.#state.closed) this.#stream.setTimeout(msecs, callback);
    }
    createPushResponse(headers: Headers, callback: PushCallback): void {
      validators.validateFunction(callback, "callback");
      if (this.#state.closed) { process.nextTick(() => callback(invalidStream())); return; }
      this.#stream.pushStream(headers, {}, (failure, stream) => {
        if (failure) { callback(failure); return; }
        callback(null, new Http2ServerResponse(stream));
      });
    }
    writeContinue(): boolean {
      if (this.headersSent || this.#state.closed) return false;
      this.#stream.additionalHeaders({ ":status": 100 });
      return true;
    }
    writeInformation(statusCode: number, headers: Headers): boolean {
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 199 || statusCode === 101) throw invalidStatus(statusCode);
      if (this.headersSent || this.#state.closed) return false;
      this.#stream.additionalHeaders(Object.assign({}, headers, { ":status": statusCode }));
      return true;
    }
    writeEarlyHints(hints: Headers): boolean {
      validators.validateObject(hints, "hints");
      const link = linkHeaderValue(hints.link);
      if (!link.length || this.headersSent || this.#state.closed) return false;
      const headers = Object.fromEntries(Object.entries(hints).filter(([name]) => name !== "link"));
      this.#stream.additionalHeaders(Object.assign(headers, { ":status": 103, Link: link }));
      return true;
    }
  }
  return Http2ServerResponse;
})
