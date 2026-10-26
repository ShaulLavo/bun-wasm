type Callback = ((...args: unknown[]) => unknown) | undefined;
type Pressure = { promise: Promise<number | false>; settle: (value: number | false) => void; bytes: number };
type Demand = { settle: () => void };
type Phase = "open" | "ending" | "closed";

function method(source: object, name: string): Callback {
  const value: unknown = Reflect.get(source, name, source);
  if (value === undefined) return;
  if (typeof value !== "function") throw new TypeError(`Direct stream ${name} must be callable`);
  return (...args) => Reflect.apply(value, source, args);
}
function bytes(value: unknown): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new TypeError("write() expects a string, ArrayBufferView, or ArrayBuffer");
}

function directSource(source: object, highWaterMark: number, onController: (controller: object, error: (reason: unknown) => void) => void): UnderlyingDefaultSource<Uint8Array> {
  const pull = method(source, "pull");
  const cancel = method(source, "cancel");
  const close = method(source, "close");
  let phase: Phase = "open";
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let chunks: Uint8Array[] = [];
  let length = 0;
  let pressure: Pressure | undefined;
  let demand: Demand | undefined;
  let pulling = false;
  let inPull = false;
  let scheduled = false;

  function settlePressure(value: number | false) {
    const pending = pressure;
    pressure = undefined;
    pending?.settle(value);
  }
  function settleDemand() {
    const pending = demand;
    demand = undefined;
    pending?.settle();
  }
  function finish() {
    if (phase === "closed") return;
    phase = "closed";
    chunks = [];
    length = 0;
    settlePressure(false);
    controller.close();
    settleDemand();
  }
  function fail(reason: unknown) {
    if (phase !== "open") return;
    phase = "closed";
    chunks = [];
    length = 0;
    settlePressure(false);
    controller.error(reason);
    settleDemand();
    close?.(reason);
  }
  function deliver() {
    scheduled = false;
    if (phase === "closed") return;
    if ((!demand && phase === "open") || length === 0) {
      if (phase === "ending" && length === 0) finish();
      return;
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    chunks = [];
    length = 0;
    controller.enqueue(output);
    if (pressure) settlePressure(pressure.bytes);
    settleDemand();
    if (phase === "ending") finish();
  }
  function schedule() {
    if (scheduled || phase === "closed") return;
    scheduled = true;
    queueMicrotask(deliver);
  }
  function write(value: unknown) {
    if (phase !== "open") return 0;
    const chunk = bytes(value);
    if (chunk.byteLength === 0) return 0;
    chunks.push(chunk);
    length += chunk.byteLength;
    schedule();
    if (!pressure && length < highWaterMark) return chunk.byteLength;
    if (!pressure) {
      const deferred = Promise.withResolvers<number | false>();
      pressure = { promise: deferred.promise, settle: deferred.resolve, bytes: 0 };
    }
    pressure.bytes += chunk.byteLength;
    return pressure.promise;
  }
  function completeEnd() {
    if (phase !== "ending") return;
    if (length === 0) finish();
    else schedule();
    close?.(undefined);
  }
  function end() {
    if (phase !== "open") return;
    phase = "ending";
    if (!inPull) completeEnd();
  }
  function flush() {
    if (phase !== "open") return;
    schedule();
    return pressure?.promise;
  }
  const sink = { write, end, close: (reason?: unknown) => reason ? fail(reason) : end(), flush, error: fail };
  function pulled() {
    pulling = false;
    if (demand && phase === "open") invokePull();
  }
  function invokePull() {
    if (pulling || phase !== "open") return;
    if (!pull) { fail(new TypeError("underlyingSource.pull is not a function")); return; }
    pulling = true;
    inPull = true;
    let result;
    try { result = pull(sink); }
    catch (error) { pulling = false; fail(error); return; }
    finally { inPull = false; completeEnd(); }
    schedule();
    // Delivery can release a read before an async producer finishes. Keep its lock
    // until settlement, but do not repull a synchronous producer with no output.
    Promise.resolve(result).then(() => {
      if (result instanceof Promise) pulled();
      else pulling = false;
    }, error => { pulling = false; fail(error); });
  }
  return {
    start(value) { controller = value; onController(value, fail); },
    pull() {
      const deferred = Promise.withResolvers<void>();
      demand = { settle: deferred.resolve };
      if (length || phase === "ending") schedule();
      else invokePull();
      return deferred.promise;
    },
    cancel(reason) {
      if (phase === "closed") return;
      phase = "closed";
      chunks = [];
      length = 0;
      settlePressure(false);
      settleDemand();
      return Promise.resolve(cancel?.(reason)).then(() => {});
    },
  };
}

export function constructNativeReadable(target: Function, args: unknown[], newTarget: Function, original: unknown, onController: (controller: object, error: (reason: unknown) => void) => void): object {
  if (original === null || typeof original !== "object" && typeof original !== "function") return Reflect.construct(target, args, newTarget);
  const direct = {};
  const wrapped = args[0];
  if (wrapped === null || typeof wrapped !== "object") return Reflect.construct(target, args, newTarget);
  let highWaterMark: unknown;
  const forwarded = args.slice();
  forwarded[0] = new Proxy({}, { get(_target, key) {
    const value: unknown = Reflect.get(wrapped, key, wrapped);
    // Dispatch at native dictionary conversion, after its strategy reads. Never
    // probe type early or repeat a getter after native construction rejects it.
    if (key === "type" && value === "direct") throw direct;
    return value;
  } });
  const strategy = args[1];
  if (strategy !== null && typeof strategy === "object") {
    forwarded[1] = new Proxy({}, { get(_target, key) {
      const value: unknown = Reflect.get(strategy, key, strategy);
      if (key === "highWaterMark") highWaterMark = value;
      return value;
    } });
  }
  try { return Reflect.construct(target, forwarded, newTarget); }
  catch (error) { if (error !== direct) throw error; }
  // The measured React/Bun contract uses a numeric byte watermark. Reject other
  // direct strategies rather than repeating observable numeric conversion.
  if (highWaterMark !== undefined && typeof highWaterMark !== "number") throw new TypeError("Direct stream highWaterMark must be a number");
  if (typeof highWaterMark === "number" && (Number.isNaN(highWaterMark) || highWaterMark < 0)) throw new RangeError("Invalid direct stream highWaterMark");
  const source = directSource(original, highWaterMark || 65536, onController);
  return Reflect.construct(target, [source, { highWaterMark: 0 }], newTarget);
}
