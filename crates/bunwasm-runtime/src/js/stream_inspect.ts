// Bun's [nodejs.util.inspect.custom] for the web stream classes
// (src/jsc/bindings/webcore/streams/WebStreamsInspectCustom.cpp and each class's
// JS*.cpp): `ReadableStream { locked: false, state: 'readable', supportsBYOB: false }`
// instead of the implementation's internal fields. Loading this module installs the
// methods; bootstrap.js loads it with the globals.
//
// QuickJS and JSC run the WHATWG ponyfill, whose state lives in `_`-prefixed fields.
// The Browser engine runs the host's classes: under Node their state is the own
// `kState` symbol Node's own inspector reads; a browser exposes no state, so a class
// whose fields are not all public keeps the default formatting there.
(function (internal: {
  require(name: "streams"): BunWasm.StreamGlobals;
  require(name: "inspect"): { nodeInspect(value: unknown, options?: object): string };
  native: { engine: string };
}) {
  "use strict";
  type Data = Record<string, unknown>;
  // Returns undefined when `self` is not an instance, or its state is not readable.
  type Extract = (self: object) => Data | undefined;
  type Spec = { name: keyof BunWasm.StreamGlobals; data: Extract; strict?: boolean };

  const streams = internal.require("streams");
  const custom = Symbol.for("nodejs.util.inspect.custom");
  const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
  const field = (value: object, key: PropertyKey): unknown => Reflect.get(value, key);
  const isObject = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";

  function getter(name: keyof BunWasm.StreamGlobals, key: string): (self: object) => unknown {
    const get = Object.getOwnPropertyDescriptor(streams[name].prototype, key)?.get;
    if (!get) throw new TypeError(`Missing ${name}.prototype.${key} getter`);
    return self => Reflect.apply(get, self, []);
  }

  // Reads public getters; any throw means the receiver is not an instance.
  function publicData(keys: Record<string, (self: object) => unknown>): Extract {
    return self => {
      const data: Data = {};
      try {
        for (const [key, read] of Object.entries(keys)) data[key] = read(self);
      } catch { return undefined; }
      return data;
    };
  }

  function invalidThis(name: string): TypeError {
    return Object.assign(new TypeError(`Value of "this" must be of type ${name}`), { code: "ERR_INVALID_THIS" });
  }

  function toNumber(value: unknown): number {
    return +(value as number);
  }

  // Bun::WebStreams::customInspect: `${name} ${util.inspect(data, { ...options, depth: depth - 1 })}`.
  function inspectData(self: object, depth: unknown, options: unknown, name: string, data: Data): unknown {
    if (toNumber(depth) < 0) return self;
    const copy: Record<PropertyKey, unknown> = {};
    let childDepth: number | null = null;
    if (isObject(options)) {
      for (const key in options) copy[key] = field(options, key);
      for (const key of Object.getOwnPropertySymbols(options)) {
        if (Object.prototype.propertyIsEnumerable.call(options, key)) copy[key] = field(options, key);
      }
      const optionsDepth = field(options, "depth");
      if (optionsDepth !== undefined && optionsDepth !== null) childDepth = toNumber(optionsDepth) - 1;
    }
    copy.depth = childDepth;
    return `${name} ${internal.require("inspect").nodeInspect(data, copy)}`;
  }

  function install({ name, data, strict }: Spec): void {
    const method = {
      [custom](this: unknown, depth: unknown, options: unknown): unknown {
        const values = isObject(this) ? data(this) : undefined;
        if (values) return inspectData(this as object, depth, options, name, values);
        if (strict) throw invalidThis(name);
        return this;
      },
    }[custom];
    Object.defineProperty(streams[name].prototype, custom, { value: method, writable: true, enumerable: false, configurable: true });
  }

  const readableLocked = getter("ReadableStream", "locked");
  const writableLocked = getter("WritableStream", "locked");
  const writerDesiredSize = getter("WritableStreamDefaultWriter", "desiredSize");
  const pair = (name: "TextEncoderStream" | "TextDecoderStream" | "CompressionStream" | "DecompressionStream") =>
    ({ readable: getter(name, "readable"), writable: getter(name, "writable") });
  const highWaterMark = (name: "ByteLengthQueuingStrategy" | "CountQueuingStrategy") => publicData({ highWaterMark: getter(name, "highWaterMark") });
  // A readable stream controller shows no fields; its desiredSize getter is the brand check.
  const controller = (name: "ReadableStreamDefaultController" | "ReadableByteStreamController"): Extract => {
    const brand = publicData({ desiredSize: getter(name, "desiredSize") });
    return self => brand(self) && {};
  };
  const writerDesired = (self: object, stream: unknown) => stream === undefined ? null : writerDesiredSize(self);

  // The ponyfill brands each class by one own field, as its IsReadableStream and friends do.
  function ponyfill(name: keyof BunWasm.StreamGlobals, brand: string, read: (self: object) => Data): Extract {
    const prototype = streams[name].prototype;
    return self => hasOwn(self, brand) && Object.prototype.isPrototypeOf.call(prototype, self) ? read(self) : undefined;
  }

  function ponyfillSpecs(): Spec[] {
    const isBytes = (value: unknown) => value instanceof streams.ReadableByteStreamController;
    const count = (queue: unknown) => isObject(queue) ? field(queue, "length") : 0;
    return [
      { name: "ReadableStream", data: ponyfill("ReadableStream", "_readableStreamController", self => ({
        locked: field(self, "_reader") !== undefined, state: field(self, "_state"), supportsBYOB: isBytes(field(self, "_readableStreamController")) })) },
      { name: "ReadableStreamDefaultReader", data: ponyfill("ReadableStreamDefaultReader", "_readRequests", self => ({
        stream: field(self, "_ownerReadableStream"), readRequests: count(field(self, "_readRequests")), close: field(self, "_closedPromise") })) },
      { name: "ReadableStreamBYOBReader", data: ponyfill("ReadableStreamBYOBReader", "_readIntoRequests", self => ({
        stream: field(self, "_ownerReadableStream"), readIntoRequests: count(field(self, "_readIntoRequests")), close: field(self, "_closedPromise") })) },
      { name: "ReadableStreamDefaultController", data: ponyfill("ReadableStreamDefaultController", "_controlledReadableStream", () => ({})) },
      { name: "ReadableByteStreamController", data: ponyfill("ReadableByteStreamController", "_controlledReadableByteStream", () => ({})) },
      { name: "ReadableStreamBYOBRequest", data: ponyfill("ReadableStreamBYOBRequest", "_associatedReadableByteStreamController", self => ({
        view: field(self, "_view") ?? null, controller: field(self, "_associatedReadableByteStreamController") })) },
      { name: "WritableStream", data: ponyfill("WritableStream", "_writableStreamController", self => ({
        locked: field(self, "_writer") !== undefined, state: field(self, "_state") })) },
      { name: "WritableStreamDefaultWriter", data: ponyfill("WritableStreamDefaultWriter", "_ownerWritableStream", self => {
        const stream = field(self, "_ownerWritableStream");
        return { stream, close: field(self, "_closedPromise"), ready: field(self, "_readyPromise"), desiredSize: writerDesired(self, stream) };
      }) },
      { name: "WritableStreamDefaultController", data: ponyfill("WritableStreamDefaultController", "_controlledWritableStream", self => ({
        stream: field(self, "_controlledWritableStream") })) },
      { name: "TransformStream", data: ponyfill("TransformStream", "_transformStreamController", self => ({
        readable: field(self, "_readable"), writable: field(self, "_writable"), backpressure: field(self, "_backpressure") })) },
      { name: "TransformStreamDefaultController", data: ponyfill("TransformStreamDefaultController", "_controlledTransformStream", self => ({
        stream: field(self, "_controlledTransformStream") })) },
    ];
  }

  // Node keeps each instance's state in an own symbol named kState.
  function nodeState(self: object): Data | undefined {
    const key = Object.getOwnPropertySymbols(self).find(symbol => symbol.description === "kState");
    const state = key === undefined ? undefined : field(self, key);
    return isObject(state) ? state as Data : undefined;
  }

  function host(name: keyof BunWasm.StreamGlobals, read: (self: object, state: Data) => Data | undefined): Extract {
    const prototype = streams[name].prototype;
    return self => {
      if (!Object.prototype.isPrototypeOf.call(prototype, self)) return undefined;
      const state = nodeState(self);
      return state && read(self, state);
    };
  }

  function hostSpecs(): Spec[] {
    const length = (value: unknown) => Array.isArray(value) ? value.length : 0;
    const promise = (value: unknown) => isObject(value) ? field(value, "promise") : undefined;
    return [
      { name: "ReadableStream", data: host("ReadableStream", (self, state) => ({
        locked: readableLocked(self), state: state.state, supportsBYOB: state.controller instanceof streams.ReadableByteStreamController })) },
      { name: "ReadableStreamDefaultReader", data: host("ReadableStreamDefaultReader", (_self, state) => ({
        stream: state.stream, readRequests: length(state.readRequests), close: promise(state.close) })) },
      { name: "ReadableStreamBYOBReader", data: host("ReadableStreamBYOBReader", (_self, state) => ({
        stream: state.stream, readIntoRequests: length(state.readIntoRequests), close: promise(state.close) })) },
      { name: "ReadableStreamDefaultController", data: controller("ReadableStreamDefaultController") },
      { name: "ReadableByteStreamController", data: controller("ReadableByteStreamController") },
      { name: "ReadableStreamBYOBRequest", data: host("ReadableStreamBYOBRequest", (_self, state) => ({ view: state.view ?? null, controller: state.controller })) },
      { name: "WritableStream", data: host("WritableStream", (self, state) => ({ locked: writableLocked(self), state: state.state })) },
      { name: "WritableStreamDefaultWriter", data: host("WritableStreamDefaultWriter", (self, state) => ({
        stream: state.stream, close: promise(state.close), ready: promise(state.ready), desiredSize: writerDesired(self, state.stream) })) },
      { name: "WritableStreamDefaultController", data: host("WritableStreamDefaultController", (_self, state) => ({ stream: state.stream })) },
      { name: "TransformStream", data: host("TransformStream", (_self, state) => ({ readable: state.readable, writable: state.writable, backpressure: state.backpressure })) },
      { name: "TransformStreamDefaultController", data: host("TransformStreamDefaultController", (_self, state) => ({ stream: state.stream })) },
    ];
  }

  // Every field of these is public on every engine. The transform wrappers brand-check
  // and throw ERR_INVALID_THIS on another receiver, as Bun and Node do.
  const publicSpecs: Spec[] = [
    { name: "ByteLengthQueuingStrategy", data: highWaterMark("ByteLengthQueuingStrategy") },
    { name: "CountQueuingStrategy", data: highWaterMark("CountQueuingStrategy") },
    { name: "TextEncoderStream", strict: true, data: publicData(Object.assign({ encoding: getter("TextEncoderStream", "encoding") }, pair("TextEncoderStream"))) },
    { name: "TextDecoderStream", strict: true, data: publicData(Object.assign({
      encoding: getter("TextDecoderStream", "encoding"), fatal: getter("TextDecoderStream", "fatal"), ignoreBOM: getter("TextDecoderStream", "ignoreBOM") }, pair("TextDecoderStream"))) },
    { name: "CompressionStream", strict: true, data: publicData(pair("CompressionStream")) },
    { name: "DecompressionStream", strict: true, data: publicData(pair("DecompressionStream")) },
  ];

  const specs = internal.native.engine === "host" ? hostSpecs() : ponyfillSpecs();
  for (const spec of specs.concat(publicSpecs)) install(spec);
})
