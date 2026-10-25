(function (internal) {
  "use strict";
  return function ({ Connection, addWaiter, waiters, hostError, listenOrThrow, acceptLoop, trackServerConnection, closeNodeServer, disposeNodeServer }) {
    const native = internal.native;
    const { Duplex } = internal.builtin("node:stream");
    const EventEmitter = internal.require("events");
    const { Buffer } = internal.require("buffer");
    const { _normalizeArgs, port, error } = internal.require("net_address");

    class Socket extends Duplex {
      constructor(options = {}) {
        super(internal.require("node_net_socket_options")(options));
        this._conn = null;
        this._phase = "idle";
        this._referenced = true;
        this._readReady = true;
        this._pendingWrite = null;
        this._pendingFinal = null;
        this._ended = false;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this.once("finish", () => this._drainEmptyEof());
      }
      emit(event, ...args) {
        if (event === "close" && args.length === 0) return super.emit(event, Boolean(this._closeHadError));
        return super.emit(event, ...args);
      }
      get connecting() { return this._phase === "connecting"; }
      get pending() { return this._phase === "idle" || this.connecting; }
      get readyState() {
        if (this.pending) return "opening";
        if (this.destroyed) return "closed";
        if (this.readable && this.writable) return "open";
        return this.readable ? "readOnly" : this.writable ? "writeOnly" : "closed";
      }
      // Transport bytes are canceled synchronously; core write callbacks drain later.
      get writableLength() { return this.destroyed ? 0 : super.writableLength; }
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
        conn.canRead = () => this.readable && this._readReady;
        conn.onData = chunk => this._receive(chunk);
        conn.onEnd = () => this._receiveEnd();
        conn.onError = err => this.destroy(err);
        const previousClose = conn.onClose;
        conn.onClose = () => { if (previousClose) previousClose(); if (!this.destroyed) this.destroy(); };
        conn.startReading();
        this._setRef();
        this._touch();
      }
      _receiveEnd() {
        this._ended = true;
        this.push(null);
        this._drainEmptyEof();
      }
      _drainEmptyEof() {
        if (this._ended && this.readableLength === 0) this.read(0);
      }
      _updatePeer() {
        const peer = this._conn.peer();
        this.remoteAddress = peer.address;
        this.remotePort = peer.port;
        this.remoteFamily = peer.family;
      }
      connect(...args) {
        const [options, callback] = _normalizeArgs(args);
        if (options.host && typeof options.host !== "string") throw error(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.host" property must be of type string');
        if (!native.hostCaps.connect) throw error(Error, "ENOTSUP", "net.connect is not supported in bun-wasm without a networking host");
        if (this.connecting) {
          internal.nextTick(() => this.destroy(error(Error, "EALREADY", "Socket is already connecting")));
          return this;
        }
        if (this._phase === "open") { this._conn.onClose = null; this._conn.destroy(); }
        if (options.path) throw error(Error, "ENOTSUP", "Unix sockets are not supported in bun-wasm");
        if (options.port === undefined) throw error(TypeError, "ERR_MISSING_ARGS", "The port or path argument is required");
        const targetPort = port(options.port);
        if (callback) this.once("connect", callback);
        if (this.destroyed) this._undestroy();
        this._readReady = true;
        this._ended = false;
        if (options.allowHalfOpen !== undefined) this.allowHalfOpen = Boolean(options.allowHalfOpen);
        if (options.signal) this._useSignal(options.signal);
        this._phase = "connecting";
        if (options.highWaterMark !== undefined) {
          this._readableState.highWaterMark = options.highWaterMark;
          this._writableState.highWaterMark = options.highWaterMark;
        }
        if (options.lookup && typeof options.host === "string" && !internal.require("net_address").isIP(options.host)) {
          options.lookup(options.host, { family: options.family || 0, all: options.autoSelectFamily !== false },
            (err, addresses, family) => this._lookupResult(options, targetPort, err, addresses, family));
          return this;
        }
        this._dial(options, targetPort);
        return this;
      }
      _lookupResult(options, targetPort, err, addresses, family) {
        if (this.destroyed) return;
        if (err) { this.destroy(err); return; }
        const address = typeof addresses === "string" ? addresses : addresses[0]?.address;
        this.emit("lookup", null, address, family || addresses[0]?.family, options.host);
        if (!this.destroyed) this._dial(Object.assign({}, options, { host: address }), targetPort);
      }
      _dial(options, targetPort) {
        let target;
        try { target = internal.require("net_hostname")(options.host || "localhost"); }
        catch (err) { internal.nextTick(() => this.destroy(err)); return; }
        const family = internal.require("net_address").isIP(target);
        // The host ABI resolves names only after opening a connection. Deny names when a
        // BlockList is present so DNS cannot bypass the address check.
        if (options.blockList && (!family || options.blockList.check(target, family === 6 ? "ipv6" : "ipv4"))) {
          internal.nextTick(() => this.destroy(error(Error, "ERR_IP_BLOCKED", family ? "IP address is blocked" : "Hostnames with a BlockList require a lookup that returns a literal IP address")));
          return;
        }
        const handle = native.hostConnect(target, targetPort);
        if (handle < 0) {
          internal.nextTick(() => this.destroy(hostError(0, "connect failed")));
          return this;
        }
        this._conn = new Connection(handle);
        this._attempt = { address: target, port: targetPort, family: family || 4 };
        this.emit("connectionAttempt", target, targetPort, family || 4);
        if (this.destroyed) return this;
        this._connecting = addWaiter({ ref: this._referenced, step: () => this._connectStep(target, targetPort), fail: err => this.destroy(err) });
        return this;
      }
      _connectStep(target, targetPort) {
        if (this.destroyed) return true;
        const conn = this._conn;
        const ready = native.hostWrite(conn.handle, new Uint8Array(0));
        if (ready === -2) return false;
        if (ready < 0) {
          const err = hostError(conn.handle, "connect failed");
          err.syscall = err.syscall || "connect";
          if (err.code === "ENOTFOUND") err.hostname = target;
          else { err.address = target; err.port = targetPort; }
          this.destroy(err);
          return true;
        }
        this._connecting = null;
        this._attempt = null;
        this._attach(conn);
        const writing = this._pendingWrite;
        this._pendingWrite = null;
        if (writing) this._send(writing);
        if (this.destroyed) return true;
        this.emit("connect");
        if (this.destroyed) return true;
        this.emit("ready");
        const final = this._pendingFinal;
        this._pendingFinal = null;
        if (final) this._conn.shutdown(final);
        return true;
      }
      _receive(chunk) {
        this.bytesRead += chunk.length;
        this._touch();
        this._readReady = this.push(Buffer.from(chunk));
      }
      _read() {
        this._readReady = true;
        if (native.wake) native.wake(0);
      }
      _write(chunk, encoding, callback) {
        const bytes = Buffer.from(chunk);
        this.bytesWritten += bytes.length;
        const item = { bytes, callback };
        if (this._phase === "open") this._send(item);
        else this._pendingWrite = item;
      }
      _send(item) {
        this._touch();
        this._conn.write(item.bytes, item.callback);
      }
      _final(callback) {
        if (this._phase === "open") this._conn.shutdown(callback);
        else this._pendingFinal = callback;
      }
      _destroy(err, callback) {
        this._closeHadError = Boolean(err);
        const attempt = this.connecting ? this._attempt : null;
        const writeError = err || error(Error, this.pending ? "ERR_SOCKET_CLOSED_BEFORE_CONNECTION" : "ERR_STREAM_DESTROYED", this.pending ? "Socket closed before the connection was established" : "Cannot call write after a stream was destroyed");
        this._phase = "closed";
        this._attempt = null;
        if (attempt) this.emit("connectionAttemptFailed", attempt.address, attempt.port, attempt.family, err || error(Error, "ECANCELED", "Connection attempt canceled"));
        clearTimeout(this._timeoutTimer);
        if (this._connecting) waiters.delete(this._connecting);
        this._connecting = null;
        const writing = this._pendingWrite;
        const final = this._pendingFinal;
        this._pendingWrite = this._pendingFinal = null;
        if (writing) internal.nextTick(() => writing.callback(writeError));
        if (final) internal.nextTick(() => final(writeError));
        if (this._conn) this._conn.destroy(writeError);
        internal.realTimers.setImmediate(() => callback(err));
      }
      [Symbol.asyncDispose]() {
        if (this.closed) return Promise.resolve();
        return new Promise(resolve => { this.once("close", resolve); this.destroy(); });
      }
      destroySoon() { this.end(); this.once("finish", () => this.destroy()); return this; }
      resetAndDestroy() { return this.destroy(); }
      setTimeout(ms, callback) {
        if (!Number.isFinite(ms) || ms < 0) throw error(RangeError, "ERR_OUT_OF_RANGE", "Invalid timeout");
        if (callback && ms > 0) this.once("timeout", callback);
        else if (callback) this.removeListener("timeout", callback);
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

    const serverContract = internal.require("node_net_server");
    const Server = serverContract.callable(class Server extends EventEmitter {
      constructor(options = {}, listener) {
        super();
        serverContract.initialize(this, options, listener);
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
    });
    const connect = (...args) => new Socket().connect(...args);
    return { Socket, Server, Stream: Socket, createServer: (options, listener) => new Server(options, listener), connect, createConnection: connect };
  };
})
