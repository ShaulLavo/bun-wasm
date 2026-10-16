(function (internal) {
  "use strict";
  const streams = internal.require("streams");
  const { Buffer } = internal.require("buffer");
  const pipelineBuffers = Symbol.for("bun-wasm.pipeline.buffers");
  const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");
  const errorKey = Symbol.for("nodejs.webstream.controllerErrorFunction");

  function unsupportedState() {
    const error = new Error("This host does not expose an unlocked Web Stream's closed promise");
    error.code = "ERR_NOT_SUPPORTED_IN_WASM";
    return error;
  }

  function installWebState(Ctor, readable) {
    if (internal.native.engine === "host") {
      if (!(closedKey in Ctor.prototype) || !(errorKey in Ctor.prototype)) throw new Error("The host native-stream bridge is missing");
      return;
    }
    if (!(closedKey in Ctor.prototype)) throw new Error("The portable Web Stream completion hooks are missing");
    if (!(errorKey in Ctor.prototype)) Object.defineProperty(Ctor.prototype, errorKey, { get() {
      const controller = this._readableStreamController || this._writableStreamController;
      if (!controller) throw unsupportedState();
      return reason => controller.error(reason);
    } });
    const stateName = readable ? "readable" : "writable";
    const symbols = {
      "nodejs.stream.destroyed": stream => stream._state !== stateName,
      "nodejs.stream.errored": stream => stream._state === "errored" || stream._state === "erroring",
      ["nodejs.stream." + stateName]: stream => stream._state === stateName && (readable || !stream._closeRequest && !stream._inFlightCloseRequest),
    };
    if (readable) symbols["nodejs.stream.disturbed"] = stream => stream._disturbed;
    for (const [name, get] of Object.entries(symbols)) {
      const key = Symbol.for(name);
      if (!(key in Ctor.prototype)) Object.defineProperty(Ctor.prototype, key, { get() { return get(this); } });
    }
  }

  function brand(Ctor) {
    const getter = Object.getOwnPropertyDescriptor(Ctor.prototype, "locked").get;
    return value => { try { Reflect.apply(getter, value, []); return true; } catch { return false; } };
  }

  function observeTerminalWritable(node) {
    const state = node._writableState;
    if (!state || state.closeEmitted || state.emitClose === false) return;
    const pending = node.destroyed || node.writableEnded && !node.writableFinished || node.writableFinished && state.autoDestroy;
    if (!pending) return;
    const error = () => {};
    const cleanup = () => {
      node.removeListener("error", error);
      node.removeListener("close", cleanup);
      node.removeListener("finish", finish);
    };
    const finish = () => { if (!state.autoDestroy && !node.destroyed) cleanup(); };
    node.on("error", error).once("close", cleanup).once("finish", finish);
  }

  function withDestroyHook(node, options, callback) {
    const hook = options.destroy;
    if (typeof hook !== "function") return callback;
    return error => {
      try { Reflect.apply(hook, node, [error, callback]); }
      catch (failure) { callback(failure); }
    };
  }

  return {
    create(bundle) {
      installWebState(streams.ReadableStream, true);
      installWebState(streams.WritableStream, false);
      const typed = Object.getPrototypeOf(Uint8Array.prototype);
      const get = key => value => Reflect.apply(Object.getOwnPropertyDescriptor(typed, key).get, value, []);
      const types = internal.builtin("node:util/types");
      return Object.assign({}, streams, bundle, bundle.Stream, bundle.errors, bundle.errors.codes, bundle.validators, bundle.utils, {
        Buffer,
        TextEncoder,
        eos: bundle.eos,
        kEosNodeSynchronousCallback: bundle.eos.kEosNodeSynchronousCallback,
        kEmptyObject: Object.freeze({ __proto__: null }),
        normalizeEncoding: bundle.util.normalizeEncoding,
        isAnyArrayBuffer: types.isAnyArrayBuffer,
        isReadableStream: brand(streams.ReadableStream),
        isWritableStream: brand(streams.WritableStream),
        zlib: internal.builtin("node:zlib").constants,
        SafeSet: Set,
        ArrayPrototypeFilter: (array, callback) => array.filter(callback),
        ObjectKeys: Object.keys,
        PromisePrototypeThen: (promise, resolve, reject) => promise.then(resolve, reject),
        PromiseResolve: Promise.resolve.bind(Promise),
        PromiseWithResolvers() {
          let resolve;
          let reject;
          const promise = new Promise((a, b) => { resolve = a; reject = b; });
          return { promise, resolve, reject };
        },
        SafePromiseAllReturnVoid: (items, callback) => Promise.all(Array.from(items, callback)).then(() => {}),
        SafePromisePrototypeFinally: (promise, callback) => promise.finally(callback),
        StringPrototypeStartsWith: (text, prefix) => text.startsWith(prefix),
        TypedArrayPrototypeGetBuffer: get("buffer"),
        TypedArrayPrototypeGetByteOffset: get("byteOffset"),
        TypedArrayPrototypeGetByteLength: get("byteLength"),
        setOwnProperty: (object, key, value) => Object.defineProperty(object, key, { value, configurable: true, enumerable: true, writable: true }),
        getDeprecationWarningEmitter(code, message) {
          let warned = false;
          return () => { if (!warned) { warned = true; process.emitWarning(message, "DeprecationWarning", code); } };
        },
        withDestroyHook,
        observeTerminalWritable,
        kPipelineBuffers: pipelineBuffers,
      });
    },
  };
})
