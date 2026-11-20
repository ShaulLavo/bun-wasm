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
    if (typeof err?.hostname === "string") info.hostname = err.hostname;
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

  // Bun's fetch error for a code it reports by name, as crates/bunwasm-host does.
  const fetchFailure = (code, url) => ({
    name: "TypeError",
    code,
    message: `${code} fetching "${url}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
  });
  // llhttp's parse errors under Bun's codes. A bad status line keeps Node's error: Bun
  // reports that as a closed connection, not a malformed response.
  const parseFailureCode = (code) => {
    if (code === "HPE_INVALID_CONTENT_LENGTH" || code === "HPE_UNEXPECTED_CONTENT_LENGTH") return "InvalidContentLength";
    if (code === "HPE_INVALID_HEADER_TOKEN" || code === "HPE_INVALID_TRANSFER_ENCODING" || code === "HPE_LF_EXPECTED" || code === "HPE_CR_EXPECTED") return "Malformed_HTTP_Response";
    return null;
  };
  const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
  /** Where a redirect goes, or the Bun error that stops it. */
  function redirectTarget(location, url, requested) {
    let next;
    try {
      next = new URL(location, url);
    } catch {
      return { error: { name: "TypeError", code: "RedirectURLInvalid", message: "RedirectURLInvalid: Redirect URL in Location header is invalid." } };
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") return { error: fetchFailure("UnsupportedRedirectProtocol", requested) };
    return { next };
  }

  // HTTP client for fetch handles: node:http(s), not Node's fetch, whose
  // body streams use the global (polyfill) ReadableStream once the runtime
  // replaced it. Redirects and content-encoding are handled here, as a
  // browser's fetch would.
  function send(h, url, request, redirects, freshConnection = false) {
    const client = url.protocol === "https:" ? https : http;
    // An object (repeated names become arrays): with an array, Node sends no Host header.
    const headers = { "accept-encoding": "gzip, deflate, br, zstd" };
    for (const [name, value] of request.headers) {
      const key = name.toLowerCase();
      if (key === "accept-encoding" || !Object.hasOwn(headers, key)) headers[key] = value;
      else headers[key] = [].concat(headers[key], value);
    }
    // Node's 16 KiB head limit would refuse a Location Bun follows (Bun allows 128 KiB URLs).
    const req = client.request(url, { method: request.method, headers, agent: freshConnection ? false : undefined, maxHeaderSize: 512 * 1024 });
    h.request = req;
    req.on("error", (err) => {
      // The request was dropped for a reason already recorded (a body length mismatch).
      if (h.error) return;
      if (!freshConnection && !h.closed && !h.head && req.reusedSocket && err.code === "ECONNRESET" && ["GET", "HEAD"].includes(request.method)) {
        send(h, url, request, redirects, true);
        return;
      }
      const parsed = parseFailureCode(err.code);
      // A name that does not resolve keeps the resolver's syscall and the host that failed, as in Bun.
      const lookup = err.code === "ENOTFOUND" ? { syscall: err.syscall, hostname: err.hostname } : {};
      h.error = parsed ? fetchFailure(parsed, h.url) : errorInfo({ name: "TypeError", message: err.message, code: err.code, ...lookup }, "fetch failed");
      news();
    });
    req.on("response", (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      // Bun rejects every redirect status under "error", with or without a Location.
      if (REDIRECT_STATUSES.includes(status) && request.redirect === "error") {
        res.resume();
        h.error = fetchFailure("UnexpectedRedirect", h.url);
        news();
        return;
      }
      if (location && REDIRECT_STATUSES.includes(status) && request.redirect === "follow") {
        res.resume();
        // A stream has no source to send again: only a 303, which drops the body, is
        // followed (Fetch's HTTP-redirect fetch, step 11, as in Bun).
        if (request.streaming) {
          h.uploadClosed = true;
          if (status !== 303) {
            h.error = { name: "TypeError", message: "Request body is a ReadableStream and cannot be replayed for this redirect" };
            news();
            return;
          }
        }
        if (redirects >= 20) {
          h.error = { name: "TypeError", message: "fetch failed: too many redirects" };
          news();
          return;
        }
        const target = redirectTarget(location, url, h.url);
        if (target.error) {
          h.error = target.error;
          news();
          return;
        }
        const next = target.next;
        // A 303 (except to HEAD), and a 301 or 302 to a POST, turn into a GET without the body;
        // every other redirect resends the request as it was (crates/bunwasm-host does the same).
        const keepBody = status === 303 ? request.method === "HEAD" : !(status <= 302 && request.method === "POST");
        const nextRequest = keepBody ? request : { method: request.method === "HEAD" ? "HEAD" : "GET", headers: request.headers.filter(([k]) => !/^content-/i.test(k)), body: null, redirect: request.redirect };
        if (next.origin !== url.origin) nextRequest.headers = nextRequest.headers.filter(([name]) => !/^(authorization|proxy-authorization|cookie2?|www-authenticate)$/i.test(name));
        send(h, next, nextRequest, redirects + 1);
        return;
      }
      const pairs = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
      const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
      h.head = json({ status, statusText: res.statusMessage || "", url: url.href, redirected: redirects > 0, headers: pairs, bodyEncoding: encoding === "zstd" ? "zstd" : null });
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
    if (request.streaming) {
      // hostWrite and hostShutdown carry the body; Node chunks it unless a Content-Length is set.
      req.on("drain", news);
      req.on("finish", () => {
        h.uploadClosed = true;
        news();
      });
      return;
    }
    if (request.body) req.end(request.body);
    else req.end();
  }

  function startFetch(metaText, body, streaming) {
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
      return fail({ name: "TypeError", message: "Failed to parse fetch URL" });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail({ name: "TypeError", message: `fetch: unsupported protocol ${url.protocol}` });
    }
    const method = (meta.method || "GET").toUpperCase();
    const h = stream("fetch");
    h.head = null;
    h.request = null;
    h.url = url.href;
    h.streaming = streaming;
    h.uploadClosed = !streaming;
    const id = add(h);
    // As in Bun, every other method sends its body, even an empty one, with a Content-Length.
    const payload = method !== "GET" && method !== "HEAD" ? new Uint8Array(body ?? 0) : null;
    const headers = meta.headers || [];
    // Node writes no header for an empty body.
    if (!streaming && payload?.length === 0 && !headers.some(([name]) => name.toLowerCase() === "content-length")) headers.push(["content-length", "0"]);
    const request = { method, headers, body: payload, redirect: meta.redirect || "follow", streaming };
    // A streamed body must match the caller's Content-Length exactly.
    const declared = headers.find(([name]) => name.toLowerCase() === "content-length")?.[1];
    h.declared = streaming && declared !== undefined && /^\s*\d+\s*$/.test(declared) ? Number(declared) : null;
    h.sent = 0;
    send(h, url, request, 0);
    return id;
  }

  // Bun's error when a streamed body does not match its Content-Length; the request is dropped.
  function lengthMismatch(h) {
    h.error = {
      name: "Error",
      code: "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      message: `Request body of ${h.sent} bytes does not match the Content-Length of ${h.declared}`,
    };
    h.uploadClosed = true;
    h.request?.destroy();
    news();
    return ERROR;
  }

  /** Request body bytes for a fetch_stream handle, as crates/bunwasm-host does. */
  function writeUpload(h, bytes) {
    if (!h.streaming) return BADF;
    if (h.uploadClosed || h.error || !h.request || h.request.destroyed) return ERROR;
    if (bytes.length === 0) return 0;
    if (h.request.writableLength >= MAX_QUEUED) return AGAIN;
    h.sent += bytes.length;
    // A chunk past the declared length is not sent.
    if (h.declared !== null && h.sent > h.declared) return lengthMismatch(h);
    h.request.write(new Uint8Array(bytes));
    return bytes.length;
  }

  const natives = {
    hostPoll: () => UNSUPPORTED,

    hostFetch: (metaText, body) => startFetch(metaText, body, false),

    hostFetchStream: (metaText) => startFetch(metaText, null, true),

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
      if (h.kind === "fetch") return writeUpload(h, bytes);
      if (h.kind !== "conn") return UNSUPPORTED;
      if (h.error) return ERROR;
      if (h.socket.connecting) return AGAIN;
      if (bytes.length === 0) return 0;
      const available = MAX_QUEUED - h.socket.writableLength;
      if (available <= 0) return AGAIN;
      const count = Math.min(bytes.length, available);
      h.socket.write(new Uint8Array(bytes.subarray(0, count)));
      return count;
    },

    hostShutdown(handle) {
      const h = handles.get(handle);
      if (h?.kind === "fetch" && h.streaming) {
        if (h.uploadClosed || !h.request || h.request.writableEnded) return 0;
        if (h.declared !== null && h.sent < h.declared) lengthMismatch(h);
        else h.request.end();
        return 0;
      }
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

  const caps = { poll: false, fetch: true, fetch_stream: true, fetch_head: true, read: true, write: true, close: true, listen: true, local_port: true, accept: true, connect: true, error: true, peer_addr: true, shutdown: true, local_addr: true };
  return {
    natives,
    caps,
    onNews(cb) {
      notify = cb;
    },
  };
}
