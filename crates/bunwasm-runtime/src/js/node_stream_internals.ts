(function (internal: {
  require(name: "streams"): BunWasm.StreamGlobals;
  builtin(name: "node:stream"): Record<string, Record<string, (stream: object, options?: unknown) => unknown>>;
  native: { promiseState(promise: PromiseLike<unknown>): string };
}) {
  "use strict";
  type WebStreamState = { state: unknown; storedError: unknown };
  type WebStream = object & {
    _state?: unknown;
    _storedError?: unknown;
  };
  type WebStreamSymbols = { [key: symbol]: WebStreamState | undefined };
  const streams = internal.require("streams");
  const kState = Symbol("kState");
  function getWebStreamState(stream: WebStream): WebStreamState | undefined {
    if (Object.prototype.hasOwnProperty.call(stream, "_state")) return { state: stream._state, storedError: stream._storedError };
    const symbol = Object.getOwnPropertySymbols(stream).find(key => key.description === "kState");
    return symbol === undefined ? undefined : (stream as WebStreamSymbols)[symbol];
  }
  for (const Ctor of [streams.ReadableStream, streams.WritableStream]) {
    Object.defineProperty(Ctor.prototype, kState, { configurable: true, get(this: WebStream) { return getWebStreamState(this); } });
  }
  function adapter(type: string, method: string): (stream: WebStream, options?: unknown) => unknown {
    return function (stream: WebStream, options?: unknown): unknown { return internal.builtin("node:stream")[type][method](stream, options); };
  }
  const modules: {
    "internal/webstreams/adapters": Record<string, (stream: WebStream, options?: unknown) => unknown>;
    "internal/webstreams/util": { kState: symbol; isPromisePending: (promise: PromiseLike<unknown>) => boolean };
  } = {
    "internal/webstreams/adapters": {
      newReadableStreamFromStreamReadable: adapter("Readable", "toWeb"),
      newStreamReadableFromReadableStream: adapter("Readable", "fromWeb"),
      newWritableStreamFromStreamWritable: adapter("Writable", "toWeb"),
      newStreamWritableFromWritableStream: adapter("Writable", "fromWeb"),
      newReadableWritablePairFromDuplex: adapter("Duplex", "toWeb"),
      newStreamDuplexFromReadableWritablePair: adapter("Duplex", "fromWeb"),
    },
    "internal/webstreams/util": { kState, isPromisePending: promise => internal.native.promiseState(promise) === "pending" },
  };
  return { modules, getWebStreamState };
})
