(function (internal) {
  "use strict";
  return function ({ Connection, addWaiter, waiters, hostError, listenOrThrow, acceptLoop, trackServerConnection, closeNodeServer, disposeNodeServer }) {
    const native = internal.native;
    const { Duplex } = internal.builtin("node:stream");
    const EventEmitter = internal.require("events");
    const { Buffer } = internal.require("buffer");
    const { StringDecoder } = internal.require("string_decoder");
    const { _normalizeArgs, port, error } = internal.require("net_address");

    class Socket extends Duplex {
      constructor(options = {}) {
        super(options);
        this.removeAllListeners("newListener");
        this._conn = null;
        this._phase = "idle";
        this._referenced = true;
        this._writes = [];
        this._decoder = null;
        this._paused = false;
        this._highWaterMark = options.highWaterMark ?? 65536;
        this.allowHalfOpen = Boolean(options.allowHalfOpen);
        this.readable = options.readable !== false;
        this.writable = options.writable !== false;
        this.readableEnded = false;
        this.writableEnded = false;
        this.writableFinished = false;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this.writableLength = 0;
        this.writableNeedDrain = false;
        this.destroyed = false;
        const socket = this;
        this._readableState = { get endEmitted() { return socket.readableEnded; } };
        this._writableState = { get length() { return socket.writableLength; }, get finished() { return socket.writableFinished; }, get needDrain() { return socket.writableNeedDrain; }, errorEmitted: false };
        this.on("newListener", event => {
          if (event === "data" && !this._paused) internal.nextTick(() => { if (!this._paused) this.resume(); });
        });
        if (options.encoding) this.setEncoding(options.encoding);
        if (options.signal) this._useSignal(options.signal);
      }
      get connecting() { return this._phase === "connecting"; }
      get pending() { return this._phase === "idle" || this.connecting; }
      get readyState() {
        if (this.pending) return "opening";
        if (this.destroyed) return "closed";
        if (this.readable && this.writable) return "open";
        return this.readable ? "readOnly" : this.writable ? "writeOnly" : "closed";
      }
      get readableLength() { return this._buffer.reduce((n, chunk) => n + chunk.length, 0); }
      get readableHighWaterMark() { return this._highWaterMark; }
      get writableHighWaterMark() { return this._highWaterMark; }
      get bufferSize() { return this.writableLength; }
      get localPort() { return this.address()?.port; }
      get localAddress() { return this.address()?.address; }
      get localFamily() { return this.address()?.family; }
      _useSignal(signal) {
        const abort = () => this.destroy(Object.assign(error(Error, "ABORT_ERR", "The operation was aborted"), { name: "AbortError", cause: signal.reason }));
        if (signal.aborted) internal.nextTick(abort);
        else { signal.addEventListener("abort", abort, { once: true }); this.once("close", () => signal.removeEventListener("abort", abort)); }
      }
      _attach(conn) {
        this._conn = conn;
        this._phase = "open";
        this._updatePeer();
        conn.canRead = () => this.readable && (this._flowing || this.readableLength < this._highWaterMark);
        conn.onData = chunk => this._receive(chunk);
        conn.onEnd = () => {
          if (this._decoder) {
            const tail = this._decoder.end();
            if (tail) this._buffer.push(tail);
          }
          this._ended = true;
          this._flush();
        };
        conn.onError = err => this.destroy(err);
        const previousClose = conn.onClose;
        conn.onClose = () => { if (previousClose) previousClose(); if (!this.destroyed) this.destroy(); };
        conn.startReading();
        this._setRef();
        this._touch();
      }
      _updatePeer() {
        const peer = this._conn.peer();
        this.remoteAddress = peer.address;
        this.remotePort = peer.port;
        this.remoteFamily = peer.family;
      }
      connect(...args) {
        const [options, callback] = _normalizeArgs(args);
        if (!native.hostCaps.connect) throw error(Error, "ENOTSUP", "net.connect is not supported in bun-wasm without a networking host");
        if (this.connecting) {
          internal.nextTick(() => this.destroy(error(Error, "EALREADY", "Socket is already connecting")));
          return this;
        }
        if (this._phase === "open") { this._conn.onClose = null; this._conn.destroy(); this._buffer = []; }
        if (options.path) throw error(Error, "ENOTSUP", "Unix sockets are not supported in bun-wasm");
        if (options.port === undefined) throw error(TypeError, "ERR_MISSING_ARGS", "The port or path argument is required");
        const targetPort = port(options.port);
        if (callback) this.once("connect", callback);
        if (this.destroyed) {
          this.destroyed = this.readableEnded = this.writableEnded = this.writableFinished = this._ended = this._endEmitted = false;
          this.readable = this.writable = true;
          this._buffer = [];
        }
        if (options.allowHalfOpen !== undefined) this.allowHalfOpen = Boolean(options.allowHalfOpen);
        if (options.signal) this._useSignal(options.signal);
        this._phase = "connecting";
        if (options.highWaterMark !== undefined) this._highWaterMark = options.highWaterMark;
        if (options.lookup && typeof options.host === "string" && !internal.require("net_address").isIP(options.host)) {
          options.lookup(options.host, { family: options.family || 0, all: options.autoSelectFamily !== false }, (err, addresses, family) => {
            if (this.destroyed) return;
            if (err) { this.destroy(err); return; }
            const address = typeof addresses === "string" ? addresses : addresses[0]?.address;
            this.emit("lookup", null, address, family || addresses[0]?.family, options.host);
            this._dial(Object.assign({}, options, { host: address }), targetPort);
          });
          return this;
        }
        this._dial(options, targetPort);
        return this;
      }
      _dial(options, targetPort) {
        const target = options.host || "localhost";
        const family = internal.require("net_address").isIP(target);
        if (options.blockList?.check(target === "localhost" ? "127.0.0.1" : target, family === 6 ? "ipv6" : "ipv4")) {
          internal.nextTick(() => this.destroy(error(Error, "ERR_IP_BLOCKED", "IP address is blocked")));
          return;
        }
        const handle = native.hostConnect(target, targetPort);
        if (handle < 0) {
          internal.nextTick(() => this.destroy(hostError(0, "connect failed")));
          return this;
        }
        const conn = new Connection(handle);
        this._attempt = { address: target, port: targetPort, family: family || 4 };
        this.emit("connectionAttempt", target, targetPort, family || 4);
        this._conn = conn;
        this._connecting = addWaiter({ ref: this._referenced, step: () => {
          if (this.destroyed) return true;
          const ready = native.hostWrite(handle, new Uint8Array(0));
          if (ready === -2) return false;
          if (ready < 0) {
            const err = hostError(handle, "connect failed");
            err.syscall = err.syscall || "connect";
            if (err.code === "ENOTFOUND") err.hostname = target;
            else { err.address = target; err.port = targetPort; }
            this.destroy(err);
            return true;
          }
          this._connecting = null;
          this._attempt = null;
          this._attach(conn);
          for (const item of this._writes.splice(0)) this._send(item);
          this.emit("connect");
          if (this.destroyed) return true;
          this.emit("ready");
          if (this.writableEnded) this._finishWrite();
          return true;
        }, fail: err => this.destroy(err) });
        return this;
      }
      _receive(chunk) {
        this.bytesRead += chunk.length;
        this._touch();
        const value = this._decoder ? this._decoder.write(Buffer.from(chunk)) : Buffer.from(chunk);
        if (value.length) this._buffer.push(value);
        this.emit("readable");
        this._flush();
      }
      _flush() {
        while (this._flowing && this._buffer.length && !this.destroyed) this.emit("data", this._buffer.shift());
        if (this._ended && !this._buffer.length && !this.readableEnded && !this.destroyed) this._finishRead();
      }
      _finishRead() {
        this.readableEnded = true;
        this.readable = false;
        this.emit("end");
        if (!this.allowHalfOpen && !this.writableEnded) this.end();
        if (this.writableFinished) this.destroy();
      }
      read(size) {
        if (size === 0) return null;
        if (!this._buffer.length) { this._flush(); return null; }
        const chunk = this._buffer.shift();
        let result = chunk;
        if (size > 0 && size < chunk.length) { result = chunk.slice(0, size); this._buffer.unshift(chunk.slice(size)); }
        internal.nextTick(() => this._flush());
        if (native.wake) native.wake(0);
        return result;
      }
      pause() { this._paused = true; this._flowing = false; return this; }
      resume() { this._paused = false; this._flowing = true; this._flush(); if (native.wake) native.wake(0); return this; }
      isPaused() { return this._paused; }
      cork() { return this; }
      uncork() { return this; }
      unshift(chunk) { this._buffer.unshift(chunk); return true; }
      setEncoding(encoding) {
        this._decoder = new StringDecoder(encoding);
        this._buffer = this._buffer.map(chunk => typeof chunk === "string" ? chunk : this._decoder.write(chunk)).filter(chunk => chunk.length);
        return this;
      }
      write(data, encoding, callback) {
        if (typeof encoding === "function") callback = encoding;
        if (this.destroyed || this.writableEnded) {
          const err = error(Error, "ERR_STREAM_WRITE_AFTER_END", "write after end");
          internal.nextTick(() => { if (callback) callback(err); this.destroy(err); });
          return false;
        }
        if (typeof data !== "string" && !(data instanceof Uint8Array)) throw error(TypeError, "ERR_INVALID_ARG_TYPE", "chunk must be a string or Uint8Array");
        const bytes = typeof data === "string" ? Buffer.from(data, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(data);
        const item = { bytes, callback };
        this.bytesWritten += bytes.length;
        this.writableLength += bytes.length;
        const accepted = this.writableLength < this._highWaterMark;
        if (!accepted) this.writableNeedDrain = true;
        if (this._phase === "open") this._send(item);
        else this._writes.push(item);
        return accepted;
      }
      _send(item) {
        this._touch();
        this._conn.write(item.bytes, () => {
          this.writableLength -= item.bytes.length;
          if (item.callback) item.callback();
          if (this.writableLength === 0 && this.writableNeedDrain && !this.destroyed) { this.writableNeedDrain = false; this.emit("drain"); }
        });
      }
      end(data, encoding, callback) {
        if (typeof data === "function") { callback = data; data = undefined; }
        if (typeof encoding === "function") callback = encoding;
        if (callback) this.once("finish", callback);
        if (this.writableEnded) return this;
        if (data !== undefined && data !== null) this.write(data, encoding);
        this.writableEnded = true;
        if (this._phase === "open") this._finishWrite();
        return this;
      }
      _finishWrite() {
        this._conn.shutdown(() => {
          if (this.destroyed || this.writableFinished) return;
          this.writableFinished = true;
          this.writable = false;
          this.emit("finish");
          if (this.readableEnded) this.destroy();
        });
      }
      destroy(err) {
        if (this.destroyed) return this;
        const attempt = this.connecting ? this._attempt : null;
        this.destroyed = true;
        this._phase = "closed";
        this._attempt = null;
        if (attempt) this.emit("connectionAttemptFailed", attempt.address, attempt.port, attempt.family, err || error(Error, "ECANCELED", "Connection attempt canceled"));
        this.readable = this.writable = false;
        clearTimeout(this._timeoutTimer);
        if (this._connecting) waiters.delete(this._connecting);
        this._writes = [];
        internal.nextTick(() => { if (err) this.emit("error", err); this.emit("close", Boolean(err)); });
        if (this._conn) this._conn.destroy();
        return this;
      }
      [Symbol.asyncDispose]() {
        if (this.destroyed) return Promise.resolve();
        return new Promise(resolve => { this.once("close", resolve); this.destroy(); });
      }
      destroySoon() { this.end(); this.once("finish", () => this.destroy()); return this; }
      resetAndDestroy() { return this.destroy(); }
      setTimeout(ms, callback) {
        if (!Number.isFinite(ms) || ms < 0) throw error(RangeError, "ERR_OUT_OF_RANGE", "Invalid timeout");
        if (callback) this.once("timeout", callback);
        this.timeout = ms;
        this._touch();
        return this;
      }
      _touch() {
        clearTimeout(this._timeoutTimer);
        if (!this.timeout || this.destroyed) return;
        this._timeoutTimer = setTimeout(() => this.emit("timeout"), this.timeout);
        if (!this._referenced) this._timeoutTimer.unref();
      }
      setNoDelay() { return this; }
      setKeepAlive() { return this; }
      _setRef() {
        if (this._connecting) this._connecting.ref = this._referenced;
        if (this._conn) this._conn.ref(this._referenced);
        if (this._timeoutTimer) this._referenced ? this._timeoutTimer.ref() : this._timeoutTimer.unref();
      }
      ref() { this._referenced = true; this._setRef(); return this; }
      unref() { this._referenced = false; this._setRef(); return this; }
      address() {
        if (!this._conn || this.destroyed) return {};
        const text = native.hostLocalAddr(this._conn.handle);
        return typeof text === "string" ? JSON.parse(text) : {};
      }
    }

    class Server extends EventEmitter {
      constructor(options = {}, listener) {
        super();
        if (typeof options === "function") { listener = options; options = {}; }
        this._options = options || {};
        this.allowHalfOpen = Boolean(this._options.allowHalfOpen);
        this.pauseOnConnect = Boolean(this._options.pauseOnConnect);
        this._referenced = true;
        this.listening = false;
        this._connections = new Set();
        if (listener) this.on("connection", listener);
      }
      listen(...args) {
        if (this.listening) throw error(Error, "ERR_SERVER_ALREADY_LISTEN", "Listen method has been called more than once without closing");
        const [options, callback] = _normalizeArgs(args);
        if (args[0] && typeof args[0] === "object" && !("port" in options) && !("path" in options)) throw error(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'options' must have the property "port" or "path". Received ${JSON.stringify(options)}`);
        if (options.path) throw error(Error, "ENOTSUP", "Unix sockets are not supported in bun-wasm");
        const targetPort = port(options.port);
        if (callback) this.once("listening", callback);
        try { this._listener = listenOrThrow(options.host || "0.0.0.0", targetPort); }
        catch (err) { internal.nextTick(() => this.emit("error", err)); return this; }
        this.listening = true;
        this._closing = false;
        this._starting = addWaiter({ ref: this._referenced, step: () => {
          if (!this.listening) return true;
          const address = native.hostLocalAddr(this._listener);
          if (address === -2) return false;
          this._starting = null;
          if (typeof address === "string") this.emit("listening");
          else {
            const err = hostError(this._listener, "listen failed");
            waiters.delete(this._accepting);
            native.hostClose(this._listener);
            this.listening = false;
            this.emit("error", err);
          }
          return true;
        } });
        this._accepting = acceptLoop(this._listener, conn => this._accept(conn));
        this._accepting.ref = this._referenced;
        if (options.signal) {
          const abort = () => this.close();
          if (options.signal.aborted) internal.nextTick(abort);
          else { options.signal.addEventListener("abort", abort, { once: true }); this.once("close", () => options.signal.removeEventListener("abort", abort)); }
        }
        return this;
      }
      _accept(conn) {
        const peer = conn.peer();
        if (this._options.blockList?.check(peer.address, peer.family.toLowerCase()) || (this.maxConnections !== undefined && this._connections.size >= this.maxConnections)) { conn.destroy(); this.emit("drop", peer); return; }
        const socket = new Socket(this._options);
        socket._attach(conn);
        socket.server = socket._server = this;
        trackServerConnection(this, conn);
        if (this.pauseOnConnect) socket.pause();
        this.emit("connection", socket);
      }
      address() {
        if (!this.listening) return null;
        const text = native.hostLocalAddr(this._listener);
        return typeof text === "string" ? JSON.parse(text) : null;
      }
      getConnections(callback) { internal.nextTick(() => callback(null, this._connections.size)); }
      close(callback) { return closeNodeServer(this, callback, false); }
      [Symbol.asyncDispose]() { return disposeNodeServer(this, true); }
      ref() { this._referenced = true; if (this._accepting) this._accepting.ref = true; if (this._starting) this._starting.ref = true; return this; }
      unref() { this._referenced = false; if (this._accepting) this._accepting.ref = false; if (this._starting) this._starting.ref = false; return this; }
    }
    const connect = (...args) => new Socket().connect(...args);
    return { Socket, Server, Stream: Socket, createServer: (options, listener) => new Server(options, listener), connect, createConnection: connect };
  };
})
