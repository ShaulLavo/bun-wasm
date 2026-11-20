// The web stream classes programs see (the globals and node:stream/web), with Bun's
// StreamAsyncContextScope (src/jsc/bindings/webcore/streams/WebStreamsMisc.cpp): a
// ReadableStream keeps the async context it was constructed in, and its source's start, pull
// and cancel run in it, with the source itself as `this`, whoever reads or cancels the stream.
// The runtime's own streams use the classes from `streams` directly.
(function (internal: BunWasm.Internal) {
  "use strict";
  const streams = internal.require("streams");
  // The UnderlyingSource dictionary's members, in the order WebIDL reads them.
  const sourceMembers = ["autoAllocateChunkSize", "cancel", "pull", "start", "type"];
  const algorithms = new Set(["cancel", "pull", "start"]);

  // The source's members are read once, in WebIDL's order, as the constructor's dictionary
  // conversion reads them; its algorithms then run in `context`.
  function inContext(source: object, context: unknown): object {
    const dictionary: Record<string, unknown> = {};
    for (const key of sourceMembers) {
      const value: unknown = Reflect.get(source, key);
      if (value === undefined) continue;
      dictionary[key] = algorithms.has(key) && typeof value === "function"
        ? (...args: unknown[]) => internal.runInContext(context, value as (...args: unknown[]) => unknown, source, args)
        : value;
    }
    return dictionary;
  }

  const Stream = streams.ReadableStream;
  const ReadableStream: typeof globalThis.ReadableStream = new Proxy(Stream, {
    construct(target, args: unknown[], newTarget: Function): object {
      const source = args[0];
      if (source === null || typeof source !== "object") return Reflect.construct(target, args, newTarget);
      return Reflect.construct(target, [inContext(source, internal.native.getAsyncContext())].concat(args.slice(1)), newTarget === ReadableStream ? target : newTarget);
    },
  });
  Object.defineProperty(Stream.prototype, "constructor", { value: ReadableStream, writable: true, configurable: true, enumerable: false });
  return Object.assign({}, streams, { ReadableStream });
})
