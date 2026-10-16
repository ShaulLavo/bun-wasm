// Networking over the bun_wasm host ABI (docs/host-abi.md): fetch, Bun.serve,
// node:http and node:net. Only loaded when the host provides the slots.
//
// Everything here is non-blocking. Operations that must wait register a
// "waiter" with a step() function; the Rust event loop calls pumpIo() (which
// runs every waiter's step once) whenever the host's poll() reports news, and
// keeps the process alive while ioPending() is non-zero.
(function (internal) {
  "use strict";
  const native = internal.native;
  const caps = native.hostCaps;
  const { Request, Response, Headers, ReadableStream, DOMException } = internal.web;

  const ERROR = -1;
  const AGAIN = -2;

  // --- I/O core -------------------------------------------------------------

  // Waiters: { step(): boolean (true = done), ref: boolean, fail(err) }.
  const waiters = new Set();

  function addWaiter(waiter) {
    if (waiter.ref === undefined) waiter.ref = true;
    waiters.add(waiter);
    // A host-owned event loop (engine-host) steps waiters only when woken.
    if (native.wake) native.wake(0);
    return waiter;
  }

  internal.addIoWaiter = addWaiter;

  internal.ioPending = function ioPending() {
    let n = 0;
    for (const w of waiters) if (w.ref) n++;
    return n;
  };

  // Run each waiter once; returns whether anything made progress.
  internal.pumpIo = function pumpIo() {
    let progressed = false;
    for (const waiter of Array.from(waiters)) {
      let result;
      try {
        result = waiter.step();
      } catch (err) {
        waiters.delete(waiter);
        if (waiter.fail) waiter.fail(err);
        else throw err;
        progressed = true;
        continue;
      }
      if (result === true) {
        waiters.delete(waiter);
        progressed = true;
      } else if (result === "progress") {
        progressed = true;
      }
    }
    return progressed;
  };

  function hostError(handle, fallback) {
    const text = native.hostError(handle);
    let info = { name: "Error", message: fallback || "network error" };
    if (typeof text === "string") {
      try {
        info = JSON.parse(text);
      } catch {
        info = { name: "Error", message: text };
      }
    }
    const Ctor = info.name === "TypeError" ? TypeError : Error;
    const err = new Ctor(info.message);
    if (info.code) err.code = info.code;
    if (info.syscall) err.syscall = info.syscall;
    if (info.name && info.name !== "TypeError" && info.name !== "Error") err.name = info.name;
    return err;
  }

  // --- fetch ----------------------------------------------------------------

  async function requestBody(req) {
    if (req.method === "GET" || req.method === "HEAD") return new Uint8Array(0);
    if (req._body === null && !req._stream) return new Uint8Array(0);
    return new Uint8Array(await req.arrayBuffer());
  }

  // Promise of the response head JSON for a fetch handle.
  function waitHead(handle) {
    return new Promise((resolve, reject) => {
      addWaiter({
        step() {
          const head = native.hostFetchHead(handle);
          if (head === AGAIN) return false;
          if (typeof head === "number") {
            reject(hostError(handle, "fetch failed"));
            native.hostClose(handle);
            return true;
          }
          resolve(JSON.parse(head));
          return true;
        },
        fail: reject,
      });
    });
  }

  // Readable stream over a host handle's bytes (fetch bodies, sockets).
  function handleStream(handle, onEnd) {
    let done = false;
    return new ReadableStream({
      pull(controller) {
        if (done) {
          controller.close();
          return undefined;
        }
        return new Promise((resolve, reject) => {
          addWaiter({
            step() {
              const chunk = native.hostRead(handle);
              if (chunk === AGAIN) return false;
              if (chunk === 0) {
                done = true;
                controller.close();
                if (onEnd) onEnd();
              } else if (typeof chunk === "number") {
                done = true;
                reject(hostError(handle, "network error while reading the body"));
                if (onEnd) onEnd();
              } else {
                controller.enqueue(chunk);
              }
              resolve();
              return true;
            },
            fail: reject,
          });
        });
      },
    });
  }

  async function fetch(input, init = {}) {
    const req = input instanceof Request && Object.keys(init).length === 0 ? input : new Request(input, init);
    const signal = init.signal || req.signal;
    if (signal && signal.aborted) throw signal.reason;
    const headers = Array.from(req.headers);
    // Like Bun, identify as Bun unless the caller set a user agent.
    if (!req.headers.has("user-agent")) headers.push(["user-agent", `Bun/${native.platformInfo.version}`]);
    const meta = JSON.stringify({
      method: req.method,
      url: req.url,
      headers,
      redirect: init.redirect || req.redirect || "follow",
    });
    const handle = native.hostFetch(meta, await requestBody(req));
    if (handle < 0) throw hostError(0, "fetch failed");
    let closed = false;
    const closeHandle = () => {
      if (!closed) native.hostClose(handle);
      closed = true;
    };
    // The signal may have fired while the request body was being read.
    const aborted = new Promise((resolve, reject) => {
      if (!signal) return;
      const onAbort = () => {
        closeHandle();
        reject(signal.reason || new DOMException("The operation was aborted.", "AbortError"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    });
    const head = await Promise.race([waitHead(handle), aborted]);
    const nullBody = req.method === "HEAD" || head.status === 204 || head.status === 304;
    const body = nullBody ? null : handleStream(handle, closeHandle);
    if (nullBody) closeHandle();
    const res = new Response(body, {
      status: head.status >= 200 && head.status <= 599 ? head.status : 200,
      statusText: head.statusText || "",
      headers: head.headers,
    });
    Response._setNetwork(res, head.url || req.url, Boolean(head.redirected));
    return res;
  }

  // --- HTTP/1.1 over byte streams ---------------------------------------------

  const STATUS_TEXT = {
    100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    206: "Partial Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
    307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large", 418: "I'm a Teapot",
    422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented",
    502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  internal.httpStatusText = STATUS_TEXT;

  const { validateHeaderName, validateHeaderValue, validateMethod, validatePath, validateStatus, outgoingHeaders } = internal.require("http_common");
  const encoder = new TextEncoder();
  const latin1 = (bytes) => native.latin1Decode(bytes);

  function indexOfCrlfCrlf(bytes, from) {
    for (let i = Math.max(0, from - 3); i + 3 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    }
    return -1;
  }

  // Parse one request head from `bytes`; null if incomplete.
  function parseHead(bytes) {
    const end = indexOfCrlfCrlf(bytes, 0);
    if (end < 0) return null;
    const lines = latin1(bytes.subarray(0, end)).split("\r\n");
    const [method, target, version] = lines[0].split(" ");
    if (!method || !target || !/^HTTP\/1\.[01]$/.test(version || "")) throw new Error("bad request line");
    const headers = [];
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    return { method, target, version, headers, headLength: end + 4 };
  }

  function header(headers, name) {
    const lower = name.toLowerCase();
    const hit = headers.find(([k]) => k.toLowerCase() === lower);
    return hit ? hit[1] : undefined;
  }

  // Decode a chunked body starting at `offset`; null if incomplete, else
  // { body, length } where length counts the consumed bytes.
  function parseChunked(bytes, offset) {
    const parts = [];
    let pos = offset;
    for (;;) {
      let lineEnd = -1;
      for (let i = pos; i + 1 < bytes.length; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10) {
          lineEnd = i;
          break;
        }
      }
      if (lineEnd < 0) return null;
      const size = parseInt(latin1(bytes.subarray(pos, lineEnd)), 16);
      if (Number.isNaN(size)) throw new Error("bad chunk size");
      pos = lineEnd + 2;
      if (size === 0) {
        const trailerEnd = indexOfCrlfCrlf(bytes, pos - 2);
        if (trailerEnd < 0) return null;
        const trailers = latin1(bytes.subarray(pos, trailerEnd + 2)).split("\r\n").filter(Boolean).map(line => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 1).trim()];
        });
        return { body: internal.concatBytes(parts), length: trailerEnd + 4 - offset, trailers };
      }
      if (pos + size + 2 > bytes.length) return null;
      parts.push(bytes.subarray(pos, pos + size));
      pos += size + 2;
    }
  }

  // Parse a complete request (head + body) from a buffer; null if more bytes
  // are needed.
  function parseRequest(bytes) {
    const head = parseHead(bytes);
    if (!head) return null;
    const transferEncoding = (header(head.headers, "transfer-encoding") || "").toLowerCase();
    if (transferEncoding.includes("chunked")) {
      const chunked = parseChunked(bytes, head.headLength);
      if (!chunked) return null;
      return Object.assign(head, { body: chunked.body, length: head.headLength + chunked.length, trailers: chunked.trailers });
    }
    const contentLength = Number(header(head.headers, "content-length") || 0);
    if (bytes.length < head.headLength + contentLength) return null;
    const body = bytes.slice(head.headLength, head.headLength + contentLength);
    return Object.assign(head, { body, length: head.headLength + contentLength });
  }

  function wantsKeepAlive(request) {
    const connection = (header(request.headers, "connection") || "").toLowerCase();
    if (connection.includes("close")) return false;
    if (request.version === "HTTP/1.0") return connection.includes("keep-alive");
    return true;
  }

  function serializeHead(status, statusText, headerPairs) {
    let text = `HTTP/1.1 ${status} ${statusText === undefined ? STATUS_TEXT[status] || "unknown" : statusText}\r\n`;
    for (const [k, v] of headerPairs) text += `${k}: ${v}\r\n`;
    return internal.require("buffer").Buffer.from(text + "\r\n", "latin1");
  }

  // --- connections ------------------------------------------------------------

  // A host connection handle with buffered, non-blocking reads and writes.
  class Connection {
    constructor(handle) {
      this.handle = handle;
      this.queue = [];
      this.closing = false;
      this.closed = false;
      this.onData = null;
      this.onEnd = null;
      this.onError = null;
      this.reading = false;
      this.writer = null;
    }
    get bufferedAmount() { return this.queue.reduce((size, item) => size + item.bytes.length, 0); }
    startReading() {
      if (this.reading || this.closed) return;
      this.reading = true;
      this.reader = addWaiter({
        step: () => this.pumpRead(),
        fail: (err) => this.fail(err),
        ref: this.referenced !== false,
      });
    }
    pumpRead() {
      if (this.closed) return true;
      let progressed = false;
      for (;;) {
        if (this.canRead && !this.canRead()) return progressed ? "progress" : false;
        const chunk = native.hostRead(this.handle);
        if (chunk === AGAIN) return progressed ? "progress" : false;
        if (typeof chunk === "number") {
          this.reading = false;
          if (chunk === 0) {
            if (this.onEnd) this.onEnd();
          } else {
            this.fail(hostError(this.handle, "connection error"));
          }
          return true;
        }
        progressed = true;
        if (this.onData) this.onData(chunk);
        if (this.closed) return true;
      }
    }
    write(bytes, callback) {
      if (this.closed || this.closing) {
        if (callback) internal.nextTick(() => callback(this._writeError || Object.assign(new Error("Connection is closed"), { code: "ERR_STREAM_DESTROYED" })));
        return;
      }
      this.queue.push({ bytes, callback });
      this.flush();
    }
    flush() {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        const chunk = item.bytes;
        const n = native.hostWrite(this.handle, chunk);
        if (n === AGAIN) {
          this.waitWritable();
          return false;
        }
        if (n < 0) {
          this.fail(hostError(this.handle, "write failed"));
          return false;
        }
        if (n < chunk.length) item.bytes = chunk.subarray(n);
        else {
          this.queue.shift();
          if (item.callback) internal.nextTick(item.callback);
        }
      }
      if (this._shutdown && !this.writeEnded) {
        this.writeEnded = true;
        const result = native.hostShutdown(this.handle);
        if (result < 0) { this.fail(hostError(this.handle, "shutdown failed")); return false; }
        if (this._shutdownCallback) internal.nextTick(this._shutdownCallback);
      }
      if (this.closing) this.destroy();
      return true;
    }
    waitWritable() {
      if (this.writer) return;
      this.writer = addWaiter({ ref: this.referenced !== false, step: () => this.pumpWrite() });
    }
    pumpWrite() {
      if (this.closed) return true;
      const done = this.flush();
      if (!done && !this.closed) return false;
      this.writer = null;
      if (!this.closed && this.onDrain) this.onDrain();
      return true;
    }
    ref(value) {
      this.referenced = value;
      if (this.reader) this.reader.ref = value;
      if (this.writer) this.writer.ref = value;
    }
    shutdown(callback) {
      this._shutdown = true;
      this._shutdownCallback = callback;
      this.flush();
    }
    // Close after queued bytes are written.
    end() {
      this.closing = true;
      if (this.queue.length === 0) this.destroy();
    }
    destroy(err) {
      if (this.closed) return;
      this.closed = true;
      this._writeError = err || Object.assign(new Error("Connection is closed"), { code: "ERR_STREAM_DESTROYED" });
      this.reading = false;
      if (this.reader) waiters.delete(this.reader);
      if (this.writer) waiters.delete(this.writer);
      this.reader = this.writer = null;
      for (const item of this.queue.splice(0)) {
        if (item.callback) internal.nextTick(() => item.callback(this._writeError));
      }
      native.hostClose(this.handle);
      if (this.onClose) this.onClose();
    }
    fail(err) {
      try { if (this.onError) this.onError(err); }
      finally { this.destroy(err); }
    }
    peer() {
      const text = native.hostPeerAddr(this.handle);
      if (typeof text !== "string") return { address: "127.0.0.1", port: 0, family: "IPv4" };
      return JSON.parse(text);
    }
  }

  function listenOrThrow(hostname, port) {
    const handle = native.hostListen(hostname, port);
    if (handle >= 0) return handle;
    const err = hostError(0, `Failed to listen at ${hostname}`);
    if (err.code === "EADDRINUSE") {
      err.message = `Failed to start server. Is port ${port} in use?`;
      err.syscall = "listen";
    }
    throw err;
  }

  // Accept connections on a listener until stopped.
  function acceptLoop(listener, onConnection) {
    return addWaiter({
      step() {
        let progressed = false;
        for (;;) {
          const handle = native.hostAccept(listener);
          if (handle === AGAIN) return progressed ? "progress" : false;
          if (handle < 0) return progressed ? "progress" : false;
          progressed = true;
          onConnection(new Connection(handle));
        }
      },
    });
  }

  // Serve HTTP/1.1 requests on a connection, one at a time (keep-alive and
  // pipelining are supported; responses go out in request order).
  const UPGRADED = Symbol("websocket upgrade");

  function serveHttp(conn, handleRequest, startRequest) {
    let pending = null;
    let buffer = new Uint8Array(0);
    let busy = false;
    let ended = false;
    function next() {
      if (busy || conn.closed) return;
      let request;
      try {
        if (startRequest && !pending && buffer.length) {
          const head = parseHead(buffer);
          if (head && header(head.headers, "expect")?.toLowerCase() === "100-continue") pending = startRequest(head, conn, wantsKeepAlive(head));
        }
        request = buffer.length ? parseRequest(buffer) : null;
      } catch {
        conn.write(encoder.encode("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
        conn.end();
        return;
      }
      if (!request) {
        if (ended) conn.end();
        return;
      }
      buffer = buffer.slice(request.length);
      busy = true;
      conn.busy = true;
      const keepAlive = wantsKeepAlive(request) && !ended;
      const active = pending;
      pending = null;
      if (active) active.receive(request.body, request.trailers);
      Promise.resolve()
        .then(() => active ? active.response : handleRequest(request, conn, keepAlive))
        .catch((err) => {
          internal.printError(err);
          conn.write(encoder.encode("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
          return false;
        })
        .then((stillOpen) => {
          if (stillOpen === UPGRADED) {
            conn.upgraded.activate(buffer);
            buffer = new Uint8Array(0);
            return;
          }
          busy = false;
          conn.busy = false;
          if (stillOpen === false || !keepAlive || conn.serverClosing) {
            conn.end();
            return;
          }
          next();
        });
    }
    conn.onData = (chunk) => {
      buffer = buffer.length ? internal.concatBytes([buffer, chunk]) : chunk;
      next();
    };
    conn.onEnd = () => {
      ended = true;
      if (!busy) next();
    };
    conn.onError = () => {};
    conn.startReading();
  }

  // --- Bun.serve --------------------------------------------------------------

  function compileRoutes(routes) {
    if (!routes) return [];
    return Object.keys(routes).map((pattern) => {
      const names = [];
      const source = pattern
        .split("/")
        .map((part) => {
          if (part === "*") return ".*";
          if (part.startsWith(":")) {
            names.push(part.slice(1));
            return "([^/]+)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");
      return { pattern, names, regex: new RegExp(`^${source}$`), handler: routes[pattern] };
    });
  }

  function matchRoute(compiled, pathname, method) {
    pathname = pathname.replace(/^\/+/, "/");
    for (const route of compiled) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      let handler = route.handler;
      if (handler && typeof handler === "object" && !(handler instanceof Response) && !internal.require("html_server").isBundle(handler)) {
        handler = handler[method] || (method === "HEAD" ? handler.GET : undefined);
        if (!handler) continue;
      }
      const params = {};
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      return { handler, params };
    }
    return null;
  }

  async function responseBytes(res) {
    return new Uint8Array(await res.arrayBuffer());
  }

  async function writeResponse(conn, res, method, keepAlive) {
    if (!(res instanceof Response)) {
      throw new TypeError(`Expected a Response object, but received '${internal.describe(res)}'`);
    }
    const body = method === "HEAD" ? new Uint8Array(0) : await responseBytes(res);
    const pairs = Array.from(res.headers).filter(([k]) => k !== "content-length" && k !== "transfer-encoding");
    if (!res.headers.has("date")) pairs.push(["date", new Date().toUTCString()]);
    const bodyless = res.status === 204 || res.status === 304;
    if (!bodyless) pairs.push(["content-length", String(method === "HEAD" ? Number(res.headers.get("content-length") || 0) : body.length)]);
    if (!keepAlive) pairs.push(["connection", "close"]);
    conn.write(serializeHead(res.status, res.statusText, pairs));
    if (!bodyless && body.length) conn.write(body);
    return keepAlive;
  }

  function errorResponse(err) {
    internal.printError(err);
    return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain;charset=utf-8" } });
  }

  function serve(options = {}) {
    if (typeof options.fetch !== "function" && !options.routes) {
      throw new TypeError("Bun.serve expects a `fetch` function or `routes`");
    }
    let websocket = options.websocket;
    let websocketHandlers = websocket;
    if (websocket && !["message", "open", "ping", "pong"].some((name) => typeof websocket[name] === "function")) throw new TypeError("websocket requires a message, open, ping or pong handler");
    if (options.tls) throw new Error("Bun.serve TLS is not supported by this networking host");
    const htmlServer = internal.require("html_server");
    const ws = internal.require("websocket");
    const hostname = options.hostname || "0.0.0.0";
    const requested = options.port !== undefined ? Number(options.port) : Number(globalThis.process.env.BUN_PORT || globalThis.process.env.PORT || 3000);
    const listener = listenOrThrow(hostname, requested);
    const port = native.hostLocalPort(listener);
    let fetchHandler = options.fetch;
    let errorHandler = options.error;
    let routes = compileRoutes(options.routes);
    websocket = htmlServer.websocket(routes, options.development, websocket);
    let pending = 0;
    let stopped = false;
    const connections = new Set();
    const displayHost = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
    const peers = new WeakMap();
    const requests = new WeakMap();
    const sockets = new Set();

    function publish(topic, data, exclude = null) {
      let sent = 0;
      for (const socket of sockets) {
        if (socket === exclude || !socket.isSubscribed(topic)) continue;
        sent += socket.send(data);
      }
      return sent;
    }

    const server = {
      port,
      hostname: displayHost,
      development: htmlServer.developmentEnabled(options.development),
      id: "",
      get url() {
        return new URL(`http://${displayHost}:${port}/`);
      },
      get pendingRequests() {
        return pending;
      },
      get pendingWebSockets() {
        return sockets.size;
      },
      requestIP(req) {
        return peers.get(req) || null;
      },
      fetch(input, init) {
        return Promise.resolve(fetchHandler.call(server, input instanceof Request ? input : new Request(input, init), server));
      },
      reload(next = {}) {
        if (next.fetch) fetchHandler = next.fetch;
        if (next.error) errorHandler = next.error;
        if (next.routes) {
          htmlServer.dispose(server);
          routes = compileRoutes(next.routes);
          htmlServer.attach(server, routes, options.development);
        }
        if (next.websocket) websocketHandlers = next.websocket;
        websocket = htmlServer.websocket(routes, options.development, websocketHandlers);
        return server;
      },
      stop(closeActive = false) {
        if (!stopped) {
          stopped = true;
          waiters.delete(accepting);
          native.hostClose(listener);
          htmlServer.dispose(server);
          // Idle keep-alive connections close now; busy ones after their
          // response (they no longer keep alive once stopped).
        }
        for (const c of Array.from(connections)) if (closeActive || (!c.busy && !c.upgraded)) c.destroy();
        return Promise.resolve();
      },
      ref() {
        accepting.ref = !stopped;
      },
      unref() {
        accepting.ref = false;
      },
      upgrade(req, upgradeOptions = {}) {
        const state = requests.get(req);
        if (!websocket || !state || state.conn.closed || state.conn.upgraded || stopped) return false;
        const key = req.headers.get("sec-websocket-key");
        const connection = req.headers.get("connection") || "";
        if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !connection.toLowerCase().split(/\s*,\s*/).includes("upgrade")) return false;
        if (req.headers.get("sec-websocket-version") !== "13" || !/^[a-zA-Z0-9+/]{22}==$/.test(key || "") || internal.require("buffer").Buffer.from(key, "base64").length !== 16) return false;
        const headers = new Headers(upgradeOptions.headers);
        headers.set("upgrade", "websocket");
        headers.set("connection", "Upgrade");
        headers.set("sec-websocket-accept", ws.acceptKey(key));
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        // Compression is never negotiated: this parser handles uncompressed frames.
        headers.delete("sec-websocket-extensions");
        const upgraded = ws.serverSocket(state.conn, () => websocket, upgradeOptions, (socket) => sockets.delete(socket), publish);
        state.conn.upgraded = upgraded;
        sockets.add(upgraded.socket);
        state.conn.write(serializeHead(101, "Switching Protocols", Array.from(headers)));
        return true;
      },
      publish(topic, data) { return publish(String(topic), data); },
      subscriberCount(topic) { return Array.from(sockets).filter((socket) => socket.isSubscribed(topic)).length; },
      [Symbol.dispose]() {
        server.stop(true);
      },
    };

    async function handleRequest(request, conn, keepAlive) {
      const host = header(request.headers, "host") || `${displayHost}:${port}`;
      const url = `http://${host}${request.target.startsWith("/") ? request.target : "/" + request.target}`;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const req = new Request(url, { method: request.method, headers: request.headers, body: hasBody ? request.body : undefined });
      let cookies;
      Object.defineProperty(req, "cookies", {
        get() { return cookies || (cookies = new (internal.require("cookie").CookieMap)(req.headers.get("cookie"))); },
        configurable: true,
      });
      const peer = conn.peer();
      peers.set(req, { address: peer.address, port: peer.port, family: peer.family });
      requests.set(req, { conn });
      pending++;
      let res;
      try {
        if (htmlServer.upgrade(req, server)) return UPGRADED;
        const route = matchRoute(routes, new URL(url).pathname, request.method);
        if (route && internal.require("html_server").isBundle(route.handler)) res = await internal.require("html_server").respond(route.handler, new URL(url).pathname, request.method, server);
        else if (route && route.handler instanceof Response) res = route.handler.clone();
        else if (route) {
          req.params = route.params;
          res = await route.handler.call(server, req, server);
        } else {
          res = await internal.require("html_server").asset(routes, new URL(url).pathname, request.method, server);
          if (!res) res = fetchHandler ? await fetchHandler.call(server, req, server) : new Response("Not Found", { status: 404 });
        }
      } catch (err) {
        res = errorHandler ? await errorHandler.call(server, err) : errorResponse(err);
      } finally {
        pending--;
        requests.delete(req);
      }
      if (conn.upgraded) return UPGRADED;
      if (res === undefined && errorHandler === undefined) res = new Response("", { status: 404 });
      if (cookies) {
        for (const value of cookies.toSetCookieHeaders()) res.headers.append("Set-Cookie", value);
      }
      return writeResponse(conn, res, request.method, keepAlive && !stopped);
    }

    const accepting = acceptLoop(listener, (conn) => {
      connections.add(conn);
      const destroy = conn.destroy.bind(conn);
      conn.destroy = () => {
        connections.delete(conn);
        destroy();
      };
      serveHttp(conn, handleRequest);
    });
    htmlServer.attach(server, routes, options.development);
    return server;
  }

  function finishServerClose(server) {
    if (!server._closing || server._connections.size || server._closeQueued) return;
    server._closeQueued = true;
    internal.nextTick(() => {
      server._closeQueued = false;
      if (!server._closing || server._connections.size) return;
      server._closing = false;
      server.emit("close");
    });
  }

  function trackServerConnection(server, conn) {
    server._connections.add(conn);
    const onClose = conn.onClose;
    conn.onClose = () => {
      if (onClose) onClose();
      server._connections.delete(conn);
      finishServerClose(server);
    };
  }

  function closeNodeServer(server, callback, http) {
    const running = server.listening || server._closing;
    if (typeof callback === "function" && running) server.once("close", callback);
    if (typeof callback === "function" && !running) internal.nextTick(() => callback(Object.assign(new Error("Server is not running."), { code: "ERR_SERVER_NOT_RUNNING" })));
    if (server.listening) {
      waiters.delete(server._accepting);
      waiters.delete(server._starting);
      native.hostClose(server._listener);
      server.listening = false;
      server._closing = true;
    }
    if (http) {
      for (const conn of server._connections) conn.serverClosing = true;
      server.closeIdleConnections();
    }
    if (running) finishServerClose(server);
    else internal.nextTick(() => server.emit("close"));
    return server;
  }

  function disposeNodeServer(server, ignoreNotRunning) {
    if (ignoreNotRunning && !server.listening && !server._closing) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && !(ignoreNotRunning && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
        else resolve();
      });
    });
  }

  // --- node:http ----------------------------------------------------------------

  function nodeHttp(protocol) {
    const EventEmitter = internal.require("events");
    const { Readable, Writable } = internal.builtin("node:stream");
    const { Buffer } = internal.require("buffer");

    class IncomingMessage extends Readable {
      constructor() {
        super();
        this.headers = {};
        this.rawHeaders = [];
        this.headersDistinct = Object.create(null);
        this.httpVersion = "1.1";
        this.httpVersionMajor = 1;
        this.httpVersionMinor = 1;
        this.method = null;
        this.url = "";
        this.statusCode = null;
        this.statusMessage = null;
        this.complete = false;
        this.socket = null;
        this.trailers = {};
        this.rawTrailers = [];
        this.trailersDistinct = Object.create(null);
      }
      destroy(error) {
        if (this._onDestroy) this._onDestroy();
        if (this.socket) this.socket.destroy();
        return super.destroy(error);
      }
      setTimeout(ms, cb) {
        if (cb) this.once("timeout", cb);
        return this;
      }
    }

    function setHeaderPairs(msg, pairs) {
      for (const [k, v] of pairs) {
        msg.rawHeaders.push(k, v);
        const key = k.toLowerCase();
        if (msg.headersDistinct) (msg.headersDistinct[key] = msg.headersDistinct[key] || []).push(v);
        if (key === "set-cookie") (msg.headers[key] = msg.headers[key] || []).push(v);
        else if (key === "cookie") msg.headers[key] = key in msg.headers ? `${msg.headers[key]}; ${v}` : v;
        else msg.headers[key] = key in msg.headers ? `${msg.headers[key]}, ${v}` : v;
      }
    }

    class ServerResponse extends EventEmitter {
      constructor(conn, req, keepAlive, done) {
        super();
        this._conn = conn;
        this._req = req;
        this._keepAlive = keepAlive;
        this.shouldKeepAlive = keepAlive;
        this._done = done;
        this._headers = new Map();
        this._trailers = [];
        this._headersFlushed = false;
        this._chunked = false;
        this._bodyless = req.method === "HEAD";
        this._completed = false;
        this.statusCode = 200;
        this.statusMessage = undefined;
        this.headersSent = false;
        this.finished = false;
        this.writableEnded = false;
        this.writableFinished = false;
        this.closed = false;
        this.destroyed = false;
        this.sendDate = true;
        this.req = req;
      }
      setHeader(name, value) {
        if (this.headersSent) {
          const error = new Error("Cannot set headers after they are sent to the client");
          error.code = "ERR_HTTP_HEADERS_SENT";
          throw error;
        }
        const key = validateHeaderName(name).toLowerCase();
        validateHeaderValue(name, value);
        this._headers.set(key, [String(name), value]);
        return this;
      }
      getHeader(name) {
        const hit = this._headers.get(String(name).toLowerCase());
        return hit ? hit[1] : undefined;
      }
      getHeaders() {
        const out = Object.create(null);
        for (const [k, [, v]] of this._headers) out[k] = v;
        return out;
      }
      getHeaderNames() {
        return Array.from(this._headers.keys());
      }
      getRawHeaderNames() {
        return Array.from(this._headers.values(), ([name]) => name);
      }
      hasHeader(name) {
        return this._headers.has(String(name).toLowerCase());
      }
      removeHeader(name) {
        if (this.headersSent) {
          const error = new Error("Cannot remove headers after they are sent to the client");
          error.code = "ERR_HTTP_HEADERS_SENT";
          throw error;
        }
        const key = String(name).toLowerCase();
        this._headers.delete(key);
        if (key === "date") this.sendDate = false;
      }
      appendHeader(name, value) {
        if (this.headersSent) {
          const error = new Error("Cannot set headers after they are sent to the client");
          error.code = "ERR_HTTP_HEADERS_SENT";
          throw error;
        }
        const key = validateHeaderName(name).toLowerCase();
        validateHeaderValue(name, value);
        const hit = this._headers.get(key);
        if (!hit) return this.setHeader(name, value);
        const previous = Array.isArray(hit[1]) ? hit[1] : [hit[1]];
        const next = Array.isArray(value) ? value : [value];
        hit[1] = previous.concat(next);
        return this;
      }
      writeHead(status, message, headers) {
        if (this.headersSent) {
          const error = new Error("Cannot set headers after they are sent to the client");
          error.code = "ERR_HTTP_HEADERS_SENT";
          throw error;
        }
        if (typeof message === "object" && message !== null) {
          headers = message;
          message = undefined;
        }
        this.statusCode = status;
        if (message !== undefined) this.statusMessage = message;
        if (Array.isArray(headers) && this._headers.size === 0) {
          this._rawHeadPairs = [];
          this._framingHeaders = new Map();
          for (let i = 0; i < headers.length; i += 2) {
            const name = validateHeaderName(headers[i]);
            validateHeaderValue(name, headers[i + 1]);
            this._rawHeadPairs.push([name, String(headers[i + 1])]);
            this._framingHeaders.set(name.toLowerCase(), [name, headers[i + 1]]);
          }
        } else if (Array.isArray(headers)) {
          const names = new Set();
          for (let i = 0; i < headers.length; i += 2) {
            const name = String(headers[i]).toLowerCase();
            if (names.has(name)) this.appendHeader(headers[i], headers[i + 1]);
            else this.setHeader(headers[i], headers[i + 1]);
            names.add(name);
          }
        } else if (headers) {
          for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
        }
        this._flushHeaders(true, 0, false);
        return this;
      }
      write(chunk, encoding, callback) {
        if (typeof encoding === "function") callback = encoding;
        if (this.writableEnded) {
          const error = new Error("write after end");
          error.code = "ERR_STREAM_WRITE_AFTER_END";
          if (typeof callback === "function") internal.nextTick(() => callback(error));
          return false;
        }
        this._flushHeaders(true);
        if (!this._bodyless && chunk !== undefined && chunk !== null) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : internal.toUint8(chunk);
          this._writeBody(bytes);
        }
        if (typeof callback === "function") internal.nextTick(callback);
        return true;
      }
      end(chunk, encoding, callback) {
        if (typeof chunk === "function") {
          callback = chunk;
          chunk = undefined;
        }
        if (typeof encoding === "function") callback = encoding;
        if (this.writableEnded) return this;
        const bytes = chunk === undefined || chunk === null ? new Uint8Array(0) : typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : internal.toUint8(chunk);
        if (!this.headersSent) {
          this._flushHeaders(false, this._bodyless ? 0 : bytes.length);
          if (bytes.length && !this._bodyless) this._writeBody(bytes);
        } else {
          this._flushHeaders(true);
          if (bytes.length && !this._bodyless) this._writeBody(bytes);
        }
        this.writableEnded = true;
        this.finished = true;
        this._finishBody(() => {
          if (this.socket) this.socket.removeListener("close", this._socketClosed);
          this.writableFinished = true;
          if (typeof callback === "function") callback();
          this.emit("finish");
          this._emitClose();
        });
        return this;
      }
      _emitClose() {
        if (this.closed) return;
        this.closed = true;
        this.destroyed = true;
        this.emit("close");
      }
      flushHeaders() {
        this._flushHeaders(true);
      }
      setTimeout() {
        return this;
      }
      addTrailers(headers) {
        this._trailers = [];
        const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
        for (const [name, value] of pairs) {
          validateHeaderName(name);
          validateHeaderValue(name, value);
          for (const item of Array.isArray(value) ? value : [value]) this._trailers.push([name, String(item)]);
        }
        return this;
      }
      writeContinue(callback) {
        this._conn.write(encoder.encode("HTTP/1.1 100 Continue\r\n\r\n"), callback);
      }
      _flushHeaders(streaming, finalLength = 0, send = true) {
        if (this._headersFlushed) return;
        if (this._headBytes) {
          if (send) { this._conn.write(this._headBytes); this._headersFlushed = true; }
          return;
        }
        const headers = this._framingHeaders || this._headers;
        this._keepAlive = this._keepAlive && Boolean(this.shouldKeepAlive);
        const connection = headers.get("connection")?.[1];
        if (String(connection || "").toLowerCase().includes("close")) this._keepAlive = false;
        const status = validateStatus(this.statusCode, this.statusMessage);
        this.statusCode = status.status;
        this.statusMessage = status.message ?? internal.builtin("node:http").STATUS_CODES[this.statusCode] ?? "unknown";
        this._bodyless = this.statusCode < 200 || this.statusCode === 204 || this.statusCode === 304 || this._req.method === "HEAD";
        let autoLength;
        let autoChunked = false;
        if (!this._bodyless && !headers.has("content-length") && !headers.has("transfer-encoding")) {
          if (!streaming && !headers.has("trailer")) autoLength = String(finalLength);
          else if (this._req.httpVersion === "1.1") autoChunked = true;
          else this._keepAlive = false;
        }
        this._chunked = headers.has("transfer-encoding") && String(headers.get("transfer-encoding")[1]).toLowerCase().includes("chunked");
        if (this._chunked && (this.statusCode === 204 || this.statusCode === 304)) this._keepAlive = false;
        const pairs = this._rawHeadPairs ? this._rawHeadPairs.slice() : outgoingHeaders(headers.values(), this._uniqueHeaders);
        if (this.sendDate && !headers.has("date")) pairs.push(["Date", new Date().toUTCString()]);
        if (!headers.has("connection")) pairs.push(["Connection", this._keepAlive ? "keep-alive" : "close"]);
        if (this._keepAlive && !headers.has("keep-alive")) pairs.push(["Keep-Alive", "timeout=5"]);
        if (autoLength !== undefined) pairs.push(["Content-Length", autoLength]);
        if (autoChunked) {
          this._chunked = true;
          pairs.push(["Transfer-Encoding", "chunked"]);
        }
        this.headersSent = true;
        this._headBytes = serializeHead(this.statusCode, this.statusMessage, pairs);
        if (send) { this._conn.write(this._headBytes); this._headersFlushed = true; }
      }
      _writeBody(bytes) {
        if (this._chunked) {
          if (!bytes.length) return;
          this._conn.write(encoder.encode(`${bytes.length.toString(16)}\r\n`));
          this._conn.write(bytes);
          this._conn.write(encoder.encode("\r\n"));
        } else if (bytes.length) {
          this._conn.write(bytes);
        }
      }
      _finishBody(callback) {
        if (this._completed) return;
        this._completed = true;
        if (this._chunked && !this._bodyless) {
          let trailers = "0\r\n";
          for (const [name, value] of this._trailers) {
            for (const item of Array.isArray(value) ? value : [value]) trailers += `${name}: ${String(item)}\r\n`;
          }
          this._conn.write(Buffer.from(`${trailers}\r\n`, "latin1"));
        }
        const connection = (this._framingHeaders || this._headers).get("connection")?.[1];
        const connectionText = Array.isArray(connection) ? connection.join(",") : String(connection || "");
        this._conn.write(new Uint8Array(0), error => {
          if (error) { this._emitClose(); return; }
          callback();
          this._done(this._keepAlive && !connectionText.toLowerCase().includes("close"));
        });
      }
    }

    class Server extends EventEmitter {
      constructor(options, handler) {
        super();
        if (typeof options === "function") handler = options;
        this._options = typeof options === "object" && options !== null ? options : {};
        if (handler) this.on("request", handler);
        this.listening = false;
        this._listener = null;
        this._port = null;
        this._connections = new Set();
      }
      listen(...args) {
        const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
        const opts = args[0] !== null && typeof args[0] === "object" ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
        if (callback) this.once("listening", callback);
        try {
          this._listener = listenOrThrow(opts.host || "0.0.0.0", Number(opts.port || 0));
        } catch (err) {
          internal.nextTick(() => this.emit("error", err));
          return this;
        }
        this._port = native.hostLocalPort(this._listener);
        this._host = opts.host || "::";
        this.listening = true;
        this._accepting = acceptLoop(this._listener, (conn) => this._onConnection(conn));
        internal.nextTick(() => this.emit("listening"));
        return this;
      }
      _onConnection(conn) {
        const { Socket } = internal.builtin("node:net");
        const socket = new Socket();
        socket._conn = conn;
        socket._phase = "open";
        socket._updatePeer();
        socket.encrypted = protocol === "https:";
        let writable = socket.writable;
        Object.defineProperty(socket, "writable", {
          configurable: true, enumerable: true,
          get() { return writable && !this._conn.closed && !this._conn.closing; },
          set(value) { writable = value; },
        });
        conn.onClose = () => socket.destroy();
        trackServerConnection(this, conn);
        this.emit("connection", socket);
        serveHttp(conn, (request, c, keepAlive) => this._request(request, c, keepAlive, socket), (head, c, keepAlive) => this._request(head, c, keepAlive, socket, true));
      }
      _request(request, conn, keepAlive, socket, deferBody = false) {
        const req = new IncomingMessage();
        req.method = request.method;
        req.url = request.target;
        req.httpVersion = request.version.slice(5);
        req.httpVersionMinor = Number(req.httpVersion.slice(2));
        req.socket = req.connection = socket;
        setHeaderPairs(req, request.headers);
        if (header(request.headers, "upgrade")) {
          if (!this.listenerCount("upgrade")) { conn.destroy(); return false; }
          conn.upgraded = { activate: head => {
            socket._attach(conn);
            this.emit("upgrade", req, socket, Buffer.from(head));
          } };
          return UPGRADED;
        }
        const response = new Promise(resolve => {
          const res = new ServerResponse(conn, req, keepAlive, resolve);
          res.socket = res.connection = socket;
          res._uniqueHeaders = this._options.uniqueHeaders;
          res._socketClosed = () => { if (!res.finished) res._emitClose(); };
          socket.once("close", res._socketClosed);
          if (header(request.headers, "expect")?.toLowerCase() === "100-continue") {
            if (this.listenerCount("checkContinue")) this.emit("checkContinue", req, res);
            else {
              conn.write(encoder.encode("HTTP/1.1 100 Continue\r\n\r\n"));
              this.emit("request", req, res);
            }
          } else {
            this.emit("request", req, res);
          }
        });
        const receive = (body, trailers = []) => {
          setHeaderPairs({ headers: req.trailers, rawHeaders: req.rawTrailers, headersDistinct: req.trailersDistinct }, trailers);
          req.complete = true;
          if (body.length) req.push(Buffer.from(body));
          req.push(null);
        };
        if (deferBody) return { response, receive };
        receive(request.body, request.trailers);
        return response;
      }
      address() {
        if (!this.listening) return null;
        return { address: this._host === "0.0.0.0" ? "0.0.0.0" : this._host, family: this._host.includes(":") ? "IPv6" : "IPv4", port: this._port };
      }
      close(callback) {
        return closeNodeServer(this, callback, true);
      }
      [Symbol.asyncDispose]() {
        return disposeNodeServer(this, false);
      }
      closeAllConnections() {
        for (const c of Array.from(this._connections)) c.destroy();
      }
      closeIdleConnections() {
        for (const c of Array.from(this._connections)) if (!c.busy) c.destroy();
      }
      setTimeout() {
        return this;
      }
      ref() {
        if (this._accepting) this._accepting.ref = true;
        return this;
      }
      unref() {
        if (this._accepting) this._accepting.ref = false;
        return this;
      }
    }

    class ClientRequest extends Writable {
      constructor(options, callback) {
        super();
        this._options = options;
        this._chunks = [];
        this._headers = {};
        this._trailers = [];
        this.headersSent = false;
        this._sent = false;
        this._requestEnded = false;
        for (const [name, value] of Object.entries(options.headers || {})) {
          this.setHeader(name, value);
        }
        this.method = validateMethod(options.method || "GET").toUpperCase();
        this.path = validatePath(options.path || "/");
        validateHeaderValue("Host", options.hostname || options.host || "localhost");
        if (callback) this.once("response", callback);
        if (this.getHeader("expect")) internal.nextTick(() => this.flushHeaders());
      }
      setHeader(name, value) {
        if (this.headersSent) throw Object.assign(new Error("Cannot set headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
        validateHeaderName(name);
        validateHeaderValue(name, value);
        const key = this._headerKey(name);
        if (key && key !== name) this._headers = Object.fromEntries(Object.entries(this._headers).map(([entry, stored]) => entry === key ? [name, value] : [entry, stored]));
        else this._headers[name] = value;
        return this;
      }
      _headerKey(name) {
        return Object.keys(this._headers).find(key => key.toLowerCase() === String(name).toLowerCase());
      }
      getHeader(name) { return this._headers[this._headerKey(name)]; }
      hasHeader(name) { return this._headerKey(name) !== undefined; }
      getHeaderNames() { return Object.keys(this._headers).map(name => name.toLowerCase()); }
      getRawHeaderNames() { return Object.keys(this._headers); }
      getHeaders() { return Object.assign(Object.create(null), Object.fromEntries(Object.entries(this._headers).map(([key, value]) => [key.toLowerCase(), value]))); }
      removeHeader(name) {
        if (this.headersSent) throw Object.assign(new Error("Cannot remove headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
        delete this._headers[this._headerKey(name)];
      }
      appendHeader(name, value) {
        const key = this._headerKey(name);
        const previous = key ? this._headers[key] : undefined;
        if (previous === undefined) return this.setHeader(name, value);
        const values = Array.isArray(previous) ? previous : [previous];
        return this.setHeader(key, values.concat(Array.isArray(value) ? value : [value]));
      }
      addTrailers(headers) {
        this._trailers = [];
        const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
        for (const [name, value] of pairs) {
          validateHeaderName(name);
          validateHeaderValue(name, value);
          for (const item of Array.isArray(value) ? value : [value]) this._trailers.push([name, String(item)]);
        }
      }
      write(chunk, encoding, cb) {
        if (typeof encoding === "function") cb = encoding;
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : internal.toUint8(chunk);
        if (this._sent && this.socket) this._writeRequestChunk(bytes);
        else this._chunks.push(bytes);
        if (!this._sent && !this._ending && (this._options.protocol || protocol) === "http:") this.flushHeaders();
        if (typeof cb === "function") internal.nextTick(cb);
        return true;
      }
      end(chunk, encoding, cb) {
        this._ending = true;
        if (typeof chunk === "function") cb = chunk;
        else if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
        if (this._requestEnded) return this;
        this._requestEnded = true;
        if (this._sent) this._endRequestBody();
        else this._send().catch((err) => this.emit("error", err));
        if (typeof cb === "function") this.once("finish", cb);
        internal.nextTick(() => this.emit("finish"));
        return this;
      }
      abort() {
        this.destroy();
      }
      destroy(err) {
        if (this._aborted) return this;
        this._aborted = true;
        if (this._httpState) this._cancelHttp();
        if (this.socket) this.socket.destroy();
        if (err) internal.nextTick(() => this.emit("error", err));
        return this;
      }
      setTimeout() {
        return this;
      }
      setNoDelay() {}
      setSocketKeepAlive() {}
      flushHeaders() { if (!this._sent) this._send().catch(err => this.emit("error", err)); }
      _cancelHttp() {
        if (this._httpState.state !== "pending" && this._httpState.state !== "response") return;
        this._httpState.state = "aborted";
        this._httpState.cleanup();
      }
      _failHttp(err) {
        const exchange = this._httpState;
        if (!exchange || (exchange.state !== "pending" && exchange.state !== "response")) return;
        exchange.state = "failed";
        exchange.cleanup();
        this.socket.destroy();
        this.emit("error", err);
      }
      _receiveHttp(chunk) {
        const exchange = this._httpState;
        if (!exchange || (exchange.state !== "pending" && exchange.state !== "response")) return;
        if (exchange.state === "response") {
          this._consumeResponse(chunk);
          return;
        }
        const count = Math.min(chunk.length, exchange.limit + 4 - exchange.buffer.length);
        const buffer = internal.concatBytes([exchange.buffer, chunk.subarray(0, count)]);
        const end = indexOfCrlfCrlf(buffer, 0);
        if (end < 0 && buffer.length <= exchange.limit) { exchange.buffer = buffer; return; }
        if (end < 0 || end + 4 > exchange.limit) {
          this._failHttp(Object.assign(new Error("Parse Error: Header overflow"), { code: "HPE_HEADER_OVERFLOW" }));
          return;
        }
        const lines = latin1(buffer.subarray(0, end)).split("\r\n");
        const status = /^HTTP\/(1\.[01]) (\d{3})(?: (.*))?$/.exec(lines.shift());
        if (!status) { this._failHttp(new Error("Invalid HTTP response")); return; }
        const msg = new IncomingMessage();
        msg.httpVersion = status[1];
        msg.httpVersionMinor = Number(status[1].slice(2));
        msg.statusCode = Number(status[2]);
        msg.statusMessage = status[3] || "";
        msg.socket = this.socket;
        msg._onDestroy = () => {
          if (exchange.state !== "response") return;
          exchange.state = "aborted";
          exchange.cleanup();
        };
        setHeaderPairs(msg, lines.map(line => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 1).trim()];
        }));
        const head = Buffer.from(internal.concatBytes([buffer.subarray(end + 4), chunk.subarray(count)]));
        if (msg.statusCode < 200 && msg.statusCode !== 101) {
          exchange.buffer = new Uint8Array(0);
          if (msg.statusCode === 100) this.emit("continue");
          this.emit("information", { statusCode: msg.statusCode, statusMessage: msg.statusMessage, headers: msg.headers, rawHeaders: msg.rawHeaders, httpVersion: msg.httpVersion });
          if (head.length) this._receiveHttp(head);
          return;
        }
        if (msg.statusCode === 101) {
          exchange.state = "complete";
          exchange.cleanup();
          if (!this.emit("upgrade", msg, this.socket, head)) this.socket.destroy();
          return;
        }
        exchange.state = "response";
        exchange.message = msg;
        exchange.decoder = new (internal.require("http_body").BodyDecoder)(this._responseMode(msg));
        this.emit("response", msg);
        this._consumeResponse(head);
      }
      _responseMode(msg) {
        if (this.method === "HEAD" || msg.statusCode === 204 || msg.statusCode === 304) return { kind: "none" };
        const transferEncoding = String(msg.headers["transfer-encoding"] || "").toLowerCase();
        if (transferEncoding.includes("chunked")) return { kind: "chunked" };
        if (msg.headers["content-length"] !== undefined) return { kind: "fixed", length: Number(msg.headers["content-length"]) };
        return { kind: "eof" };
      }
      _consumeResponse(chunk) {
        const exchange = this._httpState;
        if (!exchange || exchange.state !== "response") return;
        try { this._deliverResponse(exchange.decoder.push(chunk)); }
        catch (err) { this._failHttp(err); }
      }
      _deliverResponse(output) {
        const msg = this._httpState.message;
        for (const item of output) {
          if (item.kind === "data") msg.push(Buffer.from(item.bytes));
          else if (item.kind === "trailers") {
            const target = { headers: msg.trailers, rawHeaders: msg.rawTrailers, headersDistinct: msg.trailersDistinct };
            setHeaderPairs(target, item.pairs);
          } else this._finishResponse();
        }
      }
      _finishResponse() {
        const exchange = this._httpState;
        if (!exchange || exchange.state !== "response") return;
        exchange.state = "complete";
        exchange.message.complete = true;
        exchange.message.push(null);
        exchange.cleanup();
        this.socket.destroy();
      }
      _sendHttp() {
        if (this._aborted || this._sent) return;
        this._sent = true;
        const options = this._options;
        const limit = options.maxHeaderSize || internal.builtin("node:http").maxHeaderSize;
        if (!Number.isInteger(limit) || limit < 0) throw new RangeError("Invalid maxHeaderSize");
        const secure = protocol === "https:" || options.protocol === "https:";
        if (secure && !options.createConnection) {
          const error = new Error("TLS sockets are not supported in bun-wasm HTTP upgrades");
          error.code = "ERR_TLS_NOT_SUPPORTED";
          this.destroy(error);
          return;
        }
        const net = internal.builtin("node:net");
        const defaultPort = secure ? 443 : 80;
        const host = options.hostname || options.host || "localhost";
        const targetPort = options.port || defaultPort;
        const socket = options.createConnection ? options.createConnection(Object.assign({}, options, { host, port: targetPort })) : net.connect({ host, port: targetPort });
        this.socket = this.connection = socket;
        const receive = chunk => this._receiveHttp(chunk);
        const fail = err => this._failHttp(err);
        const eof = () => {
          if (this._httpState.state !== "response") { fail(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); return; }
          try { this._deliverResponse(this._httpState.decoder.end()); }
          catch (error) { fail(error); }
        };
        const timeout = () => this.emit("timeout");
        this._httpState = { state: "pending", buffer: new Uint8Array(0), limit, cleanup: () => {
          socket.removeListener("data", receive);
          socket.removeListener("error", fail);
          socket.removeListener("end", eof);
          socket.removeListener("close", eof);
          if (options.timeout) socket.setTimeout(0, timeout);
          this._httpState.buffer = null;
        } };
        socket.on("error", fail);
        socket.on("end", eof);
        socket.on("close", eof);
        socket.on("data", receive);
        if (options.timeout) socket.setTimeout(options.timeout, timeout);
        this.emit("socket", socket);
        if (this._httpState.state !== "pending") return;
        const headers = Object.assign({}, this._headers);
        if (!this.hasHeader("host")) headers.Host = Number(targetPort) === defaultPort ? host : `${host}:${targetPort}`;
        if (!this.hasHeader("connection")) headers.Connection = "keep-alive";
        if (!this.hasHeader("content-length") && !this.hasHeader("transfer-encoding")) {
          if (!this._requestEnded || this._trailers.length) headers["Transfer-Encoding"] = "chunked";
          else if (this._chunks.length || this.method === "POST" || this.method === "PUT") headers["Content-Length"] = String(this._chunks.reduce((length, chunk) => length + chunk.length, 0));
        }
        this._outChunked = Object.keys(headers).some(key => key.toLowerCase() === "transfer-encoding" && String(headers[key]).toLowerCase().includes("chunked"));
        const lines = [`${this.method} ${this.path} HTTP/1.1`];
        for (const [key, value] of outgoingHeaders(Object.entries(headers), options.uniqueHeaders)) lines.push(`${key}: ${value}`);
        lines.push("", "");
        this.headersSent = true;
        socket.write(Buffer.from(lines.join("\r\n"), "latin1"));
        for (const chunk of this._chunks.splice(0)) this._writeRequestChunk(chunk);
        if (this._requestEnded) this._endRequestBody();
      }
      _writeRequestChunk(bytes) {
        if (!bytes.length) return;
        if (this._outChunked) this.socket.write(`${bytes.length.toString(16)}\r\n`);
        this.socket.write(bytes);
        if (this._outChunked) this.socket.write("\r\n");
      }
      _endRequestBody() {
        if (!this._outChunked || this._sentFinalChunk) return;
        this._sentFinalChunk = true;
        let tail = "0\r\n";
        for (const [name, value] of this._trailers) tail += `${name}: ${value}\r\n`;
        this.socket.write(Buffer.from(tail + "\r\n", "latin1"));
      }
      async _send() {
        if ((this._options.protocol || protocol) === "http:" || this.hasHeader("upgrade")) return this._sendHttp();
        if (this._sent) return;
        this._sent = true;
        this.headersSent = true;
        const o = this._options;
        const url = o.href || `${o.protocol || protocol}//${o.hostname || o.host || "localhost"}${o.port ? ":" + o.port : ""}${this.path}`;
        const body = this._chunks.length ? internal.concatBytes(this._chunks) : undefined;
        const res = await fetch(url, { method: this.method, headers: this._headers, body: this.method === "GET" || this.method === "HEAD" ? undefined : body, redirect: "manual" });
        if (this._aborted) return;
        const msg = new IncomingMessage();
        msg.statusCode = res.status;
        msg.statusMessage = res.statusText || STATUS_TEXT[res.status] || "";
        setHeaderPairs(msg, Array.from(res.headers));
        this.emit("response", msg);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length) msg.push(Buffer.from(bytes));
        msg.push(null);
        msg.complete = true;
      }
    }

    function normalizeRequestArgs(input, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      let base = {};
      if (typeof input === "string" || input instanceof URL) {
        const u = new URL(String(input));
        base = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search };
      } else if (input) {
        base = input;
      }
      return [Object.assign({}, base, options), callback];
    }

    function request(input, options, callback) {
      const [opts, cb] = normalizeRequestArgs(input, options, callback);
      return new ClientRequest(opts, cb);
    }

    function get(input, options, callback) {
      const req = request(input, options, callback);
      req.end();
      return req;
    }

    const STATUS_CODES = internal.builtinFactories["node:http"] ? undefined : undefined;
    void STATUS_CODES;
    class Agent extends EventEmitter {
      constructor(options) {
        super();
        this.options = options || {};
      }
      destroy() {}
    }
    return {
      createServer: (options, handler) => new Server(options, handler),
      Server,
      IncomingMessage,
      ServerResponse,
      ClientRequest,
      request,
      get,
      Agent,
      globalAgent: new Agent(),
    };
  }

  // --- node:net -----------------------------------------------------------------

  function nodeNet() {
    return internal.require("node_net")({ Connection, addWaiter, waiters, hostError, listenOrThrow, acceptLoop, trackServerConnection, closeNodeServer, disposeNodeServer });
  }

  function bunTcp() { return internal.require("bun_tcp")({ Connection, listenOrThrow, acceptLoop, waiters }); }

  const WebSocket = internal.require("websocket").clientClass(Connection);
  return { fetch, serve, nodeHttp, nodeNet, bunTcp, caps, WebSocket };
})
