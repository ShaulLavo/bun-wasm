import { Readable, Writable, Duplex, finished, addAbortSignal, pipeline, compose } from "node:stream";
import { finished as finishedPromise, pipeline as pipelinePromise } from "node:stream/promises";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const check = (value, message) => { if (!value) throw new Error(message); };
async function rejects(promise, expected) {
  let error;
  try { await promise; } catch (failure) { error = failure; }
  check(error && (typeof expected === "function" ? expected(error) : error === expected), "wrong rejection: " + error);
  return error;
}
const results = [];
async function test(name, run) {
  let timer;
  try {
    await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("case deadline")), 2500); })]);
    results.push({ name, pass: true });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, pass: false, error: String(error) });
    console.log("FAIL " + name + " " + error);
  } finally { clearTimeout(timer); }
}

await test("readable finished callback preserves unlocked state", async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  let calls = 0;
  const done = new Promise((resolve, reject) => finished(stream, error => { calls++; error ? reject(error) : resolve(); }));
  check(!stream.locked, "finished locked readable");
  controller.close();
  await done;
  await tick();
  check(calls === 1 && !stream.locked, "wrong close notification");
});
await test("writable finished promise preserves unlocked state", async () => {
  const stream = new WritableStream();
  const done = finishedPromise(stream);
  check(!stream.locked, "finished locked writable");
  const writer = stream.getWriter();
  await writer.close();
  await done;
  writer.releaseLock();
});
await test("readable original error", async () => {
  let controller;
  const original = new Error("source error");
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const done = rejects(finishedPromise(stream), original);
  controller.error(original);
  await done;
  check(!stream.locked, "error observation locked readable");
});
await test("writable waits for pending write on error", async () => {
  let controller, complete;
  const original = new Error("sink error");
  const stream = new WritableStream({ start(value) { controller = value; }, write() { return new Promise(resolve => { complete = resolve; }); } });
  const writer = stream.getWriter();
  writer.closed.catch(() => {});
  const writing = writer.write("x");
  let settled = false;
  const done = rejects(finishedPromise(stream), original).then(() => { settled = true; });
  await tick();
  controller.error(original);
  await tick();
  check(!settled, "finished before pending write");
  complete();
  await writing;
  await done;
  writer.releaseLock();
});
await test("reader release is not completion and queued close drains", async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const first = stream.getReader();
  let settled = false;
  const done = finishedPromise(stream).then(() => { settled = true; });
  first.releaseLock();
  controller.enqueue("x");
  controller.close();
  await tick();
  check(!settled && !stream.locked, "closed before queue drained");
  const reader = stream.getReader();
  check((await reader.read()).value === "x", "lost queued value");
  check((await reader.read()).done, "missing EOF");
  await done;
  reader.releaseLock();
});
await test("BYOB completion and storage", async () => {
  const stream = new ReadableStream({ type: "bytes", start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } });
  const done = finishedPromise(stream);
  check(!stream.locked, "finished locked bytes");
  const reader = stream.getReader({ mode: "byob" });
  const value = await reader.read(new Uint8Array(4));
  check(value.value.length === 2 && value.value[1] === 2, "bad BYOB data");
  await done;
  reader.releaseLock();
});
await test("abort readable rejects reader and finished", async () => {
  const signal = new AbortController();
  const cause = new Error("read abort");
  const stream = addAbortSignal(signal.signal, new ReadableStream());
  check(!stream.locked, "abort registration locked readable");
  const done = rejects(finishedPromise(stream), error => error.code === "ABORT_ERR" && error.cause === cause);
  const reader = stream.getReader();
  reader.closed.catch(() => {});
  signal.abort(cause);
  await rejects(reader.read(), error => error.code === "ABORT_ERR");
  await done;
  reader.releaseLock();
});
await test("abort writable waits for pending write", async () => {
  const signal = new AbortController();
  let complete;
  const stream = addAbortSignal(signal.signal, new WritableStream({ write() { return new Promise(resolve => { complete = resolve; }); } }));
  const writer = stream.getWriter();
  writer.closed.catch(() => {});
  const writing = writer.write("x");
  let settled = false;
  const done = rejects(finishedPromise(stream), error => error.code === "ABORT_ERR").then(() => { settled = true; });
  await tick();
  signal.abort("write abort");
  await tick();
  check(!settled, "abort finished before write");
  complete();
  await writing;
  await done;
  writer.releaseLock();
});
await test("transform native completion", async () => {
  const stream = new TransformStream({ transform(value, controller) { controller.enqueue(value + "!"); } });
  const done = Promise.all([finishedPromise(stream.readable), finishedPromise(stream.writable)]);
  check(!stream.readable.locked && !stream.writable.locked, "transform completion retained lock");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = writer.write("x");
  check((await reader.read()).value === "x!", "bad transform data");
  await writing;
  await writer.close();
  check((await reader.read()).done, "transform missing EOF");
  await done;
  reader.releaseLock(); writer.releaseLock();
});
await test("transform abort readable", async () => {
  const signal = new AbortController();
  const stream = new TransformStream();
  addAbortSignal(signal.signal, stream.readable);
  const done = rejects(finishedPromise(stream.readable), error => error.code === "ABORT_ERR");
  const reader = stream.readable.getReader();
  reader.closed.catch(() => {});
  signal.abort("transform abort");
  await rejects(reader.read(), error => error.code === "ABORT_ERR");
  await done;
  reader.releaseLock();
  await stream.writable.abort().catch(() => {});
});
await test("adapter readable completion", async () => {
  const stream = Readable.toWeb(Readable.from(["x"]));
  const done = finishedPromise(stream);
  check(!stream.locked, "adapter finished retained lock");
  const reader = stream.getReader();
  check((await reader.read()).value === "x", "bad adapter data");
  check((await reader.read()).done, "adapter missing EOF");
  await done;
  reader.releaseLock();
});
await test("adapter writable waits for final", async () => {
  let complete;
  const node = new Writable({ write(chunk, encoding, callback) { callback(); }, final(callback) { complete = callback; } });
  const stream = Writable.toWeb(node);
  const writer = stream.getWriter();
  let settled = false;
  const done = finishedPromise(stream).then(() => { settled = true; });
  await writer.write("x");
  const closing = writer.close();
  await tick();
  check(!settled, "adapter finished before final");
  complete();
  await closing; await done;
  writer.releaseLock();
});
await test("pipeline native streams and completion", async () => {
  const input = new ReadableStream({ start(controller) { controller.enqueue("x"); controller.close(); } });
  const transform = new TransformStream({ transform(value, controller) { controller.enqueue(value.toString().toUpperCase()); } });
  const chunks = [];
  const output = new WritableStream({ write(value) { chunks.push(value); } });
  const done = Promise.all([finishedPromise(input), finishedPromise(transform.readable), finishedPromise(transform.writable), finishedPromise(output)]);
  await pipelinePromise(input, transform, output);
  await done;
  check(chunks.join("") === "X", "pipeline lost data");
});
await test("pipeline original failure and abort propagation", async () => {
  const original = new Error("transform failure");
  let aborted;
  const input = new ReadableStream({ start(controller) { controller.enqueue("x"); controller.close(); } });
  const transform = new TransformStream({ transform() { throw original; } });
  const output = new WritableStream({ abort(error) { aborted = error; } });
  await rejects(pipelinePromise(input, transform, output), original);
  check(aborted === original, "pipeline lost failure reason");
});
await test("native pipeTo abort propagation and completion", async () => {
  const signal = new AbortController();
  const original = new Error("pipe abort");
  let cancelled, aborted;
  const input = new ReadableStream({ cancel(reason) { cancelled = reason; } });
  const output = new WritableStream({ abort(reason) { aborted = reason; } });
  const inputDone = finishedPromise(input);
  const outputDone = rejects(finishedPromise(output), original);
  const piping = rejects(input.pipeTo(output, { signal: signal.signal }), original);
  signal.abort(original);
  await piping; await inputDone; await outputDone;
  check(cancelled === original && aborted === original, "pipeTo lost abort reason");
  check(!input.locked && !output.locked, "pipeTo retained locks");
});
await test("native transform original failure", async () => {
  const original = new Error("native transform failure");
  const stream = new TransformStream({ transform() { throw original; } });
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  reader.closed.catch(() => {}); writer.closed.catch(() => {});
  const done = Promise.all([rejects(finishedPromise(stream.readable), original), rejects(finishedPromise(stream.writable), original)]);
  const reading = rejects(reader.read(), original);
  await rejects(writer.write("x"), original);
  await reading; await done;
  reader.releaseLock(); writer.releaseLock();
});
await test("compose native transforms", async () => {
  const first = new TransformStream({ transform(value, controller) { controller.enqueue(value.toString().toUpperCase()); } });
  const last = new TransformStream({ transform(value, controller) { controller.enqueue(value + "!"); } });
  const done = Promise.all([finishedPromise(first.readable), finishedPromise(first.writable), finishedPromise(last.readable), finishedPromise(last.writable)]);
  const duplex = compose(first, last);
  duplex.end("x");
  let output = "";
  for await (const value of duplex) output += value.toString();
  await done;
  check(output === "X!", "compose lost data");
});
await test("already completed native streams", async () => {
  const readable = new ReadableStream({ start(controller) { controller.close(); } });
  const writable = new WritableStream();
  const writer = writable.getWriter();
  await writer.close(); writer.releaseLock();
  await Promise.all([finishedPromise(readable), finishedPromise(writable)]);
  check(!readable.locked && !writable.locked, "closed observation retained locks");
});
globalThis.__nativeStreamResults = results;
if (results.some(result => !result.pass)) throw new Error("Native stream interop regressions failed");
