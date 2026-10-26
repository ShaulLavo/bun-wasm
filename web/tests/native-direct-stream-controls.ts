type DirectController = {
  write(value: unknown): number | Promise<number | false>;
  flush(wait?: boolean): undefined | Promise<number | false>;
  end(value?: unknown): void;
  close(reason?: unknown): void;
  error(reason: unknown): void;
};
type DirectSource = {
  type: string;
  pull(controller: DirectController): unknown;
  cancel?(reason: unknown): unknown;
  close?(reason: unknown): unknown;
};
export async function checkNativeDirectStreams(Native: typeof ReadableStream) {
const assert = {
  equal(actual: unknown, expected: unknown) { if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`); },
  ok(value: unknown) { if (!value) throw new Error("Assertion failed"); },
  throws(fn: () => void, matches: (value: unknown) => boolean) {
    try { fn(); } catch (error) { if (matches(error)) return; throw error; }
    throw new Error("Expected a throw");
  },
};
function open(source: DirectSource, strategy?: QueuingStrategy<Uint8Array>): ReadableStream<Uint8Array> {
  return Reflect.construct(ReadableStream, [source, strategy]);
}
const wait = () => new Promise(resolve => setTimeout(resolve, 5));
const rows: { name: string; pass: boolean; result?: unknown; error?: string }[] = [];
async function check(name: string, body: () => Promise<unknown>) {
  try { rows.push({ name, pass: true, result: await body() }); }
  catch (error) { rows.push({ name, pass: false, error: String(error) }); }
}
await check("flush-in-pull-is-deferred-and-methods-bound", async () => {
  const body = open({ type: "direct", pull(c) {
    const { write, flush, end } = c;
    assert.equal(write("a"), 1);
    assert.equal(flush(), undefined);
    assert.equal(write("b"), 1);
    end("ignored");
  } });
  const reader = body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "ab");
  assert.equal((await reader.read()).done, true);
  return { first: "ab", endArgumentIgnored: true };
});
await check("flush-true-returns-shared-pending-pressure-and-repulls", async () => {
  let controller!: DirectController;
  let pulls = 0;
  const body = open({ type: "direct", pull(c) { controller = c; if (++pulls === 1) c.write("init"); } }, { highWaterMark: 2048 });
  const reader = body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "init");
  const pressure = controller.write("é".repeat(1024));
  if (!(pressure instanceof Promise)) throw new Error("Expected shared pressure promise");
  assert.equal(controller.flush(true), pressure);
  let settled = false;
  pressure.then(() => { settled = true; });
  await wait();
  assert.equal(settled, false);
  const chunk = (await reader.read()).value!;
  assert.equal(chunk.byteLength, 2048);
  assert.equal(await pressure, 2048);
  controller.end();
  assert.equal((await reader.read()).done, true);
  return { pendingWithoutReader: true, pressureBytes: chunk.byteLength, pulls };
});
await check("error-settles-pressure-false-and-close-hook-receives-exact-reason", async () => {
  let controller!: DirectController;
  let closedReason: unknown;
  let closeReceiverMatches = false;
  const error = { exact: "error" };
  const source = { type: "direct", pull(c) { controller = c; }, close(reason) { closedReason = reason; closeReceiverMatches = this === source; } } satisfies DirectSource;
  const body = open(source, { highWaterMark: 1 });
  const reader = body.getReader();
  const next = reader.read().catch(reason => reason);
  const closed = reader.closed.catch(reason => reason);
  await wait();
  const pressure = controller.write("abc");
  controller.error(error);
  assert.equal(await pressure, false);
  assert.equal(await next, error);
  assert.equal(await closed, error);
  assert.equal(closedReason, error);
  assert.equal(closeReceiverMatches, true);
  return { pressure: false, errorIdentity: true, closeReceiver: true };
});
await check("cancel-before-read-is-lazy-and-awaits-source-cancel", async () => {
  let pulls = 0;
  let cancelReason: unknown;
  let cancelReceiverMatches = false;
  let release!: () => void;
  const deferred = new Promise<void>(resolve => { release = resolve; });
  const reason = { exact: "cancel" };
  const source = { type: "direct", pull() { pulls++; }, cancel(input) { cancelReason = input; cancelReceiverMatches = this === source; return deferred; } } satisfies DirectSource;
  const body = open(source);
  let settled = false;
  const cancelled = body.cancel(reason).then(() => { settled = true; });
  await wait();
  assert.equal(settled, false);
  assert.equal(pulls, 0);
  assert.equal(cancelReason, reason);
  assert.equal(cancelReceiverMatches, true);
  release();
  await cancelled;
  return { pulls, awaitsCancel: true, reasonIdentity: true };
});
await check("close-truthy-reason-errors-but-end-ignores-argument", async () => {
  const reason = { exact: "close" };
  const body = open({ type: "direct", pull(c) { c.write("discard"); c.close(reason); } });
  const reader = body.getReader();
  const closed = reader.closed.catch(error => error);
  assert.equal(await reader.read().catch(error => error), reason);
  assert.equal(await closed, reason);
  return { closeErrors: true };
});
await check("source-close-throw-propagates-after-stream-already-closed", async () => {
  const error = { exact: "close hook" };
  let controller!: DirectController;
  const body = open({ type: "direct", pull(c) { controller = c; }, close() { throw error; } });
  const reader = body.getReader();
  const next = reader.read().catch(reason => reason);
  const closed = reader.closed.catch(reason => reason);
  await wait();
  assert.throws(() => controller.end(), thrown => thrown === error);
  const result = await next;
  assert.equal(await closed, undefined);
  assert.equal(typeof result === "object" && result !== null && "done" in result && result.done, true);
  return { synchronousThrow: true, pendingRead: result, streamClosedBeforeHookThrow: true };
});
await check("async-pull-does-not-overlap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let pulls = 0;
  const body = open({ type: "direct", async pull(c) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const count = ++pulls;
    await wait();
    c.write(String(count));
    if (count === 2) c.end();
    inFlight--;
  } });
  const reader = body.getReader();
  const values = await Promise.all([reader.read(), reader.read(), reader.read()]);
  assert.equal(maxInFlight, 1);
  assert.equal(values[2].done, true);
  assert.equal(values.slice(0, 2).map(v => new TextDecoder().decode(v.value)).join(""), "12");
  return { maxInFlight, pulls };
});

await check("missing-pull-rejects-read-with-native-type-error", async () => {
  const body: ReadableStream<Uint8Array> = Reflect.construct(ReadableStream, [{ type: "direct" }]);
  const reader = body.getReader();
  const closed = reader.closed.catch(error => error);
  const timeout = Symbol("pending read");
  const outcome = await Promise.race([
    reader.read().catch(error => error),
    new Promise(resolve => setTimeout(() => resolve(timeout), 100)),
  ]);
  await reader.cancel().catch(() => {});
  assert.ok(outcome instanceof TypeError);
  if (!(outcome instanceof TypeError)) throw new Error("Expected missing-pull TypeError");
  assert.equal(outcome.message, "underlyingSource.pull is not a function");
  assert.equal(await closed, outcome);
});
for (const buffered of [false, true]) {
  await check("end-in-synchronous-pull-defers-close-" + (buffered ? "buffered" : "empty"), async () => {
    const events: string[] = [];
    const body = open({ type: "direct", pull(c) {
      events.push("pull");
      if (buffered) c.write("buffer");
      c.end();
      events.push("after-end");
      assert.equal(c.write("late"), 0);
      c.error("ignored after end");
    }, close() { events.push("close"); } });
    const reader = body.getReader();
    const first = await reader.read();
    assert.equal(events.join(","), "pull,after-end,close");
    if (buffered) assert.equal(new TextDecoder().decode(first.value), "buffer");
    else assert.equal(first.done, true);
    assert.equal((await reader.read()).done, true);
  });
}
await check("zero-watermark-uses-native-default", async () => {
  let sink!: DirectController;
  const body = open({ type: "direct", pull(c) { sink = c; } }, { highWaterMark: 0 });
  const reader = body.getReader();
  const next = reader.read();
  await wait();
  const written = sink.write("a");
  await reader.cancel();
  await next;
  await written;
  assert.equal(written, 1);
});
await check("end-outside-async-pull-calls-close-synchronously", async () => {
  let sink!: DirectController;
  const events: string[] = [];
  const deferred = Promise.withResolvers<void>();
  const body = open({ type: "direct", pull(c) { sink = c; return deferred.promise; }, close() { events.push("close"); } });
  const reader = body.getReader();
  const next = reader.read();
  await wait();
  sink.end();
  events.push("after-end");
  deferred.resolve();
  assert.equal(events.join(","), "close,after-end");
  assert.equal((await next).done, true);
});

async function getterTrace(Ctor: typeof ReadableStream, type: string | undefined) {
  const reads: string[] = [];
  const value = { type, start(c: ReadableStreamDefaultController<Uint8Array>) { reads.push("startCall"); c.close(); }, pull() {}, cancel() {} };
  const source = new Proxy(value, { get(object, key) { reads.push(String(key)); return Reflect.get(object, key, object); } });
  const strategy = new Proxy({ highWaterMark: 2048 }, { get(object, key) { reads.push("strategy." + String(key)); return Reflect.get(object, key, object); } });
  let error;
  try { await Reflect.construct(Ctor, [source, strategy]).cancel(); }
  catch (failure) { error = failure instanceof Error ? failure.name : String(failure); }
  return JSON.stringify({ reads, error });
}
for (const type of [undefined, "bytes", "invalid"]) {
  await check("native-getter-order-" + String(type), async () => {
    assert.equal(await getterTrace(ReadableStream, type), await getterTrace(Native, type));
  });
}
await check("direct-buffer-copy-shared-pressure-and-terminal-writes", async () => {
  let first!: number | Promise<number | false>;
  let second!: number | Promise<number | false>;
  const body = open({ type: "direct", pull(c) {
    assert.equal(c.write("abc"), 3);
    const input = new Uint8Array([100, 101, 102]);
    first = c.write(input);
    input.fill(0);
    second = c.write(new Uint8Array([103, 104, 105]).buffer);
    c.end("ignored");
    assert.equal(c.write("late"), 0);
    assert.equal(c.flush(), undefined);
  } }, { highWaterMark: 5 });
  const reader = body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "abcdefghi");
  assert.equal(first, second);
  assert.equal(await first, 6);
  assert.equal((await reader.read()).done, true);
});
await check("bridge-error-hook-settles-direct-pressure", async () => {
  let sink!: DirectController;
  const body = open({ type: "direct", pull(c) { sink = c; } }, { highWaterMark: 1 });
  const reader = body.getReader();
  const next = reader.read().catch(error => error);
  const closed = reader.closed.catch(error => error);
  await wait();
  const pressure = sink.write("pending");
  const error = { exact: "bridge error" };
  const inject = Reflect.get(body, Symbol.for("nodejs.webstream.controllerErrorFunction"));
  inject(error);
  assert.equal(await pressure, false);
  assert.equal(await next, error);
  assert.equal(await closed, error);
});

await check("direct-dispatch-at-native-type-getter-and-no-start", async () => {
  const reads: string[] = [];
  let pulls = 0;
  const source = {
    get type() { reads.push("type"); return "direct"; },
    get start() { throw new Error("Direct source start must be ignored"); },
    pull(c: DirectController) { pulls++; c.end(); },
  };
  const strategy = { get highWaterMark() { reads.push("hwm"); return 2048; } };
  const body = open(source, strategy);
  assert.equal(pulls, 0);
  assert.equal(reads.filter(value => value === "type").length, 1);
  assert.ok(reads.indexOf("hwm") < reads.indexOf("type"));
  assert.equal((await body.getReader().read()).done, true);
  assert.equal(pulls, 1);
});
await check("cancel-settles-pressure-false-and-closes-pending-read", async () => {
  let sink!: DirectController;
  let cancels = 0;
  const reason = { exact: "active cancellation" };
  const body = open({ type: "direct", pull(c) { sink = c; }, cancel(value) { cancels++; assert.equal(value, reason); } }, { highWaterMark: 1 });
  const reader = body.getReader();
  const next = reader.read();
  await wait();
  const pressure = sink.write("pending");
  await reader.cancel(reason);
  assert.equal(await pressure, false);
  assert.equal((await next).done, true);
  assert.equal(sink.write("late"), 0);
  assert.equal(sink.flush(), undefined);
  assert.equal(cancels, 1);
});

await check("buffered-end-closes-hook-now-and-settles-pressure-before-read", async () => {
  let sink!: DirectController;
  let pulls = 0;
  let closes = 0;
  const body = open({ type: "direct", pull(c) { sink = c; if (++pulls === 1) c.write("init"); }, close(reason) { closes++; assert.equal(reason, undefined); } }, { highWaterMark: 2 });
  const reader = body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "init");
  const pressure = sink.write("buffer");
  let settled: number | false | undefined;
  if (!(pressure instanceof Promise)) throw new Error("Expected pressure promise");
  pressure.then(value => { settled = value; });
  sink.end();
  assert.equal(closes, 1);
  sink.error("ignored after end");
  await wait();
  assert.equal(settled, 6);
  assert.equal(new TextDecoder().decode((await reader.read()).value), "buffer");
  assert.equal((await reader.read()).done, true);
  assert.equal(closes, 1);
});

return rows;
}
