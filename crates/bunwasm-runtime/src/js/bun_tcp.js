(function (internal) {
  "use strict";
  return function (transport) {
    const { Connection, listenOrThrow, acceptLoop, waiters } = transport;
    const { Socket } = internal.builtin("node:net");
    const { port, error } = internal.require("net_address");
    const native = internal.native;
    const sockets = new Set();

    function payload(data, byteOffset = 0, byteLength) {
      const bytes = typeof data === "string" ? Buffer.from(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      return bytes.subarray(byteOffset, byteLength === undefined ? bytes.length : byteOffset + byteLength);
    }

    function wrap(socket, options, listener) {
      let handlers = options.socket;
      let ended = false;
      const result = {
        data: options.data,
        listener,
        get remoteAddress() { return socket.remoteAddress; },
        get localPort() { return socket.localPort; },
        get localAddress() { return socket.localAddress; },
        get remotePort() { return socket.remotePort; },
        get readyState() { return socket.destroyed ? -1 : socket.connecting ? 0 : ended ? -2 : 1; },
        get bytesWritten() { return socket.bytesWritten; },
        write(data, byteOffset = 0, byteLength) {
          if (socket.destroyed || ended) return -1;
          if (socket.writableNeedDrain) return 0;
          const part = payload(data, byteOffset, byteLength);
          socket.write(part);
          return part.length;
        },
        end(data, byteOffset, byteLength) {
          if (socket.destroyed || ended) return -1;
          const part = data === undefined ? undefined : payload(data, byteOffset, byteLength);
          ended = true;
          socket.end(part);
          return part ? part.length : 0;
        },
        shutdown(half = false) { if (half) { ended = true; socket.end(); } else socket.destroy(); },
        terminate() { socket.destroy(); },
        flush() { return 0; },
        timeout(seconds) { socket.setTimeout(seconds * 1000); },
        ref() { socket.ref(); return this; },
        unref() { socket.unref(); return this; },
        reload(options) { handlers = options.socket; },
      };
      sockets.add(result);
      socket.on("data", bytes => {
        let data = bytes;
        if (handlers.binaryType === "arraybuffer") data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        else if (handlers.binaryType === "uint8array") data = new Uint8Array(bytes);
        if (handlers.data) handlers.data(result, data);
      });
      socket.on("end", () => { if (handlers.end) handlers.end(result); });
      socket.on("drain", () => { if (handlers.drain) handlers.drain(result); });
      socket.on("timeout", () => { if (handlers.timeout) handlers.timeout(result); });
      socket.on("error", err => { if (handlers.error) handlers.error(result, err); });
      socket.once("close", hadError => {
        sockets.delete(result);
        if (listener) listener._sockets.delete(result);
        if (handlers.close) handlers.close(result, hadError ? 1 : 0);
      });
      result._open = () => { if (handlers.open) handlers.open(result); };
      return result;
    }
    function validate(options) {
      if (!options || typeof options.socket !== "object" || options.socket === null) throw error(TypeError, "ERR_INVALID_ARG_TYPE", "socket handlers are required");
      if (options.tls && options.tls !== true && typeof options.tls !== "object") throw new TypeError("TLSOptions must be an object");
      if (options.unix || options.tls) throw error(Error, "ENOTSUP", "Unix sockets and TLS sockets are not supported in bun-wasm");
      port(options.port);
    }
    function listen(options) {
      validate(options);
      const hostname = options.hostname || "0.0.0.0";
      const handle = listenOrThrow(hostname, port(options.port));
      const owned = new Set();
      const listener = {
        hostname, port: native.hostLocalPort(handle), data: options.data,
        _sockets: owned,
        stop(force = false) {
          waiters.delete(accepting);
          native.hostClose(handle);
          if (force) for (const socket of owned) socket.terminate();
        },
        ref() { accepting.ref = true; return this; },
        unref() { accepting.ref = false; return this; },
        reload(next) { options = Object.assign({}, options, next); },
        [Symbol.dispose]() { this.stop(true); },
      };
      const accepting = acceptLoop(handle, conn => {
        const socket = new Socket();
        socket._attach(conn);
        const wrapped = wrap(socket, options, listener);
        owned.add(wrapped);
        wrapped._open();
      });
      return listener;
    }
    function connect(options) {
      validate(options);
      return new Promise((resolve, reject) => {
        const socket = new Socket();
        const result = wrap(socket, options);
        socket.once("error", err => {
          if (!socket.connecting && socket._connected) return;
          if (options.socket.connectError) options.socket.connectError(result, err);
          reject(err);
        });
        socket.connect({ host: options.hostname || "localhost", port: options.port }, () => {
          socket._connected = true;
          result._open();
          resolve(result);
        });
      });
    }
    return { listen, connect };
  };
})
