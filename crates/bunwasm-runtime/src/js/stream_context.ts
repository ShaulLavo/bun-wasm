// The web stream classes programs see (the globals and node:stream/web), with Bun's
// StreamAsyncContextScope (src/jsc/bindings/webcore/streams/WebStreamsMisc.cpp): a
// ReadableStream keeps the async context it was constructed in, and its source's start, pull
// and cancel run in it, with the source itself as `this`, whoever reads or cancels the stream.
// A stream constructed with no async context passes its source through untouched, so programs
// that use no store pay nothing. The runtime's own streams use the classes from `streams`
// directly.
(function (internal: BunWasm.Internal) {
  "use strict";
  const streams = internal.require("streams");
  // The UnderlyingSource dictionary's members, in the order WebIDL reads them.
  const sourceMembers = ["autoAllocateChunkSize", "cancel", "pull", "start", "type"];
  const algorithms = new Set(["cancel", "pull", "start"]);

  // The source's members are read once, in WebIDL's order, as the constructor's dictionary
  // conversion reads them; its algorithms then run in `context`. A direct source's `close`,
  // which the direct stream reads after them, keeps the source as `this` but is not moved into
  // the construction context, as in Bun.
  function inContext(source: object, context: unknown): object {
    const dictionary: Record<string, unknown> = {};
    for (const key of sourceMembers) {
      const value: unknown = Reflect.get(source, key);
      if (value === undefined) continue;
      dictionary[key] = algorithms.has(key) && typeof value === "function"
        ? (...args: unknown[]) => internal.runInContext(context, value as (...args: unknown[]) => unknown, source, args)
        : value;
    }
    if (dictionary.type !== "direct") return dictionary;
    const close: unknown = Reflect.get(source, "close");
    if (close !== undefined) {
      dictionary.close = typeof close === "function" ? (...args: unknown[]) => Reflect.apply(close, source, args) : close;
    }
    return dictionary;
  }

  const Stream = streams.ReadableStream;
  // On browser hosts, native-stream-state.ts wraps ReadableStream in a Proxy that already
  // adapts type: "direct". On Node hosts it leaves ReadableStream unwrapped, so adapt here.
  const adaptHostDirect = internal.native.engine === "host" && !internal.native.isProxy(Stream);
  const ReadableStream: typeof globalThis.ReadableStream = new Proxy(Stream, {
    construct(target, args: unknown[], newTarget: Function): object {
      const source = args[0];
      const context = internal.native.getAsyncContext();
      const constructed = newTarget === ReadableStream ? target : newTarget;
      const wrappedSource = context !== undefined && source !== null && typeof source === "object"
        ? inContext(source, context)
        : source;
      const forwarded = wrappedSource === source ? args : [wrappedSource].concat(args.slice(1));
      if (adaptHostDirect && wrappedSource !== null && (typeof wrappedSource === "object" || typeof wrappedSource === "function")) {
        return internal.require("direct_stream").constructNativeReadable(target, forwarded, constructed, wrappedSource, () => {});
      }
      return Reflect.construct(target, forwarded, constructed);
    },
  });
  Object.defineProperty(Stream.prototype, "constructor", { value: ReadableStream, writable: true, configurable: true, enumerable: false });
  return Object.assign({}, streams, { ReadableStream });
})
