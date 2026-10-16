// Networking for the browser engine under Node (node-host.mjs): the bun_wasm
// host ABI (docs/host-abi.md) as the JS functions the runtime's net.js calls
// (native.hostListen, hostRead, …), on real sockets (node:net) and Node's
// HTTP client. Same semantics as crates/bunwasm-host: handles are positive ints,
// nothing blocks, and results < 0 are the ABI's error codes.

const ERROR = -1;
const AGAIN = -2;
const BADF = -3;
const UNSUPPORTED = -4;

/** Bytes a connection may queue in Node before write() says AGAIN. */
const MAX_QUEUED = 1 << 20;

/**
 * @param {{net: typeof import("node:net"), http: typeof import("node:http"), https: typeof import("node:https"), zlib: typeof import("node:zlib")}} node
 */
export function createNodeNet({ net, http, https, zlib }) {
  const handles = new Map();
  let nextHandle = 1;
  let lastError = null;
  let notify = () => {};
  const news = () => notify();

  const errorInfo = (err, fallback) => {
    const cause = err && err.cause;
    const info = { name: err && err.name === "TypeError" ? "TypeError" : "Error", message: (err && err.message) || fallback };
    const code = (err && err.code) || (cause && cause.code);
    if (code) info.code = code;
    if (err?.syscall) info.syscall = err.syscall;
    return info;
  };
  const fail = (info) => {
    lastError = info;
    return ERROR;
  };
  const add = (h) => {
    const id = nextHandle++;
    handles.set(id, h);
    return id;
  };
  const stream = (kind) => ({ kind, chunks: [], ended: false, error: null });

  function attachSocket(h, socket) {
    h.socket = socket;
    socket.on("data", (buf) => {
      h.chunks.push(new Uint8Array(buf));
      news();
    });
    socket.on("end", () => {
      h.ended = true;
      news();
    });
    socket.on("error", (err) => {
      h.error = errorInfo(err, "connection error");
      news();
    });
    socket.on("close", () => {
      h.ended = true;
      news();
    });
    socket.on("drain", news);
    socket.on("connect", news);
    return h;
  }

  /** Up to `cap` buffered bytes. */
  function take(h, cap) {
    const parts = [];
    let n = 0;
    while (n < cap && h.chunks.length > 0) {
      const chunk = h.chunks[0];
      const count = Math.min(cap - n, chunk.length);
      parts.push(count === chunk.length ? chunk : chunk.subarray(0, count));
      n += count;
      if (count === chunk.length) h.chunks.shift();
      else h.chunks[0] = chunk.subarray(count);
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  const json = (value) => JSON.stringify(value);

  // HTTP client for fetch handles: node:http(s), not Node's fetch, whose
  // body streams use the global (polyfill) ReadableStream once the runtime
  // replaced it. Redirects and content-encoding are handled here, as a
  // browser's fetch would.
  function send(h, url, request, redirects, freshConnection = false) {
    const client = url.protocol === "https:" ? https : http;
    // An object (repeated names become arrays): with an array, Node sends no Host header.
    const headers = { "accept-encoding": "gzip, deflate, br" };
    for (const [name, value] of request.headers) {
      const key = name.toLowerCase();
      if (key === "accept-encoding" || !Object.hasOwn(headers, key)) headers[key] = value;
      else headers[key] = [].concat(headers[key], value);
    }
    const req = client.request(url, { method: request.method, headers, agent: freshConnection ? false : undefined });
    h.request = req;
    req.on("error", (err) => {
      if (!freshConnection && !h.closed && !h.head && req.reusedSocket && err.code === "ECONNRESET" && ["GET", "HEAD"].includes(request.method)) {
        send(h, url, request, redirects, true);
        return;
      }
      h.error = errorInfo({ name: "TypeError", message: err.message, code: err.code }, "fetch failed");
      news();
    });
    req.on("response", (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(status) && request.redirect !== "manual") {
        res.resume();
        if (request.redirect === "error") {
          h.error = { name: "TypeError", message: "fetch failed: unexpected redirect" };
          news();
          return;
        }
        if (redirects >= 20) {
          h.error = { name: "TypeError", message: "fetch failed: too many redirects" };
          news();
          return;
        }
        const next = new URL(location, url);
        const keepBody = status === 307 || status === 308;
        const nextRequest = keepBody ? request : { method: request.method === "HEAD" ? "HEAD" : "GET", headers: request.headers.filter(([k]) => !/^content-/i.test(k)), body: null, redirect: request.redirect };
        send(h, next, nextRequest, redirects + 1);
        return;
      }
      const pairs = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
      h.head = json({ status, statusText: res.statusMessage || "", url: url.href, redirected: redirects > 0, headers: pairs });
      const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
      const decoder =
        encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? zlib.createInflate() : encoding === "br" ? zlib.createBrotliDecompress() : null;
      const body = decoder ? res.pipe(decoder) : res;
      body.on("data", (chunk) => {
        h.chunks.push(new Uint8Array(chunk));
        news();
      });
      body.on("end", () => {
        h.ended = true;
        news();
      });
      body.on("error", (err) => {
        h.error = errorInfo(err, "network error while reading the body");
        news();
      });
      news();
    });
    if (request.body) req.end(request.body);
    else req.end();
  }

  const natives = {
    hostPoll: () => UNSUPPORTED,

    hostFetch(metaText, body) {
      let meta;
      try {
        meta = JSON.parse(metaText);
      } catch {
        return fail({ name: "TypeError", message: "fetch: malformed request metadata" });
      }
      let url;
      try {
        url = new URL(meta.url);
      } catch {
        return fail({ name: "TypeError", message: `Failed to parse URL from ${meta.url}` });
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return fail({ name: "TypeError", message: `fetch: unsupported protocol ${url.protocol}` });
      }
      const method = (meta.method || "GET").toUpperCase();
      const h = stream("fetch");
      h.head = null;
      h.request = null;
      const id = add(h);
      const payload = body && body.length > 0 && method !== "GET" && method !== "HEAD" ? new Uint8Array(body) : null;
      const request = { method, headers: meta.headers || [], body: payload, redirect: meta.redirect || "follow" };
      send(h, url, request, 0);
      return id;
    },

    hostFetchHead(handle) {
      const h = handles.get(handle);
      if (!h || h.kind !== "fetch") return BADF;
      if (h.head) return h.head;
      return h.error ? ERROR : AGAIN;
    },

    hostRead(handle, cap = 65536) {
      const h = handles.get(handle);
      if (!h || h.kind === "listener") return BADF;
      if (h.kind === "fetch" && !h.head) return h.error ? ERROR : AGAIN;
      if (h.chunks.length > 0) return take(h, Math.max(1, cap));
      if (h.error) return ERROR;
      return h.ended ? 0 : AGAIN;
    },

    hostWrite(handle, bytes) {
      const h = handles.get(handle);
      if (!h) return BADF;
      if (h.kind !== "conn") return UNSUPPORTED;
      if (h.error) return ERROR;
      if (h.socket.connecting) return AGAIN;
      if (h.socket.writableLength > MAX_QUEUED) return AGAIN;
      if (bytes.length === 0) return 0;
      h.socket.write(new Uint8Array(bytes));
      return bytes.length;
    },

    hostShutdown(handle) {
      const h = handles.get(handle);
      if (h?.kind !== "conn") return BADF;
      h.socket.end();
      return 0;
    },

    hostLocalAddr(handle) {
      const h = handles.get(handle);
      if (!h || h.kind === "fetch") return BADF;
      if (h.error) return ERROR;
      const address = h.kind === "conn" ? h.socket.address() : h.server.address();
      return address && typeof address === "object" ? json(address) : AGAIN;
    },

    hostClose(handle) {
      const h = handles.get(handle);
      if (!h) return BADF;
      handles.delete(handle);
      h.closed = true;
      if (h.kind === "listener") {
        for (const id of h.pending) {
          const conn = handles.get(id);
          handles.delete(id);
          if (conn) conn.socket.destroy();
        }
        h.server.close();
      } else if (h.kind === "conn") {
        h.socket.end();
      } else {
        if (h.request) h.request.destroy();
      }
      return 0;
    },

    hostListen(hostname, port) {
      const host = hostname === "localhost" || !hostname ? "127.0.0.1" : hostname;
      const server = net.createServer({ allowHalfOpen: true });
      const h = { kind: "listener", server, pending: [], error: null };
      server.on("listening", news);
      server.on("connection", (socket) => {
        h.pending.push(add(attachSocket(stream("conn"), socket)));
        news();
      });
      server.on("error", (err) => {
        h.error = errorInfo(err, "listen failed");
        news();
      });
      // The guest needs the port (and EADDRINUSE) at once, but Node binds to
      // a named host only after an async lookup. A probe without a host
      // binds synchronously: it picks the port for port 0 and finds ports
      // already taken; libuv frees it again on close().
      const probe = net.createServer();
      probe.on("error", () => {});
      probe.listen(port);
      const bound = probe.address();
      probe.close();
      if (!bound) return fail({ name: "Error", message: `Failed to listen at ${hostname}:${port}`, code: "EADDRINUSE" });
      h.port = bound.port;
      server.listen({ host, port: h.port });
      return add(h);
    },

    hostLocalPort(handle) {
      const h = handles.get(handle);
      if (!h || h.kind === "fetch") return BADF;
      if (h.kind === "listener") return h.port;
      return h.socket.localPort || 0;
    },

    hostAccept(listener) {
      const h = handles.get(listener);
      if (!h || h.kind !== "listener") return BADF;
      return h.pending.length > 0 ? h.pending.shift() : AGAIN;
    },

    hostConnect(hostname, port) {
      const host = hostname === "localhost" ? "127.0.0.1" : hostname;
      return add(attachSocket(stream("conn"), net.connect({ host, port, allowHalfOpen: true })));
    },

    hostError(handle) {
      if (handle === 0) return json(lastError || { name: "Error", message: "no error" });
      const h = handles.get(handle);
      if (!h) return BADF;
      return json(h.error || { name: "Error", message: "no error" });
    },

    hostPeerAddr(handle) {
      const h = handles.get(handle);
      if (!h || h.kind !== "conn") return BADF;
      const s = h.socket;
      if (h.error) return ERROR;
      if (s.connecting || !s.remotePort) return AGAIN;
      return json({ address: s.remoteAddress || "127.0.0.1", port: s.remotePort || 0, family: s.remoteFamily || "IPv4" });
    },
  };

  const caps = { poll: false, fetch: true, fetch_head: true, read: true, write: true, close: true, listen: true, local_port: true, accept: true, connect: true, error: true, peer_addr: true, shutdown: true, local_addr: true };
  return {
    natives,
    caps,
    onNews(cb) {
      notify = cb;
    },
  };
}
