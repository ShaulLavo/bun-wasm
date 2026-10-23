import { strict as assert } from "node:assert";
import { htmlRewriterCount } from "bun:internal-for-testing";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
const encoder = new TextEncoder();
const baseline = htmlRewriterCount();

async function collected(check: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    await tick();
    Bun.gc(true);
    await tick();
    if (check()) return;
  }
  assert.ok(check(), "parked HTML rewrite state must be released");
}

async function never() { await new Promise<void>(() => {}); }

type Outcome = { message?: string; promise?: WeakRef<object> };
function handlerFor(outcome: Outcome) {
  return { element() {
    const pending = never();
    outcome.promise = new WeakRef(pending);
    return pending;
  } };
}

function abandoned(streamed: boolean) {
  const outcome: Outcome = {};
  const handler = handlerFor(outcome);
  const input = streamed ? new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode("<p>x</p>"));
    controller.close();
  } }) : "<p>x</p>";
  const reader = new HTMLRewriter().on("p", handler).transform(new Response(input)).body!.getReader();
  void reader.read().then(() => { outcome.message = "resolved"; }, error => { outcome.message = String(error); });
  return { reader, outcome, handler: new WeakRef(handler) };
}

const parked = Array.from({ length: 8 }, (_, index) => abandoned(index % 2 === 1));
await collected(() => parked.every(item => item.outcome.message !== undefined));
assert.ok(parked.every(item => item.outcome.message?.includes("will never settle")));
await collected(() => htmlRewriterCount() === baseline && parked.every(item => item.handler.deref() === undefined));
assert.ok(parked.every(item => item.outcome.promise?.deref() === undefined));
console.log("unreachable handler promises reject held reads and release native sessions");

async function cancelled(inside: boolean) {
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const reason = { marker: "cancelled rewrite" };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellation: Promise<void> | undefined;
  let cancelledWith: unknown;
  const input = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel(value) { cancelledWith = value; } });
  const response = new HTMLRewriter().on("p", { element() {
    if (inside) cancellation = reader.cancel(reason);
    entered.resolve();
    return pending.promise;
  } }).transform(new Response(input));
  const reader = response.body!.getReader();
  const read = reader.read();
  controller.enqueue(encoder.encode("<p>x</p>"));
  await entered.promise;
  if (!inside) cancellation = reader.cancel(reason);
  await cancellation;
  assert.equal(cancelledWith, reason);
  assert.equal((await read).done, true);
  assert.equal(htmlRewriterCount(), baseline);
  return { response, reader, pending, input: new WeakRef(input) };
}

const cancellations = [await cancelled(true), await cancelled(false)];
await collected(() => cancellations.every(item => item.input.deref() === undefined));
for (const item of cancellations) item.pending.resolve();
console.log("cancellation releases parked input streams before handler settlement");

const failure = { marker: "handler rejection" };
await assert.rejects(new HTMLRewriter().on("p", { async element() { await tick(); throw failure; } }).transform(new Response("<p>x</p>")).text(), error => error === failure);
const reachable = Promise.withResolvers<void>();
const response = new HTMLRewriter().on("p", { element: () => reachable.promise }).transform(new Response("<p>reachable</p>"));
await collected(() => htmlRewriterCount() === baseline + 1);
reachable.resolve();
assert.equal(await response.text(), "<p>reachable</p>");
assert.equal(htmlRewriterCount(), baseline);
console.log("reachable promises and exact asynchronous rejection values are preserved");
