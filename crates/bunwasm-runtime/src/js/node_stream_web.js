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
    return new ReadableStream({
      start(controller) {
        const data = chunk => {
          controller.enqueue(Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : chunk);
          if (controller.desiredSize <= 0) node.pause();
        };
        const end = () => {
          ended = true;
          cleanup();
          controller.close();
        };
        const error = reason => {
          ended = true;
          cleanup();
          controller.error(reason);
        };
        const close = () => {
          if (!ended) error(new Error("Premature close"));
        };
        cleanup = () => {
          node.removeListener("data", data);
          node.removeListener("end", end);
          node.removeListener("error", error);
          node.removeListener("close", close);
        };
        node.on("data", data).on("end", end).on("error", error).on("close", close);
        if (node._endEmitted || node.readableEnded) end();
        else if (node.destroyed) error(new Error("Premature close"));
      },
      pull() { node.resume(); },
      cancel(reason) {
        ended = true;
        cleanup();
        // Node destroy reports errors asynchronously, after the web side is cancelled.
        node.once("error", () => {});
        node.destroy(reason instanceof Error ? reason : undefined);
      },
    }, options.strategy);
  }

  function fromWebReadable(Readable, web, options = {}) {
    if (!(web instanceof ReadableStream)) throw new TypeError("Expected a ReadableStream");
    const reader = web.getReader();
    let ended = false;
    let reading = false;
    let cleanup = () => {};
    const node = new Readable(Object.assign({}, options, { read() { void pump(); } }));
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
        while (!ended && node._flowing) {
          const { done, value } = await reader.read();
          if (done) { finish(); return; }
          const chunk = options.objectMode || typeof value === "string" ? value : Buffer.from(internal.toUint8(value));
          node.push(chunk);
          node._flush();
        }
      } catch (error) {
        node.destroy(error);
      } finally {
        reading = false;
      }
    }
    function finish() {
      ended = true;
      cleanup();
      reader.releaseLock();
      node.push(null);
    }
    reader.closed.catch(error => { if (!ended) node.destroy(error); });
    cleanup = aborted(options.signal, error => node.destroy(error));
    return node;
  }

  function toWebWritable(node) {
    checkNode(node, "write");
    let finished = false;
    let fail;
    let cleanup;
    return new WritableStream({
      start(controller) {
        fail = error => controller.error(error);
        const finish = () => { finished = true; };
        const close = () => {
          if (!finished) fail(new Error("Premature close"));
          cleanup();
        };
        cleanup = () => {
          node.removeListener("error", fail);
          node.removeListener("finish", finish);
          node.removeListener("close", close);
        };
        node.on("error", fail).on("finish", finish).on("close", close);
      },
      write(chunk) {
        return new Promise((resolve, reject) => node.write(chunk, error => error ? reject(error) : resolve()));
      },
      close() {
        return new Promise((resolve, reject) => {
          const error = reason => { node.removeListener("finish", finish); reject(reason); };
          const finish = () => { node.removeListener("error", error); cleanup(); resolve(); };
          node.once("error", error).once("finish", finish);
          node.end();
        });
      },
      abort(reason) {
        cleanup();
        node.once("error", () => {});
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
        writer.abort(error).catch(() => {}).finally(() => writer.releaseLock());
      }
      return destroy.call(this, error);
    };
    writer.closed.catch(error => { if (!ended) node.destroy(error); });
    cleanup = aborted(options.signal, error => node.destroy(error));
    return node;
  }

  return function install({ Readable, Writable }) {
    Readable.toWeb = toWebReadable;
    Readable.fromWeb = (web, options) => fromWebReadable(Readable, web, options);
    Writable.toWeb = toWebWritable;
    Writable.fromWeb = (web, options) => fromWebWritable(Writable, web, options);

  };
})
