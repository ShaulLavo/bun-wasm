type FromRow = { name: string; pass: boolean };
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function fromIterable(input: unknown): ReadableStream<unknown> {
  const method: unknown = Reflect.get(ReadableStream, "from");
  ensure(typeof method === "function", "ReadableStream.from must be callable");
  const stream: unknown = Reflect.apply(method, undefined, [input]);
  ensure(stream instanceof ReadableStream, "from must create a native readable");
  return stream;
}
function throwsSame(action: () => unknown, expected: unknown) {
  try { action(); } catch (error) { ensure(error === expected, "synchronous error identity"); return; }
  throw new Error("Expected synchronous failure");
}
function throwsType(action: () => unknown) {
  try { action(); } catch (error) { ensure(error instanceof TypeError, "synchronous TypeError"); return; }
  throw new Error("Expected synchronous TypeError");
}
async function rejectsSame(promise: Promise<unknown>, expected: unknown) {
  try { await promise; } catch (error) { ensure(error === expected, "rejection identity"); return; }
  throw new Error("Expected rejection");
}
async function rejectsType(promise: Promise<unknown>) {
  try { await promise; } catch (error) { ensure(error instanceof TypeError, "rejected TypeError"); return; }
  throw new Error("Expected rejected TypeError");
}
function iterable(iterator: object, sync = false) {
  return { [sync ? Symbol.iterator : Symbol.asyncIterator]() { return iterator; } };
}
async function readFailure(iterator: object, error: unknown, sync = false) {
  const reader = fromIterable(iterable(iterator, sync)).getReader();
  await rejectsSame(reader.read(), error);
  reader.releaseLock();
}
async function pendingCancel(settlement: "value" | "done" | "reject") {
  let complete!: (result: unknown) => void;
  let fail!: (error: unknown) => void;
  let started!: () => void;
  const nextStarted = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<unknown>((resolve, reject) => { complete = resolve; fail = reject; });
  const calls: unknown[][] = [];
  const iterator = { next() { started(); return pending; }, return(...args: unknown[]) { calls.push(args); return {}; } };
  const stream = fromIterable(iterable(iterator));
  const completion = Reflect.get(stream, Symbol.for("nodejs.webstream.isClosedPromise")).promise;
  const reader = stream.getReader();
  const read = reader.read();
  await nextStarted;
  await rejectsType(stream.cancel());
  ensure(stream.locked, "caller reader must retain lock");
  await reader.cancel();
  await reader.cancel("second");
  ensure(calls.length === 1 && calls[0]?.length === 1 && calls[0][0] === undefined, "return once with one undefined argument");
  ensure((await read).done, "pending read must complete on cancellation");
  if (settlement === "reject") fail(new Error("late next rejection"));
  else complete({ done: settlement === "done", value: "late" });
  await pending.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 0));
  await completion;
  ensure(stream.locked, "conversion must not release caller reader");
  reader.releaseLock();
  ensure(!stream.locked, "caller can release reader");
}
async function cancelFailure(iterator: object, expected: unknown, sync = false) {
  const stream = fromIterable(iterable(iterator, sync));
  await rejectsSame(stream.cancel(), expected);
}
async function malformedReturn(value: unknown, sync = false) {
  const stream = fromIterable(iterable({ next() { return {}; }, return() { return value; } }, sync));
  await rejectsType(stream.cancel());
}
async function promisedValues(sync: boolean) {
  let nextCalls = 0;
  const stream = fromIterable(iterable({ next() { return { done: nextCalls++ > 0, value: Promise.resolve(42) }; } }, sync));
  const reader = stream.getReader();
  ensure((await reader.read()).value === 42, "current WebIDL sequence must assimilate yielded promise");
  ensure((await reader.read()).done, "iterator completion");
  reader.releaseLock();
}
async function secondValueResolution(throwOnSecond: boolean) {
  let thenGets = 0, nextCalls = 0, returns = 0;
  const value = { get then() {
    thenGets++;
    if (thenGets === 1) return undefined;
    if (throwOnSecond) throw marker;
    return (resolve: (value: unknown) => void) => resolve(42);
  } };
  const iterator = {
    next() { return nextCalls++ === 0 ? { value } : { done: true }; },
    return() { returns++; return {}; },
  };
  const reader = fromIterable(iterable(iterator, true)).getReader();
  try {
    if (throwOnSecond) await rejectsSame(reader.read(), marker);
    else {
      ensure((await reader.read()).value === 42, "outer WebIDL reaction resolves sync value again");
      ensure((await reader.read()).done, "sync iterator completes");
    }
    ensure(thenGets === 2, "AsyncFromSync and outer WebIDL reaction each access then");
    ensure(returns === 0, "outer value resolution must not IteratorClose");
  } finally { reader.releaseLock(); }
}
const marker = { failure: "identity" };
const fromControls: Array<[string, () => unknown]> = [
  ["async first, cached next, zero eager pulls, native ownership", async () => {
    let nextCalls = 0, syncCalls = 0, nextGets = 0;
    const iterator = { get next() { nextGets++; return () => ({ done: nextCalls++ > 0, value: 7 }); } };
    const stream = fromIterable({ [Symbol.asyncIterator]() { return iterator; }, [Symbol.iterator]() { syncCalls++; throw new Error("sync path"); } });
    await Promise.resolve();
    ensure(nextCalls === 0 && syncCalls === 0 && nextGets === 1, "acquire async iterator and cache next without pulling");
    ensure(Object.getPrototypeOf(stream) === ReadableStream.prototype, "native brand and prototype");
    const completion = Reflect.get(stream, Symbol.for("nodejs.webstream.isClosedPromise")).promise;
    const reader = stream.getReader();
    ensure((await reader.read()).value === 7, "first value");
    ensure((await reader.read()).done && nextGets === 1, "cached next");
    await completion;
    reader.releaseLock();
  }],
  ["static descriptor and non-generic construction", async () => {
    const method = Reflect.get(ReadableStream, "from");
    const descriptor = Object.getOwnPropertyDescriptor(ReadableStream, "from");
    ensure(method.name === "from" && method.length === 1 && descriptor?.writable && descriptor.configurable && descriptor.enumerable, "static WebIDL operation descriptor");
    class Subclass extends ReadableStream<unknown> {}
    const stream = Reflect.apply(method, Subclass, [[]]);
    ensure(stream instanceof ReadableStream && Object.getPrototypeOf(stream) === ReadableStream.prototype && !(stream instanceof Subclass), "from ignores receiver constructor");
    throwsType(() => Reflect.construct(method, [[]]));
    await stream.cancel();
  }],
  ["sync values assimilated", () => promisedValues(true)],
  ["async values assimilated", () => promisedValues(false)],
  ["sync value second then access resolves", () => secondValueResolution(false)],
  ["sync value second then access rejects without close", () => secondValueResolution(true)],
  ["null async method selects sync", async () => {
    const stream = fromIterable({ [Symbol.asyncIterator]: null, [Symbol.iterator]() { return [1][Symbol.iterator](); } });
    ensure((await stream.getReader().read()).value === 1, "sync fallback is iterator protocol, not native-method fallback");
  }],
  ["invalid inputs and iterator acquisition", () => {
    for (const input of [undefined, null, 1, "string", {}, { [Symbol.asyncIterator]: 1 }, { [Symbol.iterator]: 1 }]) throwsType(() => fromIterable(input));
  }],
  ["async method getter identity", () => throwsSame(() => fromIterable({ get [Symbol.asyncIterator]() { throw marker; } }), marker)],
  ["sync method getter identity", () => throwsSame(() => fromIterable({ get [Symbol.iterator]() { throw marker; } }), marker)],
  ["iterator factory throw identity", () => throwsSame(() => fromIterable({ [Symbol.asyncIterator]() { throw marker; } }), marker)],
  ["primitive iterator rejected", () => throwsType(() => fromIterable({ [Symbol.asyncIterator]() { return 1; } }))],
  ["next getter identity at acquisition", () => throwsSame(() => fromIterable(iterable({ get next() { throw marker; } })), marker)],
  ["noncallable cached next rejects read", async () => {
    const reader = fromIterable(iterable({ next: 1 })).getReader();
    await rejectsType(reader.read());
    reader.releaseLock();
  }],
  ["next throw identity", () => readFailure({ next() { throw marker; } }, marker)],
  ["next rejection identity", () => readFailure({ next() { return Promise.reject(marker); } }, marker)],
  ["malformed next result", async () => {
    const reader = fromIterable(iterable({ next() { return Promise.resolve(1); } })).getReader();
    await rejectsType(reader.read());
    reader.releaseLock();
  }],
  ["done getter identity", () => readFailure({ next() { return { get done() { throw marker; } }; } }, marker)],
  ["value getter identity", () => readFailure({ next() { return { get value() { throw marker; } }; } }, marker)],
  ["async done skips value getter", async () => {
    const reader = fromIterable(iterable({ next() { return { done: true, get value() { throw marker; } }; } })).getReader();
    ensure((await reader.read()).done, "async done does not read value");
    reader.releaseLock();
  }],
  ["sync done reads value getter", () => readFailure({ next() { return { done: true, get value() { throw marker; } }; } }, marker, true)],
  ["sync rejected value closes with original identity", async () => {
    let returns = 0;
    await readFailure({ next() { return { value: Promise.reject(marker) }; }, return(...args: unknown[]) { ensure(args.length === 0, "IteratorClose gets no argument"); returns++; throw new Error("close failure"); } }, marker, true);
    ensure(returns === 1, "rejected sync value closes once");
  }],
  ["async rejected value identity", () => readFailure({ next() { return { value: Promise.reject(marker) }; } }, marker)],
  ["pending next cancellation, late value", () => pendingCancel("value")],
  ["pending next cancellation, late done", () => pendingCancel("done")],
  ["pending next cancellation, late rejection", () => pendingCancel("reject")],
  ["return getter identity", () => cancelFailure({ next() { return {}; }, get return() { throw marker; } }, marker)],
  ["return throw identity", () => cancelFailure({ next() { return {}; }, return() { throw marker; } }, marker)],
  ["return rejection identity", () => cancelFailure({ next() { return {}; }, return() { return Promise.reject(marker); } }, marker)],
  ["malformed async return", () => malformedReturn(Promise.resolve(1))],
  ["malformed sync return", () => malformedReturn(1, true)],
  ["noncallable return", async () => { await rejectsType(fromIterable(iterable({ return: 1 })).cancel()); }],
  ["missing return", async () => { await fromIterable(iterable({})).cancel(); }],
  ["sync return validates immediate object then awaits value", async () => {
    await fromIterable(iterable({ return() { return Promise.resolve(1); } }, true)).cancel();
    await cancelFailure({ return() { return { value: Promise.reject(marker) }; } }, marker, true);
  }],
  ["return receiver and reason identity", async () => {
    let received = false;
    const iterator = { return(reason: unknown) { ensure(this === iterator && reason === marker && arguments.length === 1, "return invocation"); received = true; return {}; } };
    await fromIterable(iterable(iterator)).cancel(marker);
    ensure(received, "return must run");
  }],
  ["sync acquisition getter and factory identities", () => {
    throwsSame(() => fromIterable({ [Symbol.iterator]() { throw marker; } }), marker);
    throwsSame(() => fromIterable(iterable({ get next() { throw marker; } }, true)), marker);
    throwsType(() => fromIterable({ [Symbol.iterator]() { return null; } }));
  }],
  ["async protocol failure never selects sync", () => {
    throwsType(() => fromIterable({ [Symbol.asyncIterator]: 1, [Symbol.iterator]() { throw marker; } }));
    throwsType(() => fromIterable({ [Symbol.asyncIterator]() { return null; }, [Symbol.iterator]() { throw marker; } }));
  }],
  ["callable iterator objects and receiver identity", async () => {
    const iterator = Object.assign(function () {}, { next() { ensure(this === iterator && arguments.length === 0, "next receiver and arguments"); return { done: true }; } });
    const input = Object.assign(function () {}, { [Symbol.asyncIterator]() { ensure(this === input, "factory receiver"); return iterator; } });
    const reader = fromIterable(input).getReader();
    ensure((await reader.read()).done, "callable objects are objects");
    reader.releaseLock();
  }],
  ["sync malformed next and throw identities", async () => {
    const reader = fromIterable(iterable({ next() { return 1; } }, true)).getReader();
    await rejectsType(reader.read());
    reader.releaseLock();
    await readFailure({ next() { throw marker; } }, marker, true);
  }],
  ["sync done rejected value does not close", async () => {
    let returns = 0;
    await readFailure({ next() { return { done: true, value: Promise.reject(marker) }; }, return() { returns++; return {}; } }, marker, true);
    ensure(returns === 0, "done sync rejection must not IteratorClose");
  }],
  ["sync return getters preserve failure identity", async () => {
    await cancelFailure({ get return() { throw marker; } }, marker, true);
    await cancelFailure({ return() { return { get done() { throw marker; } }; } }, marker, true);
    await cancelFailure({ return() { return { get value() { throw marker; } }; } }, marker, true);
  }],
  ["async return ignores done and value properties", async () => {
    await fromIterable(iterable({ return() { return { get done() { throw marker; }, get value() { throw marker; } }; } })).cancel();
    await fromIterable(iterable({ return: null })).cancel();
  }],
  ["completion error hook tracks from construction", async () => {
    const stream = fromIterable([]);
    const completion = Reflect.get(stream, Symbol.for("nodejs.webstream.isClosedPromise")).promise;
    Reflect.get(stream, Symbol.for("nodejs.webstream.controllerErrorFunction"))(marker);
    await rejectsSame(completion, marker);
  }]
];
export async function checkNativeReadableFrom(native: typeof ReadableStream): Promise<FromRow[]> {
  const rows: FromRow[] = [];
  for (const [name, control] of fromControls) {
    await control();
    rows.push({ name: `ReadableStream.from: ${name}`, pass: true });
  }
  ensure(Object.getPrototypeOf(fromIterable([])) === native.prototype, "preserve original native prototype");
  return rows;
}
