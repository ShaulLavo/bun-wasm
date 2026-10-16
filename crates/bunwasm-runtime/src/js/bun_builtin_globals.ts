(function () {
  "use strict";
  const globals: Record<string, unknown> = {
    Array, ArrayBuffer, Buffer, Error, Function, Infinity, Map, Object, Promise, Proxy,
    RangeError, Reflect, RegExp, Set, String, Symbol, TypeError, Uint8Array, URIError, isFinite,
  };
  for (const name of ["ReadableByteStreamController", "ReadableStream", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableStreamDefaultController", "ReadableStreamDefaultReader", "TransformStream", "TransformStreamDefaultController", "WritableStream", "WritableStreamDefaultController", "WritableStreamDefaultWriter"] satisfies (keyof typeof globalThis)[]) {
    globals[name] = globalThis[name];
  }
  return Object.freeze(globals);
})
