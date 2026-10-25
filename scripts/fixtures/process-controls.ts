  type Emitter = {
    on(event: string | symbol, callback: (...args: unknown[]) => void): unknown;
    off(event: string | symbol, callback: (...args: unknown[]) => void): unknown;
    removeListener(event: string | symbol, callback: (...args: unknown[]) => void): unknown;
    removeAllListeners(event?: string | symbol): unknown;
  };
  type Writer = Emitter & { writable: boolean; destroyed: boolean; write(chunk: unknown, callback?: (error: unknown) => void): boolean };
  type Reader = Emitter & { readable: boolean; setEncoding(value: unknown): Reader; resume(): Reader; pause(): Reader; [Symbol.asyncIterator](): AsyncGenerator<unknown> };
  type Guest = Emitter & { stdout: Writer; stderr: Writer; stdin: Reader; env: Record<PropertyKey, unknown>; exitCode: unknown; exit(code?: unknown): never; reallyExit(code?: unknown): never };

export async function processControls(eventsFactory: (internal: object) => Function & { prototype: Emitter }, processFactory: (internal: object) => Guest, assert: typeof import("node:assert/strict")) {
  const controls: string[] = [];
  function fixture() {
    const ticks: (() => void)[] = [];
    const immediates: (() => void)[] = [];
    const writes: unknown[][] = [];
    const envChanges: unknown[][] = [];
    const dispositions = new Map<number, number>();
    const exits: unknown[][] = [];
    const state: { writeFailure: { error: unknown } | null; reads: number; bytes: Uint8Array; exitMutation: unknown } = { writeFailure: null, reads: 0, bytes: new TextEncoder().encode("input"), exitMutation: undefined };
    const exitSentinel = new Error("native exit");
    const internal = {
      native: {
        platformInfo: { version: "test", revision: "test", arch: "wasm32" },
        procIdentity: () => [71, 0],
        env: () => ({}), argv: () => ["bun", "fixture.ts"], execPath: () => "/bin/bun", cwd: () => "/", isatty: () => false,
        hostSignal(number: number, mode: number) { if (mode !== 3) dispositions.set(number, mode); return 0; },
        writeStdout(...args: unknown[]) { writes.push(args); if (state.writeFailure) throw state.writeFailure.error; },
        writeStderr(...args: unknown[]) { writes.push(args); if (state.writeFailure) throw state.writeFailure.error; },
        readStdin() { state.reads++; return state.bytes; },
        utf8Decode(bytes: Uint8Array) { return new TextDecoder().decode(bytes); },
        exit(code: number) { exits.push(["native", code]); throw exitSentinel; },
      },
      nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]) { ticks.push(() => callback(...args)); },
      realTimers: { setImmediate(callback: () => void) { immediates.push(callback); } },
      toUint8(value: ArrayBuffer) { return new Uint8Array(value); },
      workerEnvChange(key: string, value: unknown) { assert.equal(this, internal); envChanges.push([key, value]); },
      emitExit(code: number) { exits.push(["emit", code]); if (state.exitMutation !== undefined) guest.exitCode = state.exitMutation; },
      traceExit(reason: string, code: number) { exits.push([reason, code]); },
      require(name: string) {
        if (name === "events") return events;
        if (name === "process_signals") return () => () => false;
        if (name === "buffer") return { Buffer: { from: (bytes: Uint8Array) => new Uint8Array(bytes) } };
        throw new Error("unexpected module " + name);
      },
    };
    const events = eventsFactory(internal);
    const emitterCalls: string[][] = [];
    Object.defineProperty(events, "call", { value(target: object) {
      emitterCalls.push(Reflect.ownKeys(target).map(String));
      return Reflect.apply(events, target, []);
    } });
    const guest = processFactory(internal);
    function drain(queue: (() => void)[]) { for (let callback; (callback = queue.shift());) callback(); }
    return { guest, events, internal, state, ticks, immediates, writes, envChanges, dispositions, exits, exitSentinel, drain, emitterCalls };
  }

  const writer = fixture();
  const error = new Error("write failure identity");
  writer.state.writeFailure = { error };
  const order: string[] = [];
  const stdout = writer.guest.stdout;
  stdout.on("error", value => { assert.equal(value, error); order.push("error"); });
  assert.equal(stdout.write("first", value => {
    assert.equal(value, error);
    assert.equal(stdout.writable, false);
    order.push("first");
    writer.internal.nextTick(() => order.push("callback tick"));
    assert.equal(stdout.write("reentrant", value => { assert.equal(value, error); order.push("reentrant"); }), false);
  }), false);
  assert.equal(stdout.write("second", value => { assert.equal(value, error); order.push("second"); }), false);
  writer.drain(writer.ticks);
  assert.deepEqual(order, ["first", "second", "reentrant", "callback tick", "error"]);
  assert.equal(stdout.writable, true);
  assert.equal(stdout.destroyed, false);
  assert.deepEqual(writer.writes, [["first", true]]);
  writer.state.writeFailure = null;
  assert.equal(stdout.write("recovered", value => { assert.equal(value, null); order.push("success"); }), true);
  writer.drain(writer.ticks);
  assert.equal(order.at(-1), "success");
  controls.push("writer coalescing, reentrant callback growth, tick/error ordering, same error, and recovery");

  for (const rawError of [undefined, null, false, 0, "", 1n, Symbol("write error"), { raw: true }]) {
    const raw = fixture();
    raw.state.writeFailure = { error: rawError };
    let callbacks = 0;
    assert.equal(raw.guest.stdout.write("x", function (this: unknown, value) {
      assert.equal(this, undefined);
      assert.equal(value, rawError);
      callbacks++;
    }), false);
    raw.drain(raw.ticks);
    assert.equal(callbacks, 1);
    assert.equal(raw.guest.stdout.writable, true);
  }
  controls.push("falsy and non-Error throws keep raw identity and the callback has no receiver");

  const thrown = fixture();
  const callbackError = new Error("callback threw");
  thrown.state.writeFailure = { error };
  assert.equal(thrown.guest.stdout.write("x", () => { throw callbackError; }), false);
  let laterCallback = false;
  thrown.guest.stdout.write("queued", () => { laterCallback = true; });
  assert.throws(() => thrown.drain(thrown.ticks), (value: unknown) => value === callbackError);
  assert.equal(thrown.guest.stdout.writable, false);
  assert.equal(thrown.guest.stdout.write("later", () => {}), false);
  assert.equal(thrown.ticks.length, 0);
  assert.equal(laterCallback, false);
  controls.push("throwing callback leaves the original pending failure and writable flag unchanged");

  const unhandled = fixture();
  unhandled.state.writeFailure = { error };
  unhandled.guest.stdout.write("no callback", undefined);
  const flush = unhandled.ticks.shift();
  assert.ok(flush);
  flush();
  assert.equal(unhandled.guest.stdout.writable, true);
  assert.equal(unhandled.ticks.length, 1);
  assert.throws(() => unhandled.drain(unhandled.ticks), (value: unknown) => value === error);
  const consumed = fixture();
  consumed.state.writeFailure = { error };
  consumed.guest.stdout.write("consumed", value => assert.equal(value, error));
  consumed.drain(consumed.ticks);
  assert.equal(consumed.guest.stdout.writable, true);
  assert.equal(consumed.ticks.length, 0);
  controls.push("unhandled error event retains identity after reset; supplied callback consumes it without extra ticks");

  const env = fixture();
  const raw = { identity: true };
  Object.defineProperty(env.guest.env, "ACCESSOR", { configurable: true, enumerable: true, get: () => raw });
  assert.equal(env.guest.env.ACCESSOR, raw);
  assert.equal(env.envChanges.at(-1)![1], raw);
  const symbol = Symbol("raw environment property");
  env.guest.env[symbol] = raw;
  assert.equal(env.guest.env[symbol], raw);
  env.guest.env.DATA = 7;
  assert.equal(env.guest.env.DATA, "7");
  controls.push("environment accessor and symbol values stay raw while assigned string-key values are coerced");

  const envOrder: unknown[] = [];
  Object.defineProperty(env.guest.env, "SETTER", {
    configurable: true,
    get() { envOrder.push("get"); return raw; },
    set(value: unknown) { envOrder.push(value); },
  });
  envOrder.length = 0;
  env.guest.env.SETTER = 23;
  assert.deepEqual(envOrder, ["23", "get"]);
  assert.deepEqual(env.envChanges.at(-1), ["SETTER", raw]);
  controls.push("environment assignment coerces before the setter and publishes the raw getter result once");

  const envError = new Error("environment getter");
  assert.throws(() => Object.defineProperty(env.guest.env, "THROW", { get() { throw envError; } }), (value: unknown) => value === envError);
  assert.equal(env.envChanges.length, 4);
  const rawSymbol = Symbol("defined raw");
  Object.defineProperty(env.guest.env, rawSymbol, { value: raw, configurable: true });
  assert.equal(env.guest.env[rawSymbol], raw);
  delete env.guest.env.ACCESSOR;
  assert.deepEqual(env.envChanges.at(-1), ["ACCESSOR", undefined]);
  controls.push("environment getter throw identity, raw Symbol descriptor and delete hook");

  const exiting = fixture();
  assert.equal(Object.hasOwn(exiting.guest, "exitCode"), true);
  assert.equal(exiting.guest.exitCode, undefined);
  assert.throws(() => exiting.guest.exit(), (value: unknown) => value === exiting.exitSentinel);
  assert.deepEqual(exiting.exits, [["emit", 0], ["process.exit", 0], ["native", 0]]);
  exiting.exits.length = 0;
  exiting.state.exitMutation = 42;
  assert.throws(() => exiting.guest.exit(7), (value: unknown) => value === exiting.exitSentinel);
  assert.deepEqual(exiting.exits, [["emit", 7], ["process.exit", 42], ["native", 42]]);
  controls.push("exit initially owns undefined code, then rereads an exit-listener mutation with native error identity");

  const coercions: unknown[] = [];
  for (const value of [undefined, null, false, true, 1.5, -1, 4294967297, "17", "NaN", {}, { valueOf: () => 23 }]) {
    const f = fixture();
    assert.throws(() => f.guest.exit(value), (error: unknown) => error === f.exitSentinel);
    coercions.push(f.exits);
  }
  for (const value of [Symbol("code"), 1n]) {
    const f = fixture();
    assert.throws(() => f.guest.exit(value), (error: unknown) => error !== null && typeof error === "object" && "name" in error && error.name === "TypeError");
    assert.deepEqual(f.exits, []);
  }
  const getter = fixture();
  let reads = 0;
  Object.defineProperty(getter.guest, "exitCode", { get() { return ++reads; }, configurable: true });
  assert.throws(() => getter.guest.exit(), (error: unknown) => error === getter.exitSentinel);
  assert.deepEqual(getter.exits, [["emit", 1], ["process.exit", 2], ["native", 3]]);
  const conversionError = new Error("coercion identity");
  const throwing = fixture();
  assert.throws(() => throwing.guest.exit({ valueOf() { throw conversionError; } }), (error: unknown) => error === conversionError);
  assert.deepEqual(throwing.exits, []);
  controls.push("exit ToInt32, raw Symbol/BigInt errors, repeated getter reads and conversion error identity");

  const really = fixture();
  let conversions = 0;
  assert.throws(() => really.guest.reallyExit({ valueOf() { return ++conversions; } }), (value: unknown) => value === really.exitSentinel);
  assert.deepEqual(really.exits, [["process.reallyExit", 1], ["native", 2]]);
  const exitingError = fixture();
  const getterError = new Error("exit getter identity");
  Object.defineProperty(exitingError.guest, "exitCode", { get() { throw getterError; } });
  assert.throws(() => exitingError.guest.exit(), (value: unknown) => value === getterError);
  assert.deepEqual(exitingError.exits, []);
  controls.push("reallyExit repeats the original ToInt32 conversion and exit getter throws keep identity");

  const signals = fixture();
  assert.equal(signals.dispositions.get(13), 1);
  const handler = () => {};
  signals.events.prototype.on.call(signals.guest, "SIGIO", handler);
  signals.guest.on("SIGPOLL", handler);
  assert.equal(signals.dispositions.get(29), 2);
  signals.guest.removeListener("SIGIO", handler);
  assert.equal(signals.dispositions.get(29), 2);
  signals.guest.removeListener("SIGPOLL", handler);
  assert.equal(signals.dispositions.get(29), 0);
  signals.guest.removeAllListeners();
  assert.equal(signals.dispositions.get(13), 1);
  signals.guest.on("SIGPIPE", handler);
  signals.guest.off("SIGPIPE", handler);
  assert.equal(signals.dispositions.get(13), 0);
  controls.push("signal aliases, prototype listener calls, initial SIGPIPE ignore, and last-handler restoration");

  const shape = fixture();
  const shapes: Record<string, string[]> = {};
  for (const name of ["stdout", "stderr"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(shape.guest, name);
    assert.equal(typeof descriptor!.get, "function");
    assert.equal(descriptor!.set, undefined);
    assert.equal(descriptor!.enumerable, true);
    assert.equal(descriptor!.configurable, true);
    const stream = shape.guest[name];
    assert.equal(Object.getPrototypeOf(stream), shape.events.prototype);
    assert.equal(shape.guest[name], stream);
    shapes[name] = Reflect.ownKeys(stream).map(String);
  }
  assert.equal(Object.getPrototypeOf(shape.guest), shape.events.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(shape.guest, "_exiting"), {
    value: false, writable: true, enumerable: false, configurable: true,
  });
  controls.push("lazy stdio getter descriptors, memoized stream identity, emitter prototypes, and own-key order");
  shapes.process = Reflect.ownKeys(shape.guest).map(String);
  assert.deepEqual(shape.emitterCalls, [[], [], []]);
  const descriptors = Object.fromEntries(Reflect.ownKeys(shape.guest).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(shape.guest, key)!;
    return [String(key), { enumerable: descriptor.enumerable, configurable: descriptor.configurable,
      writable: descriptor.writable, getter: typeof descriptor.get, setter: typeof descriptor.set, value: typeof descriptor.value }];
  }));
  return { controls, shapes, coercions, descriptors, emitterCalls: shape.emitterCalls };
}
