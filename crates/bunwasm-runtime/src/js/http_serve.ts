(function () {
  type Pair = [string, string];
  type Head = { method: string; target: string; version: string; headers: Pair[]; headLength: number };
  type Message = Head & { body: Uint8Array; length: number; trailers?: Pair[] };
  type Outcome = boolean | symbol;
  type Connection = {
    closed: boolean; busy: boolean; serverClosing?: boolean;
    upgraded?: { activate(head: Uint8Array): void };
    onData: ((bytes: Uint8Array) => void) | null;
    onEnd: (() => void) | null;
    onError: ((error: unknown) => void) | null;
    onClose?: (() => void) | null;
    canRead?: () => boolean;
    write(bytes: Uint8Array): void;
    end(): void;
    destroy(error?: unknown): void;
    startReading(): void;
  };
  type Output = { kind: "data"; bytes: Uint8Array } | { kind: "trailers"; pairs: Pair[] } | { kind: "end" };
  type Framing = { kind: "none" } | { kind: "fixed"; length: number } | { kind: "chunked" } | { kind: "eof" };
  type Decoder = { push(bytes: Uint8Array): { output: Output[]; remainder: Uint8Array }; end(): Output[] };
  type Receiver = {
    response: Promise<Outcome>;
    receive(body: Uint8Array, trailers: Pair[], complete: boolean): boolean;
    canRead(): boolean;
    onRead(callback: () => void): void;
    abort(): void;
  };
  type Options = {
    parseHead(bytes: Uint8Array): Head | null;
    parseRequest(bytes: Uint8Array): Message | null;
    handleRequest(request: Message, connection: Connection, keepAlive: boolean): Outcome | Promise<Outcome>;
    startRequest?: (head: Head, connection: Connection, keepAlive: boolean) => Receiver;
    wantsKeepAlive(head: Head): boolean;
    body: { BodyDecoder: new(framing: Framing) => Decoder; responseFraming(headers: string[], method: string, status: number): Framing };
    upgraded: symbol;
    reportError(error: unknown): void;
    wake?: (delay: number) => void;
  };
  type Pending = { receiver: Receiver; decoder: Decoder; output: Output[]; trailers: Pair[]; keepAlive: boolean };
  const empty = new Uint8Array(0);
  const encoder = new TextEncoder();

  function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
    const result = new Uint8Array(first.length + second.length);
    result.set(first);
    result.set(second, first.length);
    return result;
  }

  function framing(head: Head, body: Options["body"]): Framing {
    if (!head.headers.some(([name]) => /^(content-length|transfer-encoding)$/i.test(name))) return { kind: "none" };
    return body.responseFraming(head.headers.flatMap(pair => pair), "POST", 200);
  }

  function serve(connection: Connection, options: Options): void {
    let buffer: Uint8Array = empty;
    let pending: Pending | null = null;
    let busy = false;
    let pumping = false;
    let ended = false;
    const previousClose = connection.onClose;
    connection.onClose = () => { pending?.receiver.abort(); previousClose?.(); };

    function respond(response: Outcome | Promise<Outcome>, keepAlive: boolean): void {
      busy = true;
      connection.busy = true;
      Promise.resolve(response).catch(error => {
        options.reportError(error);
        connection.write(encoder.encode("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
        return false;
      }).then(outcome => {
        if (outcome === options.upgraded) {
          connection.upgraded?.activate(buffer);
          buffer = empty;
          return;
        }
        busy = false;
        connection.busy = false;
        if (outcome === false || !keepAlive || connection.serverClosing) { connection.end(); return; }
        next();
        options.wake?.(0);
      });
    }

    function receive(active: Pending): void {
      if (!active.output.length) {
        const decoded = active.decoder.push(buffer);
        active.output = decoded.output;
        buffer = decoded.remainder;
      }
      while (active.output.length && !connection.closed) {
        const output = active.output.shift()!;
        if (output.kind === "trailers") { active.trailers = output.pairs; continue; }
        if (output.kind === "data") {
          if (!active.receiver.receive(output.bytes, [], false)) return;
          continue;
        }
        active.receiver.receive(empty, active.trailers, true);
        pending = null;
        respond(active.receiver.response, active.keepAlive);
        return;
      }
    }

    function begin(head: Head, start: NonNullable<Options["startRequest"]>): void {
      const decoder = new options.body.BodyDecoder(framing(head, options.body));
      const keepAlive = options.wantsKeepAlive(head) && !ended;
      const receiver = start(head, connection, keepAlive);
      buffer = buffer.slice(head.headLength);
      pending = { receiver, decoder, keepAlive, output: [], trailers: [] };
      connection.busy = true;
      receiver.onRead(() => { next(); options.wake?.(0); });
      receive(pending);
    }

    function advance(): void {
      if (pending) { receive(pending); return; }
      const head = options.parseHead(buffer);
      if (!head) { if (ended) connection.end(); return; }
      const upgrade = head.headers.some(([name]) => name.toLowerCase() === "upgrade");
      if (options.startRequest && !upgrade) { begin(head, options.startRequest); return; }
      const request = options.parseRequest(buffer);
      if (!request) { if (ended) connection.end(); return; }
      buffer = buffer.slice(request.length);
      const keepAlive = options.wantsKeepAlive(request) && !ended;
      respond(Promise.resolve().then(() => options.handleRequest(request, connection, keepAlive)), keepAlive);
    }

    function next(): void {
      if (busy || pumping || connection.closed) return;
      pumping = true;
      try { advance(); }
      catch {
        connection.write(encoder.encode("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
        connection.end();
      } finally { pumping = false; }
    }

    connection.canRead = () => !options.startRequest || (!busy && (!pending || pending.receiver.canRead()));
    connection.onData = bytes => { buffer = buffer.length ? concat(buffer, bytes) : bytes; next(); };
    connection.onEnd = () => {
      ended = true;
      if (pending) { pending.receiver.abort(); connection.end(); return; }
      if (!busy) next();
    };
    connection.onError = () => pending?.receiver.abort();
    connection.startReading();
  }

  type Incoming = {
    complete: boolean; aborted: boolean; destroyed: boolean;
    trailers: Record<string, string | string[]>; rawTrailers: string[]; trailersDistinct: Record<string, string[]>;
    _readableState: { highWaterMark: number }; _read(): void;
    push(bytes: Uint8Array | null): boolean;
    emit(event: string): void;
    listenerCount(event: string): number;
    destroy(error?: unknown): void;
  };
  type IncomingOptions = {
    request: Incoming; socket: { pause(): void; resume(): void }; response: Promise<Outcome>;
    highWaterMark?: number;
    buffer(bytes: Uint8Array): Uint8Array;
    setHeaders(target: { headers: Incoming["trailers"]; rawHeaders: string[]; headersDistinct: Incoming["trailersDistinct"] }, pairs: Pair[]): void;
  };
  function incoming(options: IncomingOptions): Receiver {
    const { request, socket } = options;
    let ready = true;
    let onRead = () => {};
    if (options.highWaterMark !== undefined) request._readableState.highWaterMark = options.highWaterMark;
    request._read = () => { ready = true; socket.resume(); onRead(); };
    return {
      response: options.response,
      canRead: () => ready,
      onRead(callback) { onRead = callback; },
      receive(bytes, trailers, complete) {
        if (request.destroyed) return false;
        if (bytes.length && !request.push(options.buffer(bytes))) { ready = false; socket.pause(); }
        if (!complete) return ready;
        options.setHeaders({ headers: request.trailers, rawHeaders: request.rawTrailers, headersDistinct: request.trailersDistinct }, trailers);
        request.complete = true;
        request.push(null);
        return true;
      },
      abort() {
        if (request.complete || request.destroyed) return;
        request.aborted = true;
        request.emit("aborted");
        const error = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
        request.destroy(request.listenerCount("error") ? error : undefined);
      },
    };
  }
  return { serve, incoming };
})
