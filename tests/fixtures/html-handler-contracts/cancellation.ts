import assert from "node:assert/strict";
import { htmlRewriterCount } from "bun:internal-for-testing";

type Phase = "outside" | "handler" | "then getter" | "species getter" | "custom then" | "species throw";
const encoder = new TextEncoder();
const intrinsicThen = Promise.prototype.then;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));

async function collect(refs: WeakRef<object>[]) {
  for (let turn = 0; turn < 100; turn++) {
    await tick();
    Bun.gc(true);
    await tick();
    if (refs.every(ref => ref.deref() === undefined)) return;
  }
  assert.ok(refs.every(ref => ref.deref() === undefined), "input must collect before retained handler settlement");
}

function inputFor(buffered: boolean, cancellations: unknown[]) {
  const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const stream = buffered ? undefined : new ReadableStream<Uint8Array>({ start: ready.resolve, cancel(reason) { cancellations.push(reason); } });
  const input = new Response(stream ?? "<p>x</p><p>late</p>");
  const refs: WeakRef<object>[] = [new WeakRef(input)];
  if (stream) refs.push(new WeakRef(stream));
  if (!buffered) return { input, refs, ready };
  const bytes: unknown = Reflect.get(input, "_body");
  assert.ok(bytes instanceof Uint8Array, "exercise the actual buffered Response path");
  assert.ok(!Reflect.get(input, "_stream"));
  refs.push(new WeakRef(bytes));
  // Observe cancel on the real reader. A materialized body's source is already closed.
  Object.defineProperty(input, "body", { get() {
    const body: unknown = Reflect.get(Response.prototype, "body", input);
    assert.ok(body instanceof ReadableStream);
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const cancel = reader.cancel.bind(reader);
    reader.cancel = reason => { cancellations.push(reason); return cancel(reason); };
    Object.defineProperty(body, "getReader", { value: () => reader });
    refs.push(new WeakRef(body), new WeakRef(reader));
    return body;
  } });
  return { input, refs, ready };
}

async function cancelCase(phase: Phase, buffered: boolean) {
  const baseline = htmlRewriterCount();
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const reason = { marker: `${phase} cancellation` };
  const failure = { marker: "species throws after cancel" };
  const reasons: unknown[] = [];
  const source = inputFor(buffered, reasons);
  const cancellations: Promise<void>[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let settleCustom: () => void = () => {};
  const counts = { calls: 0, ends: 0 };
  const cancel = () => { cancellations.push(reader.cancel(reason)); };
  const then = phase === "custom then" ? (resolve: () => void) => { settleCustom = resolve; cancel(); } : intrinsicThen;
  Object.defineProperty(pending.promise, "then", { get() { if (phase === "then getter") cancel(); return then; } });
  Object.defineProperty(pending.promise, "constructor", { value: { get [Symbol.species]() {
    if (phase === "species getter" || phase === "species throw") cancel();
    if (phase === "species throw") throw failure;
    return Promise;
  } } });
  const response = new HTMLRewriter().on("p", { element() {
    counts.calls++;
    if (phase === "handler") cancel();
    entered.resolve();
    return pending.promise;
  } }).onDocument({ end() { counts.ends++; } }).transform(source.input);
  reader = response.body!.getReader();
  const read = reader.read().then(chunk => ({ kind: "read", chunk }), error => ({ kind: "error", error }));
  if (!buffered) (await source.ready.promise).enqueue(encoder.encode("<p>x</p><p>late</p>"));
  await entered.promise;
  if (phase === "outside") {
    assert.equal(htmlRewriterCount(), baseline + 1, "reachable handler retains a real native session");
    cancel();
  }
  await Promise.all(cancellations);
  const result = await read;
  assert.ok("chunk" in result, "cancellation closes the held read even when species throws");
  assert.equal(result.chunk.done, true);
  assert.deepEqual(reasons, [reason]);
  assert.equal(htmlRewriterCount(), baseline);
  assert.equal(counts.calls, 1);
  assert.equal(counts.ends, 0);
  return { refs: source.refs, pending, reader, response, settleCustom, counts, baseline, reasons, reason };
}

export async function cancellationContracts(contract: (name: string, check: () => Promise<void>) => Promise<void>) {
  const phases: Phase[] = ["outside", "handler", "then getter", "species getter", "custom then", "species throw"];
  for (const phase of phases) await contract(`stream cancellation ${phase}`, () => retainedCancellation(phase, false));
  await contract("buffered Response cancellation", () => retainedCancellation("outside", true));
}

async function retainedCancellation(phase: Phase, buffered: boolean) {
  const retained = await cancelCase(phase, buffered);
  await collect(retained.refs);
  assert.ok(retained.reader && retained.response && retained.pending.promise, "keep output reader and source reachable");
  retained.pending.resolve();
  retained.settleCustom();
  await tick();
  await tick();
  assert.equal((await retained.reader.read()).done, true);
  assert.deepEqual(retained.counts, { calls: 1, ends: 0 }, "no native continuation after close");
  assert.deepEqual(retained.reasons, [retained.reason], "no duplicate source cancellation after settlement");
  assert.equal(htmlRewriterCount(), retained.baseline);
}
