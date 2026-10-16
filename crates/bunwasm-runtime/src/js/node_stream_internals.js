(function (internal) {
  "use strict";
  const streams = internal.require("streams");
  const kState = Symbol("kState");
  function getWebStreamState(stream) {
    if (Object.prototype.hasOwnProperty.call(stream, "_state")) return { state: stream._state, storedError: stream._storedError };
    const symbol = Object.getOwnPropertySymbols(stream).find(key => key.description === "kState");
    return symbol === undefined ? undefined : stream[symbol];
  }
  for (const Ctor of [streams.ReadableStream, streams.WritableStream]) {
    Object.defineProperty(Ctor.prototype, kState, { configurable: true, get() { return getWebStreamState(this); } });
  }
  function adapter(type, method) {
    return function (stream, options) { return internal.builtin("node:stream")[type][method](stream, options); };
  }
  const modules = {
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
