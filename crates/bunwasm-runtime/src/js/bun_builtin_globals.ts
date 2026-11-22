(function (internal?: Pick<BunWasm.Internal, "require">) {
  "use strict";
  const globals: Record<string, unknown> = {
    Array, ArrayBuffer, Error, Function, Infinity, Map, Object, Promise, Proxy,
    RangeError, Reflect, RegExp, Set, String, Symbol, TypeError, Uint8Array, URIError, isFinite,
  };
  // Buffer is a lazy global (bootstrap.js): reading it here would load buffer.js on every start.
  // The getter returns the original class, as reading the global at startup did.
  const buffer = internal ? () => internal.require("buffer").Buffer : ((value: unknown) => () => value)(Buffer);
  Object.defineProperty(globals, "Buffer", { enumerable: true, get: buffer });
  for (const name of ["ReadableByteStreamController", "ReadableStream", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableStreamDefaultController", "ReadableStreamDefaultReader", "TransformStream", "TransformStreamDefaultController", "WritableStream", "WritableStreamDefaultController", "WritableStreamDefaultWriter"] satisfies (keyof typeof globalThis)[]) {
    globals[name] = globalThis[name];
  }
  // Web classes for the thirdparty fetch builtins' bindings (node-fetch, undici), which use the
  // originals even after application code replaces the globals. Lazy globals are skipped, not realized.
  for (const name of ["AbortSignal", "Blob", "CloseEvent", "ErrorEvent", "File", "FormData", "Headers", "MessageEvent", "Request", "Response", "URL", "URLSearchParams"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (descriptor && "value" in descriptor) globals[name] = descriptor.value;
  }
  return Object.freeze(globals);
})
