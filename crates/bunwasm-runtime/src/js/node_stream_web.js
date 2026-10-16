(function (internal) {
  "use strict";
  const { ReadableStream, WritableStream } = internal.require("streams");
  const { Buffer } = internal.require("buffer");

  function checkNode(stream, method) {
    if (!stream || typeof stream.on !== "function" || typeof stream[method] !== "function") {
      throw new TypeError("Expected a Node stream");
    }
  }

  function aborted(signal, action) {
    if (!signal) return () => {};
    const abort = () => action(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  function toWebReadable(node, options = {}) {
    checkNode(node, "pause");
    node.pause();
    let ended = false;
    let cleanup;
    let stopData;
    return new ReadableStream({
      start(controller) {
        const data = chunk => {
          controller.enqueue(Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : chunk);
          if (controller.desiredSize <= 0) node.pause();
        };
        stopData = () => {
          node.removeListener("data", data);
          node.removeListener("end", end);
        };
        const end = () => {
          if (ended) return;
          ended = true;
          stopData();
          controller.close();
        };
        const error = reason => {
          if (ended) return;
          ended = true;
          stopData();
          controller.error(reason);
        };
        const close = () => {
          cleanup();
          if (ended) return;
          if (node.errored) error(node.errored);
          else if (node._endEmitted || node.readableEnded) end();
          else error(new Error("Premature close"));
        };
        cleanup = () => {
          stopData();
          node.removeListener("error", error);
          node.removeListener("close", close);
        };
        node.on("error", error).on("close", close).on("end", end).on("data", data);
        if (node.closed) close();
        else if (node.errored) error(node.errored);
        else if (node._endEmitted || node.readableEnded) end();
      },
      pull() { if (!ended && !node.destroyed) node.resume(); },
      cancel(reason) {
        ended = true;
        stopData();
        node.pause();
        node.destroy(reason instanceof Error ? reason : undefined);
        if (node.closed) cleanup();
      },
    }, options.strategy);
  }

  function fromWebReadable(Readable, web, options = {}) {
    if (!(web instanceof ReadableStream)) throw new TypeError("Expected a ReadableStream");
    const reader = web.getReader();
    let ended = false;
    let reading = false;
    let requested = false;
    let cleanup = () => {};
    const node = new Readable(Object.assign({}, options, { read() { requested = true; void pump(); } }));
    const read = node.read;
    node.read = function () {
      const chunk = read.call(this);
      if (!ended && this._buffer.length === 0) { requested = true; void pump(); }
      return chunk;
    };
    node.on("newListener", event => {
      if (event === "readable") setImmediate(() => { requested = true; void pump(); });
    });
    const destroy = node.destroy;
    node.destroy = function (error) {
      if (ended) return destroy.call(this, error);
      ended = true;
      cleanup();
      reader.cancel(error).catch(() => {}).finally(() => reader.releaseLock());
      return destroy.call(this, error);
    };
    async function pump() {
      if (reading || ended) return;
      reading = true;
      try {
        while (!ended && (node._flowing || requested)) {
          requested = false;
          if (!(await pullNext())) return;
        }
      } catch (error) {
        node.destroy(error);
      } finally {
        reading = false;
      }
    }
    async function pullNext() {
      const { done, value } = await reader.read();
      if (ended) return false;
      if (done) { finish(); return false; }
      const chunk = options.objectMode || typeof value === "string" ? value : Buffer.from(internal.toUint8(value));
      node.push(chunk);
      if (node._flowing) node._flush();
      else node.emit("readable");
      return true;
    }
    function finish() {
      ended = true;
      cleanup();
      reader.releaseLock();
      node.push(null);
      if (!node._flowing) node.emit("readable");
    }
    reader.closed.catch(error => { if (!ended) node.destroy(error); });
    cleanup = aborted(options.signal, error => node.destroy(error));
    return node;
  }

  function prematureClose() {
    const error = new Error("Premature close");
    error.code = "ERR_STREAM_PREMATURE_CLOSE";
    return error;
  }

  function toWebWritable(node) {
    checkNode(node, "write");
    if (node.destroyed || node.writable === false || node.writableEnded || node.writableFinished) {
      const error = () => {};
      const close = () => node.removeListener("error", error);
      if (!node.closed) node.on("error", error).once("close", close);
      const web = new WritableStream();
      void web.close();
      return web;
    }
    let finished = false;
    let completion;
    const pending = new Set();
    return new WritableStream({
      start(controller) {
        const fail = error => {
          for (const reject of pending) reject(error);
          pending.clear();
          if (completion) completion.reject(error);
          controller.error(error);
        };
        const finish = () => {
          finished = true;
          if (completion) completion.resolve();
          else {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            error.code = "ABORT_ERR";
            fail(error);
          }
        };
        const close = () => {
          if (!finished) fail(node.errored || prematureClose());
          node.removeListener("error", fail);
          node.removeListener("finish", finish);
          node.removeListener("close", close);
        };
        node.on("error", fail).on("finish", finish).on("close", close);
      },
      write(chunk) {
        return new Promise((resolve, reject) => {
          pending.add(reject);
          node.write(chunk, error => {
            pending.delete(reject);
            if (error) reject(error);
            else resolve();
          });
        });
      },
      close() {
        if (node.writableEnded || node.writableFinished) return;
        return new Promise((resolve, reject) => {
          completion = { resolve, reject };
          node.end();
        });
      },
      abort(reason) {
        node.destroy(reason instanceof Error ? reason : undefined);
      },
    });
  }

  function fromWebWritable(Writable, web, options = {}) {
    if (!(web instanceof WritableStream)) throw new TypeError("Expected a WritableStream");
    const writer = web.getWriter();
    let ended = false;
    let cleanup = () => {};
    function release() {
      ended = true;
      cleanup();
      writer.releaseLock();
    }
    const node = new Writable(Object.assign({}, options, {
      write(chunk, encoding, callback) {
        const data = !options.objectMode && options.decodeStrings !== false && typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
        writer.write(data).then(() => callback(), callback);
      },
      final(callback) { writer.close().then(() => { release(); callback(); }, error => { release(); callback(error); }); },
    }));
    const destroy = node.destroy;
    node.destroy = function (error) {
      if (!ended) {
        ended = true;
        cleanup();
        (error ? writer.abort(error) : writer.close()).catch(() => {}).finally(() => writer.releaseLock());
      }
      return destroy.call(this, error);
    };
    writer.closed.then(() => {
      if (!ended && !node.writableEnded) node.destroy(prematureClose());
    }, error => { if (!ended) node.destroy(error); });
    cleanup = aborted(options.signal, error => node.destroy(error));
    return node;
  }

  return function install({ Readable, Writable, Duplex }) {
    Readable.toWeb = toWebReadable;
    Readable.fromWeb = (web, options) => fromWebReadable(Readable, web, options);
    Writable.toWeb = toWebWritable;
    Writable.fromWeb = (web, options) => fromWebWritable(Writable, web, options);
    Duplex.toWeb = node => ({ readable: toWebReadable(node), writable: toWebWritable(node) });

  };
})
