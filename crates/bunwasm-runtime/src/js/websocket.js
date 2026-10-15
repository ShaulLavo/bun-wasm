// RFC 6455 over the host's existing TCP byte streams. Both ends use the same
// parser; only clients mask outgoing frames and only servers require masks.
(function (internal) {
  "use strict";
  const { Buffer } = internal.require("buffer");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const MAX_PAYLOAD = 16 * 1024 * 1024;
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

  function acceptKey(key) {
    return internal.builtin("node:crypto").createHash("sha1").update(key + GUID).digest("base64");
  }

  function payload(data) {
    if (typeof data === "string") return encoder.encode(data);
    return internal.toUint8(data);
  }

  function validCode(code) {
    return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
  }

  function closePayload(code, reason = "") {
    if (!validCode(code)) throw new RangeError("Invalid WebSocket close code");
    const text = encoder.encode(String(reason));
    if (text.length > 123) throw new RangeError("WebSocket close reason exceeds 123 bytes");
    const out = new Uint8Array(2 + text.length);
    out[0] = code >> 8;
    out[1] = code & 255;
    out.set(text, 2);
    return out;
  }

  function frame(opcode, bytes, masked) {
    const size = bytes.length;
    const extra = size < 126 ? 0 : size < 65536 ? 2 : 8;
    const offset = 2 + extra + (masked ? 4 : 0);
    const out = new Uint8Array(offset + size);
    out[0] = 0x80 | opcode;
    out[1] = (masked ? 0x80 : 0) | (extra === 0 ? size : extra === 2 ? 126 : 127);
    if (extra === 2) new DataView(out.buffer).setUint16(2, size);
    if (extra === 8) new DataView(out.buffer).setUint32(6, size);
    out.set(bytes, offset);
    if (!masked) return out;
    const mask = crypto.getRandomValues(new Uint8Array(4));
    out.set(mask, offset - 4);
    for (let i = 0; i < size; i++) out[offset + i] ^= mask[i % 4];
    return out;
  }

  function readFrame(buffer, masked, maxPayload) {
    if (buffer.length < 2) return null;
    const first = buffer[0];
    const opcode = first & 15;
    const fin = Boolean(first & 128);
    const hasMask = Boolean(buffer[1] & 128);
    let size = buffer[1] & 127;
    let offset = 2;
    if ((first & 112) || hasMask !== masked || ![0, 1, 2, 8, 9, 10].includes(opcode)) throw new Error("Invalid WebSocket frame");
    if (opcode >= 8 && (!fin || size > 125)) throw new Error("Invalid WebSocket control frame");
    if (size === 126) {
      if (buffer.length < 4) return null;
      size = buffer[2] * 256 + buffer[3];
      if (size < 126) throw new Error("Nonminimal WebSocket frame length");
      offset = 4;
    } else if (size === 127) {
      if (buffer.length < 10) return null;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (view.getUint32(2) !== 0) throw Object.assign(new Error("WebSocket message too large"), { code: 1009 });
      size = view.getUint32(6);
      if (size < 65536) throw new Error("Nonminimal WebSocket frame length");
      offset = 10;
    }
    if (size > maxPayload) throw Object.assign(new Error("WebSocket message too large"), { code: 1009 });
    const start = offset + (hasMask ? 4 : 0);
    if (buffer.length < start + size) return null;
    const bytes = buffer.slice(start, start + size);
    if (hasMask) for (let i = 0; i < size; i++) bytes[i] ^= buffer[offset + i % 4];
    return { fin, opcode, bytes, length: start + size };
  }

  class Peer {
    constructor(conn, client, hooks, maxPayload = MAX_PAYLOAD) {
      this.conn = conn;
      this.client = client;
      this.hooks = hooks;
      this.maxPayload = maxPayload;
      this.state = 1;
      this.buffer = new Uint8Array(0);
      this.fragments = [];
      this.fragmentSize = 0;
      this.fragmentOpcode = 0;
      this.closeTimer = null;
      this.closeInfo = null;
      this.finished = false;
    }
    attach(initial = new Uint8Array(0)) {
      this.conn.onData = (bytes) => this.feed(bytes);
      this.conn.onEnd = () => this.conn.destroy();
      this.conn.onError = (err) => this.hooks.error?.(err);
      this.conn.onClose = () => this.finish();
      this.feed(initial);
    }
    feed(bytes) {
      this.buffer = this.buffer.length ? internal.concatBytes([this.buffer, bytes]) : bytes;
      try {
        this.drainFrames();
      } catch (err) {
        this.closeInfo = { code: err.code || 1002, reason: "", clean: false };
        this.sendFrame(8, closePayload(this.closeInfo.code));
        this.conn.end();
      }
    }
    drainFrames() {
      while (!this.conn.closed) {
        const parsed = readFrame(this.buffer, !this.client, this.maxPayload);
        if (!parsed) return;
        this.buffer = this.buffer.subarray(parsed.length);
        this.receive(parsed);
      }
    }
    receive({ fin, opcode, bytes }) {
      if (opcode === 8) return this.receiveClose(bytes);
      if (opcode === 9) {
        this.sendFrame(10, bytes);
        this.hooks.ping?.(Buffer.from(bytes));
        return;
      }
      if (opcode === 10) return this.hooks.pong?.(Buffer.from(bytes));
      if (this.state !== 1) return;
      if (opcode === 0 && !this.fragmentOpcode) throw new Error("Unexpected WebSocket continuation");
      if (opcode !== 0 && this.fragmentOpcode) throw new Error("Expected WebSocket continuation");
      if (opcode !== 0) this.fragmentOpcode = opcode;
      this.fragmentSize += bytes.length;
      if (this.fragmentSize > this.maxPayload) throw Object.assign(new Error("WebSocket message too large"), { code: 1009 });
      this.fragments.push(bytes);
      if (!fin) return;
      const message = internal.concatBytes(this.fragments);
      const type = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentSize = 0;
      this.fragmentOpcode = 0;
      let value = Buffer.from(message);
      if (type === 1) {
        try { value = decoder.decode(message); }
        catch { throw Object.assign(new Error("Invalid WebSocket UTF-8"), { code: 1007 }); }
      }
      this.hooks.message?.(value);
    }
    receiveClose(bytes) {
      if (bytes.length === 1) throw new Error("Invalid WebSocket close frame");
      const code = bytes.length ? bytes[0] * 256 + bytes[1] : 1005;
      if (bytes.length && !validCode(code)) throw new Error("Invalid WebSocket close code");
      let reason;
      try { reason = decoder.decode(bytes.subarray(2)); }
      catch { throw Object.assign(new Error("Invalid WebSocket close reason"), { code: 1007 }); }
      this.closeInfo = { code, reason, clean: true };
      if (this.state === 1) this.sendFrame(8, bytes);
      this.state = 2;
      this.conn.end();
    }
    sendFrame(opcode, bytes) {
      if (this.conn.closed) return 0;
      this.conn.write(frame(opcode, bytes, this.client));
      return this.bufferedAmount > 0 ? -1 : bytes.length;
    }
    send(data, opcode = typeof data === "string" ? 1 : 2) {
      if (this.state !== 1) return 0;
      return this.sendFrame(opcode, payload(data));
    }
    close(code = 1000, reason = "") {
      const bytes = closePayload(code, reason);
      if (this.state !== 1) return;
      this.state = 2;
      this.closeTimer = setTimeout(() => this.conn.destroy(), 10000);
      this.sendFrame(8, bytes);
    }
    terminate() {
      this.conn.destroy();
    }
    finish() {
      if (this.finished) return;
      this.finished = true;
      this.state = 3;
      clearTimeout(this.closeTimer);
      this.buffer = new Uint8Array(0);
      this.fragments = [];
      const info = this.closeInfo || { code: 1006, reason: "", clean: false };
      this.hooks.close?.(info);
    }
    get bufferedAmount() {
      return this.conn.queue.reduce((n, bytes) => n + bytes.length, 0);
    }
  }

  function serverSocket(conn, handlers, options, remove, publish) {
    const topics = new Set();
    const invoke = (name, ...args) => {
      try {
        const result = handlers()[name]?.(socket, ...args);
        if (result && typeof result.then === "function") result.catch((err) => invokeError(err));
      } catch (err) { invokeError(err); }
    };
    const invokeError = (err) => {
      if (handlers().error) handlers().error(socket, err);
      else internal.printError(err);
    };
    const peer = new Peer(conn, false, {
      message: (data) => invoke("message", data),
      ping: (data) => invoke("ping", data),
      pong: (data) => invoke("pong", data),
      error: invokeError,
      close: ({ code, reason }) => { topics.clear(); remove(socket); invoke("close", code, reason); },
    }, handlers().maxPayloadLength ?? MAX_PAYLOAD);
    conn.onDrain = () => invoke("drain");
    const control = (opcode, data = "") => {
      const bytes = payload(data);
      if (bytes.length > 125) throw new RangeError("WebSocket control payload exceeds 125 bytes");
      return peer.sendFrame(opcode, bytes);
    };
    const socket = {
      data: options.data,
      binaryType: "nodebuffer",
      remoteAddress: conn.peer().address,
      get readyState() { return peer.state; },
      get subscriptions() { return Array.from(topics); },
      get bufferedAmount() { return peer.bufferedAmount; },
      send(data) { return peer.send(data); },
      sendText(data) { return peer.send(String(data), 1); },
      sendBinary(data) { return peer.send(data, 2); },
      ping(data) { return control(9, data); },
      pong(data) { return control(10, data); },
      close(code, reason) { peer.close(code, reason); },
      terminate() { peer.terminate(); },
      subscribe(topic) { topics.add(String(topic)); return true; },
      unsubscribe(topic) { return topics.delete(String(topic)); },
      isSubscribed(topic) { return topics.has(String(topic)); },
      publish(topic, data) { return publish(String(topic), data, handlers().publishToSelf ? null : socket); },
      publishText(topic, data) { return socket.publish(topic, String(data)); },
      publishBinary(topic, data) { return socket.publish(topic, payload(data)); },
      cork(callback) { callback(); },
      getBufferedAmount() { return peer.bufferedAmount; },
    };
    const message = peer.hooks.message;
    peer.hooks.message = (data) => {
      if (typeof data === "string" || socket.binaryType === "nodebuffer") return message(data);
      const bytes = new Uint8Array(data);
      message(socket.binaryType === "arraybuffer" ? bytes.buffer : bytes);
    };
    conn.onClose = () => peer.finish();
    return {
      socket,
      activate(bytes) { peer.attach(); invoke("open"); if (!conn.closed) peer.feed(bytes); },
    };
  }

  function clientClass(Connection) {
    function event(target, type, props = {}) {
      const Ctor = type === "message" || type === "ping" || type === "pong" ? MessageEvent : type === "error" ? ErrorEvent : type === "close" ? CloseEvent : Event;
      const ev = new Ctor(type, props);
      target.dispatchEvent(ev);
    }
    return class WebSocket extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
      onopen = null; onmessage = null; onerror = null; onclose = null;
      binaryType = "blob";
      extensions = "";
      protocol = "";
      constructor(input, protocols = []) {
        super();
        const url = new URL(String(input));
        if (url.protocol === "http:") url.protocol = "ws:";
        if (url.protocol !== "ws:" || url.hash || url.username || url.password) throw new SyntaxError("WebSocket requires a ws:// URL without credentials or a fragment");
        let options = {};
        if (protocols && typeof protocols === "object" && !Array.isArray(protocols)) {
          options = protocols;
          protocols = options.protocols || [];
        }
        if (options.proxy || options.tls) throw new Error("WebSocket proxy and TLS options are not supported by this networking host");
        protocols = typeof protocols === "string" ? [protocols] : Array.from(protocols);
        if (new Set(protocols).size !== protocols.length || protocols.some((p) => typeof p !== "string" || !/^[!#$%&'*+\-.^_`|~\da-zA-Z]+$/.test(p))) throw new SyntaxError("Invalid WebSocket subprotocol");
        this.url = url.href;
        this._state = 0;
        this._peer = null;
        this._protocols = protocols;
        this._discardedBytes = 0;
        this._sendQueue = [];
        this._sending = false;
        this._pendingBytes = 0;
        const headers = new Headers(options.headers);
        const handle = internal.native.hostConnect(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port || 80));
        if (handle < 0) {
          setTimeout(() => this._fail(new Error("WebSocket connection failed")), 0);
          return;
        }
        this._conn = new Connection(handle);
        this._key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
        this._head = new Uint8Array(0);
        this._conn.onData = (bytes) => this._handshake(bytes);
        this._conn.onEnd = () => this._conn.destroy();
        this._conn.onClose = () => this._fail(new Error("WebSocket handshake failed"));
        this._conn.onError = (err) => this._fail(err);
        headers.set("host", url.host);
        headers.set("connection", "Upgrade");
        headers.set("upgrade", "websocket");
        headers.set("sec-websocket-key", this._key);
        headers.set("sec-websocket-version", "13");
        headers.delete("sec-websocket-extensions");
        if (protocols.length) headers.set("sec-websocket-protocol", protocols.join(", "));
        const lines = [`GET ${url.pathname || "/"}${url.search} HTTP/1.1`].concat(Array.from(headers, ([name, value]) => `${name}: ${value}`));
        this._conn.write(encoder.encode(lines.concat(["", ""]).join("\r\n")));
        this._conn.startReading();
      }
      _fail(err, code = 1006) {
        if (this._state === 3) return;
        this._state = 3;
        this._conn?.destroy();
        event(this, "error", { error: err, message: err.message });
        event(this, "close", { code, reason: "", wasClean: false });
      }
      _handshake(bytes) {
        this._head = internal.concatBytes([this._head, bytes]);
        const text = Buffer.from(this._head).toString("latin1");
        const end = text.indexOf("\r\n\r\n");
        if (end < 0 && this._head.length < 16384) return;
        const lines = text.slice(0, end).split("\r\n");
        const headers = new Headers();
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
        }
        const protocol = headers.get("sec-websocket-protocol");
        const validProtocol = protocol === null ? this._protocols.length === 0 : this._protocols.includes(protocol);
        if (end < 0 || end > 16384 || !/^HTTP\/1\.1 101(?: |$)/.test(lines[0]) || headers.get("upgrade")?.toLowerCase() !== "websocket" || !headers.get("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade") || headers.get("sec-websocket-accept") !== acceptKey(this._key) || headers.has("sec-websocket-extensions") || !validProtocol) return this._fail(new Error("Invalid WebSocket handshake"), 1002);
        this.protocol = protocol || "";
        const initial = this._head.slice(end + 4);
        this._head = null;
        this._peer = new Peer(this._conn, true, {
          message: (data) => event(this, "message", { data: this._binary(data), origin: new URL(this.url).origin }),
          error: (err) => event(this, "error", { error: err, message: err.message }),
          ping: (data) => event(this, "ping", { data: this._binary(data) }),
          pong: (data) => event(this, "pong", { data: this._binary(data) }),
          close: ({ code, reason, clean }) => {
            this._state = 2;
            setTimeout(() => { this._state = 3; event(this, "close", { code, reason, wasClean: clean }); }, 0);
          },
        });
        this._state = 1;
        this._peer.attach();
        event(this, "open");
        this._peer.feed(initial);
      }
      _binary(data) {
        if (typeof data === "string" || this.binaryType === "nodebuffer") return data;
        const bytes = new Uint8Array(data);
        if (this.binaryType === "arraybuffer") return bytes.buffer;
        if (this.binaryType === "uint8array") return bytes;
        return new Blob([bytes]);
      }
      get readyState() { return this._state; }
      get bufferedAmount() { return (this._peer?.bufferedAmount || 0) + this._discardedBytes + this._pendingBytes; }
      send(data) { this._enqueue(data, typeof data === "string" ? 1 : 2); }
      ping(data = "") { this._enqueue(data, 9); }
      pong(data = "") { this._enqueue(data, 10); }
      _enqueue(data, opcode) {
        if (this.readyState === 0) throw new DOMException("WebSocket is connecting", "InvalidStateError");
        const bytes = data instanceof Blob ? data : payload(data);
        const size = bytes instanceof Blob ? bytes.size : bytes.length;
        if (opcode >= 8 && size > 125) throw new RangeError("WebSocket control payload exceeds 125 bytes");
        if (this.readyState >= 2) { this._discardedBytes += size; return; }
        if (!this._sending && !(bytes instanceof Blob)) { this._peer.sendFrame(opcode, bytes); return; }
        this._pendingBytes += size;
        this._sendQueue.push({ bytes: bytes instanceof Blob ? bytes : bytes.slice(), size, opcode });
        if (!this._sending) void this._flushSends();
      }
      async _flushSends() {
        this._sending = true;
        try {
          while (this._sendQueue.length) {
            const item = this._sendQueue.shift();
            const bytes = item.bytes instanceof Blob ? new Uint8Array(await item.bytes.arrayBuffer()) : item.bytes;
            this._pendingBytes -= item.size;
            if (this.readyState === 1) this._peer.sendFrame(item.opcode, bytes);
          }
        } catch (err) { this._fail(err); }
        finally { this._sending = false; }
      }
      _abort() {
        if (this._state >= 2) return;
        this._state = 2;
        if (this._peer) { setTimeout(() => this._peer.terminate(), 0); return; }
        if (this._conn) { this._conn.onClose = null; this._conn.destroy(); }
        setTimeout(() => this._fail(new Error("WebSocket closed before connecting")), 0);
      }
      close(code = 1000, reason = "") {
        if (!validCode(code)) throw new DOMException(`Invalid WebSocket close code. Received ${code}`, "InvalidAccessError");
        const size = encoder.encode(String(reason)).length;
        if (size > 123) throw new SyntaxError(`WebSocket close reason exceeds 123 UTF-8 bytes. Received ${size} bytes`);
        if (!this._peer) { this._abort(); return; }
        if (this._state >= 2) return;
        this._state = 2;
        this._peer.close(code, reason);
      }
      terminate() { this._abort(); }
    };
  }

  return { acceptKey, serverSocket, clientClass };
})
