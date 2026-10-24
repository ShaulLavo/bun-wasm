type CompletionProbe = {
  readonly promise: Promise<void>;
  readonly weak: WeakRef<object>;
  resolvers?: unknown;
  done: boolean;
  group?: unknown;
};
type CompletionRow = { name: string; pass: true } | { name: string; pass: false; error: string };
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const completionKey = Symbol.for("nodejs.webstream.isClosedPromise");
const errorFunctionKey = Symbol.for("nodejs.webstream.controllerErrorFunction");
function observe(stream: object): CompletionProbe {
  const record: CompletionProbe = Reflect.get(stream, completionKey);
  check(typeof record?.done === "boolean" && "promise" in record && "weak" in record, "completion record missing");
  return record;
}
function outcome(promise: Promise<void>) {
  return promise.then(() => ({ failed: false as const }), (error: unknown) => ({ failed: true as const, error }));
}
async function completionTurn(record: CompletionProbe) {
  for (let attempt = 0; attempt < 40 && !record.done; attempt++) await tick();
  check(record.done, "completion never recorded");
}

async function lazyAllocation() {
  const OriginalWeakRef = globalThis.WeakRef;
  let allocations = 0;
  const allocationCount = () => allocations;
  globalThis.WeakRef = new Proxy(OriginalWeakRef, { construct(target, args) {
    allocations++;
    return Reflect.construct(target, args);
  } });
  try {
    const stream = new ReadableStream({ start(controller) { controller.close(); } });
    check(allocationCount() === 1, `construction allocated ${allocations} weak refs`);
    const record = observe(stream);
    check(allocationCount() === 2, "watch did not allocate one cached weak reference");
    check(record.resolvers === undefined, "watch eagerly made a promise");
    check(record.weak === record.weak && allocationCount() === 2, "weak reference not cached");
    await completionTurn(record);
    check(record.resolvers === undefined, "settlement eagerly made a promise");
    const promise = record.promise;
    check(promise === record.promise && observe(stream).promise === promise, "promise not stable");
    await promise;
    check(!stream.locked, "observation retained a stream lock");
  } finally { globalThis.WeakRef = OriginalWeakRef; }
}

async function lateReadableErrors() {
  for (const reason of [undefined, null, false, 0, "", NaN, { marker: "original" }]) {
    const stream = new ReadableStream({ start(controller) { controller.error(reason); } });
    const record = observe(stream);
    await completionTurn(record);
    check(record.resolvers === undefined, "unexpected eager error promise");
    const result = await outcome(record.promise);
    check(result.failed && Object.is(result.error, reason), "rejection identity changed");
    check(!stream.locked, "error observation retained a lock");
  }
}

async function earlyPromiseAndCancel() {
  const reason = { marker: "cancel" };
  let cancelled: unknown;
  const stream = new ReadableStream({ cancel(value) { cancelled = value; } });
  const record = observe(stream);
  const promise = record.promise;
  await stream.cancel(reason);
  await promise;
  check(cancelled === reason && record.done, "cancel lost reason or completion");
  check(record.promise === promise, "cancel replaced completion promise");
  const errored = new ReadableStream();
  Reflect.get(errored, errorFunctionKey)(false);
  const errorRecord = observe(errored);
  await completionTurn(errorRecord);
  const result = await outcome(errorRecord.promise);
  check(result.failed && result.error === false, "injected false error was lost");
}

async function asynchronousAbort() {
  const reason = { marker: "async abort" };
  let release!: () => void;
  let received: unknown;
  const stream = new WritableStream({ abort(value) {
    received = value;
    return new Promise<void>(resolve => { release = resolve; });
  } });
  const record = observe(stream);
  const aborting = stream.abort(reason);
  await tick();
  check(!record.done && record.resolvers === undefined, "abort completed or allocated too early");
  release();
  await aborting;
  await completionTurn(record);
  check(record.resolvers === undefined && received === reason, "abort bookkeeping changed");
  const result = await outcome(record.promise);
  check(result.failed && result.error === reason, "late abort identity changed");
}

async function pendingWrite() {
  let release!: () => void;
  const stream = new WritableStream({ write() { return new Promise<void>(resolve => { release = resolve; }); } }, { highWaterMark: 1 });
  const record = observe(stream);
  const writer = stream.getWriter();
  const writing = writer.write("one");
  let ready = false;
  writer.ready.then(() => { ready = true; });
  await tick();
  check(!ready && !record.done && writer.desiredSize === 0, "observer changed backpressure");
  const closing = writer.close();
  check(record.resolvers === undefined, "pending write allocated completion promise");
  release();
  await writing;
  await closing;
  await completionTurn(record);
  await record.promise;
  writer.releaseLock();
  check(!stream.locked, "writer remained locked");
}

async function queuedClose() {
  const stream = new ReadableStream({ start(controller) { controller.enqueue("one"); controller.close(); } });
  const record = observe(stream);
  await tick();
  check(!record.done && record.resolvers === undefined && !stream.locked, "queued close completed early");
  const reader = stream.getReader();
  check((await reader.read()).value === "one", "queue value changed");
  check((await reader.read()).done, "EOF missing");
  reader.releaseLock();
  await completionTurn(record);
  await record.promise;
}

async function transformCompletion() {
  const transform = new TransformStream();
  const readable = observe(transform.readable);
  const writable = observe(transform.writable);
  check(readable.group !== undefined && readable.group === writable.group, "transform ports lost shared controller");
  check(readable.resolvers === undefined && writable.resolvers === undefined, "transform eagerly allocated promises");
  const writer = transform.writable.getWriter();
  await writer.close();
  writer.releaseLock();
  await completionTurn(readable);
  await completionTurn(writable);
  check(readable.resolvers === undefined && writable.resolvers === undefined, "transform settlement eagerly allocated promises");
  await Promise.all([readable.promise, writable.promise]);
  check(readable.promise !== writable.promise, "transform ports shared one promise");
}

async function lateWritableErrors() {
  for (const reason of [undefined, null, false, 0, ""]) {
    const stream = new WritableStream({ start(controller) { controller.error(reason); } });
    const record = observe(stream);
    await completionTurn(record);
    const result = await outcome(record.promise);
    check(result.failed && Object.is(result.error, reason), "writable rejection identity changed");
  }
}

const completionControls: Array<[string, () => Promise<void>]> = [
  ["WeakRef and completion promise allocation are lazy", lazyAllocation],
  ["synchronous construction errors survive late promise reads", lateReadableErrors],
  ["early promise, cancellation and late error injection", earlyPromiseAndCancel],
  ["late writable completion waits for asynchronous abort", asynchronousAbort],
  ["writable pending write preserves backpressure", pendingWrite],
  ["readable queued close is not terminal until drained", queuedClose],
  ["transform ports settle independently without eager promise", transformCompletion],
  ["writable synchronous falsy errors survive late observation", lateWritableErrors],
];

async function runControl(name: string, control: () => Promise<void>): Promise<CompletionRow> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("case deadline")), 2500); });
  try {
    await Promise.race([control(), deadline]);
    return { name, pass: true };
  } catch (error) {
    return { name, pass: false, error: String(error) };
  } finally { clearTimeout(timer); }
}
export async function checkNativeStreamCompletion(): Promise<CompletionRow[]> {
  const rows: CompletionRow[] = [];
  for (const [name, control] of completionControls) rows.push(await runControl(`native completion: ${name}`, control));
  return rows;
}
