import assert from "node:assert/strict";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import workerThreads, { MessageChannel, Worker } from "node:worker_threads";
import type { MessagePort, WorkerOptions } from "node:worker_threads";
import { checkedDownloadSize, installCliFetch } from "../../scripts/node-install-net.ts";
import type { NodeWasiImports } from "../../scripts/node-process.ts";

const base = process.argv[3];
assert(base, "fixture server URL required");
const AGAIN = -2, ERROR = -1, PACKET_LIMIT = 65536;
const moduleUrl = new URL("../../scripts/node-install-net.ts", import.meta.url);
const encoder = new TextEncoder(), decoder = new TextDecoder();
const milestone = (value: string) => writeSync(1, `${value}\n`);
const metadata = (path: string) => ({ url: `${base}${path}`, method: "GET", headers: [], redirect: "follow", credentialPolicy: "package" });

function host(wake = new Int32Array(new SharedArrayBuffer(4))) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports: NodeWasiImports = { wasi_snapshot_preview1: { sock_send: () => 52 } };
  const instance = { exports: { memory, bun_wasm_host_slots: () => 128 } } as unknown as WebAssembly.Instance;
  const adapter = installCliFetch(imports, () => instance, wake);
  adapter.install();
  const call = (slot: number, a = 0, b = 0, c = 0, d = 0) => {
    const view = new DataView(memory.buffer);
    [slot, a, b, c, d].forEach((value, index) => view.setInt32(index * 4, value, true));
    assert.equal(imports.wasi_snapshot_preview1.sock_send!(0x7fffb0b0, 0, 1, 0, 32), 0);
    return new DataView(memory.buffer).getInt32(32, true);
  };
  const start = (path: string, packagePolicy = true) => {
    const meta = metadata(path);
    const data = encoder.encode(JSON.stringify(packagePolicy ? meta : { ...meta, credentialPolicy: undefined }));
    new Uint8Array(memory.buffer, 256, data.length).set(data);
    return call(1, 256, data.length);
  };
  const wait = (operation: () => number) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const value = operation();
      if (value !== AGAIN) return value;
      call(0, 50);
    }
    throw new Error("slot remained pending at fixture deadline");
  };
  const text = (slot: number, id: number) => {
    new Uint8Array(memory.buffer, 2048, 4096).fill(0xa5);
    const length = wait(() => call(slot, id, 2048, 1));
    assert(length > 1 && length < 4096, `unexpected sized result ${length}`);
    assert.equal(new Uint8Array(memory.buffer)[2048], 0xa5, "short capacity must not copy");
    assert.equal(call(slot, id, 2048, 4096), length);
    const value = decoder.decode(new Uint8Array(memory.buffer, 2048, length));
    assert.equal(call(slot, id, 2048, 4096), length);
    assert.equal(decoder.decode(new Uint8Array(memory.buffer, 2048, length)), value);
    return value;
  };
  const read = (id: number, expected: string) => {
    let actual = "";
    while (actual.length < expected.length) {
      const count = wait(() => call(3, id, 8192, Math.min(2, expected.length - actual.length)));
      assert(count > 0, `body ended or failed at ${actual.length}: ${count}`);
      actual += decoder.decode(new Uint8Array(memory.buffer, 8192, count));
    }
    assert.equal(actual, expected);
  };
  const close = (id: number) => {
    assert.equal(call(5, id), 0);
    for (const slot of [2, 3, 5, 10]) assert.equal(call(slot, id, 8192, 32), -3);
  };
  return { adapter, call, memory, imports, wake, start, wait, text, read, close };
}

type Host = ReturnType<typeof host>;

function head(h: Host, id: number, status: number): void {
  const value: unknown = JSON.parse(h.text(2, id));
  assert(value && typeof value === "object" && "status" in value);
  assert.equal(value.status, status);
}

function completion(h: Host, id: number, expected = 0): void {
  assert.equal(h.wait(() => h.call(3, id, 8192, 32)), expected);
  assert.equal(h.call(3, id, 8192, 32), expected);
}

function progress(h: Host): void {
  const id = h.start("/progress");
  head(h, id, 202);
  const info = JSON.parse(h.text(2, id));
  assert.equal(info.statusText, "Streaming");
  assert.equal(info.url, `${base}/progress`);
  assert.equal(info.redirected, false);
  assert(info.headers.some(([name, value]: [string, string]) => name === "x-audit" && value === "003"));
  milestone("head-before-eof");
  for (const piece of ["first", "second", "third"]) {
    h.read(id, piece);
    assert.equal(h.call(3, id, 8192, 32), AGAIN, "no unread bytes is pending, not EOF");
    milestone(`piece:${piece}`);
  }
  h.read(id, "last");
  completion(h, id);
  h.close(id);
}

function responses(h: Host): void {
  const empty = h.start("/empty");
  head(h, empty, 204); completion(h, empty); h.close(empty);
  const missing = h.start("/missing");
  head(h, missing, 404); h.read(missing, "missing"); completion(h, missing); h.close(missing);
  const redirect = h.start("/redirect", false);
  head(h, redirect, 404);
  const value = JSON.parse(h.text(2, redirect));
  assert.equal(value.redirected, true); assert.equal(value.url, `${base}/missing`);
  h.read(redirect, "missing"); completion(h, redirect); h.close(redirect);
  const broken = h.start("/disconnect");
  assert.equal(h.wait(() => h.call(2, broken, 2048, 4096)), ERROR);
  completion(h, broken, ERROR);
  const error = JSON.parse(h.text(10, broken));
  assert.equal(error.name, "TypeError"); assert(error.message.length > 0); h.close(broken);
  milestone("empty-status-redirect-network-error");
}

function bodyError(h: Host): void {
  const id = h.start("/body-error");
  head(h, id, 200); h.read(id, "ab");
  milestone("break-body");
  // The barrier request proves the parent destroyed the first response socket.
  const barrier = h.start("/empty");
  head(h, barrier, 204); completion(h, barrier); h.close(barrier);
  h.read(id, "cde"); completion(h, id, ERROR);
  assert.equal(JSON.parse(h.text(10, id)).name, "TypeError");
  // A body failure does not remove the already published response metadata.
  head(h, id, 200); h.close(id);
  milestone("buffer-before-body-error");
}

function boundedReads(h: Host): void {
  const receive = workerThreads.receiveMessageOnPort, post = workerThreads.MessagePort.prototype.postMessage;
  let chunks = 0, acknowledgments = 0, id = 0;
  workerThreads.receiveMessageOnPort = port => {
    const received = receive(port);
    const value: unknown = received?.message;
    if (value && typeof value === "object" && "kind" in value && "id" in value && value.kind === "chunk" && value.id === id) chunks++;
    return received;
  };
  Object.defineProperty(workerThreads.MessagePort.prototype, "postMessage", { value: function(this: MessagePort, ...args: unknown[]) {
    const value: unknown = args[0];
    if (value && typeof value === "object" && "kind" in value && "id" in value && value.kind === "ack" && value.id === id) acknowledgments++;
    return Reflect.apply(post, this, args);
  } });
  syncBuiltinESMExports();
  try {
    id = h.start("/large"); head(h, id, 200);
    assert.equal(h.wait(() => h.call(3, id, 8192, 1)), 1);
    assert.equal(new Uint8Array(h.memory.buffer)[8192], 3);
    assert.equal(chunks, 1); assert.equal(acknowledgments, 0);
    const other = h.start("/empty");
    head(h, other, 204); completion(h, other); h.close(other);
    assert.equal(chunks, 1, "partial consumption must not admit a second packet");
    let total = 1;
    while (total < 190000) {
      const count = h.wait(() => h.call(3, id, 8192, 4093));
      assert(count > 0);
      new Uint8Array(h.memory.buffer, 8192, count).forEach((value, offset) => assert.equal(value, ((total + offset) * 17 + 3) % 251));
      total += count;
    }
    completion(h, id); h.close(id);
    assert.equal(acknowledgments, chunks, "exactly one acknowledgment per fully consumed packet");
    milestone(`slot-packets:${JSON.stringify({ total, chunks, acknowledgments })}`);
  } finally {
    workerThreads.receiveMessageOnPort = receive;
    workerThreads.MessagePort.prototype.postMessage = post;
    syncBuiltinESMExports();
  }
}

function growth(h: Host): void {
  const version = Atomics.load(h.wake, 0);
  const id = h.start("/grow");
  head(h, id, 200);
  waitForPublication(h.wake, version + 1);
  h.memory.grow(1);
  h.read(id, "grown"); h.close(id);
  milestone("growth-after-packet");
}

async function cancellation(h: Host): Promise<void> {
  const accepted = once(process, "message");
  const id = h.start("/pending");
  await accepted;
  assert.equal(h.call(2, id, 2048, 4096), AGAIN); h.close(id);
  const partial = h.start("/partial-close");
  head(h, partial, 200); h.read(partial, "a"); h.close(partial);
  const other = h.start("/empty");
  head(h, other, 204); completion(h, other); h.close(other);
  milestone("close-before-head-and-after-partial");
}

async function slots(): Promise<void> {
  const idle = host(); idle.adapter.dispose(); idle.adapter.dispose();
  const h = host();
  try {
    for (const slot of [0, 1, 2, 3, 5, 10]) assert.equal(new DataView(h.memory.buffer).getUint32(128 + 8 + slot * 4, true), 0xffffffff);
    assert.equal(new DataView(h.memory.buffer).getUint32(128 + 8 + 4 * 4, true), 0);
    assert.equal(h.imports.wasi_snapshot_preview1.sock_send!(4, 0, 0, 0, 0), 52);
    new DataView(h.memory.buffer).setInt32(0, 4, true);
    assert.equal(h.imports.wasi_snapshot_preview1.sock_send!(0x7fffb0b0, 0, 0, 0, 32), 52);
    progress(h); responses(h); bodyError(h); boundedReads(h); growth(h); await cancellation(h);
    const active = h.start("/partial-dispose");
    head(h, active, 200); h.read(active, "a"); h.start("/pending-dispose");
    const limit = 256 * 1024 * 1024;
    assert.equal(checkedDownloadSize(limit - 1, 1), limit);
    assert.throws(() => checkedDownloadSize(limit, 1), /Download exceeds 256 MiB limit/);
    milestone("slots-complete");
  } finally { h.adapter.dispose(); h.adapter.dispose(); }
}

function waitForPublication(wake: Int32Array, version: number): void {
  const deadline = Date.now() + 4000;
  while (Atomics.load(wake, 0) <= version) {
    assert(Date.now() < deadline, "worker failed to publish");
    Atomics.wait(wake, 0, Atomics.load(wake, 0), 25);
  }
}

function rawPacket(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null);
  assert("kind" in value && "id" in value);
  return value as Record<string, unknown>;
}

async function protocol(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(moduleUrl, { workerData: { installFetch: true, port: port2, wake }, transferList: [port2] });
  const queue: Record<string, unknown>[] = [];
  port1.on("message", (value: unknown) => queue.push(rawPacket(value)));
  const packet = async () => {
    while (!queue.length) await once(port1, "message");
    const value = queue.shift(); assert(value); return value;
  };
  const request = (id: number, path: string) => port1.postMessage({ kind: "request", id, meta: metadata(path), body: new Uint8Array() });
  let stopping = false;
  worker.on("error", error => port1.emit("error", error));
  worker.on("exit", code => { if (!stopping) port1.emit("error", new Error(`worker exited (${code})`)); });
  try {
    request(1, "/large");
    const first = await packet();
    assert.equal(first.kind, "head"); assert.equal(first.id, 1);
    let current = await packet();
    assert.equal(current.kind, "chunk"); assert.equal(current.id, 1);
    // A completed independent handle is a worker event-loop barrier, not a sleep.
    request(2, "/empty");
    const barrier = [await packet(), await packet()];
    assert.deepEqual(barrier.map(value => [value.kind, value.id]), [["head", 2], ["end", 2]]);
    assert.equal(queue.length, 0, "no second chunk or end before acknowledgment");
    let total = 0, acknowledgments = 0, maximum = 0;
    while (current.kind === "chunk") {
      assert.equal(current.id, 1);
      const body = current.body;
      assert(body instanceof Uint8Array && body.length > 0 && body.length <= PACKET_LIMIT);
      assert.equal(body.byteOffset, 0); assert.equal(body.buffer.byteLength, body.length);
      body.forEach((value, index) => assert.equal(value, ((total + index) * 17 + 3) % 251));
      total += body.length; maximum = Math.max(maximum, body.buffer.byteLength);
      port1.postMessage({ kind: "ack", id: 1 }); acknowledgments++;
      current = await packet();
    }
    assert.deepEqual(current, { kind: "end", id: 1 }); assert.equal(total, 190000);
    request(3, "/held-large");
    assert.equal((await packet()).kind, "head"); assert.equal((await packet()).kind, "chunk");
    port1.postMessage({ kind: "close", id: 3 });
    request(4, "/empty");
    const afterClose = [await packet(), await packet()];
    assert.deepEqual(afterClose.map(value => [value.kind, value.id]), [["head", 4], ["end", 4]]);
    assert.equal(queue.length, 0, "closed acknowledgment wait must not send end or error");
    milestone(`protocol:${JSON.stringify({ total, maximum, acknowledgments, unacknowledgedPackets: 1 })}`);
  } finally { stopping = true; port1.close(); await worker.terminate(); }
}

function race(stage: string): void {
  const wake = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(wake, 0, 41);
  const h = host(wake);
  const receive = workerThreads.receiveMessageOnPort, load = Atomics.load, wait = Atomics.wait;
  let released = false, waits = 0;
  const release = () => {
    if (released) return;
    released = true;
    const version = load(wake, 0);
    milestone(`race-release:${stage}`);
    const deadline = Date.now() + 4000;
    while (load(wake, 0) === version) {
      assert(Date.now() < deadline, `race ${stage} publication timed out`);
      wait(wake, 0, version, 25);
    }
  };
  const releaseDuringWait = () => {
    if (stage !== "in-wait" || released) return;
    released = true;
    milestone(`race-release:${stage}`);
  };
  try {
    assert.equal(h.call(0, 0), 0); assert.equal(load(wake, 0), 41);
    const id = h.start(`/race-${stage}`);
    if (stage === "queued") release();
    workerThreads.receiveMessageOnPort = port => {
      const result = receive(port);
      if (stage === "before-load" && !result) release();
      return result;
    };
    syncBuiltinESMExports();
    Object.defineProperty(Atomics, "load", { value: (array: Int32Array, index: number) => {
      const version = load(array, index);
      if (stage === "after-load") release();
      return version;
    } });
    Object.defineProperty(Atomics, "wait", { value: (array: Int32Array, index: number, version: number, timeout?: number) => {
      waits++;
      if (stage === "before-wait") release();
      releaseDuringWait();
      return wait(array, index, version, timeout);
    } });
    assert.equal(h.call(0, 4000), 1, `lost ${stage} reply`);
    assert(released); assert(load(wake, 0) > 41);
    if (["before-wait", "in-wait"].includes(stage)) assert.equal(waits, 1);
    else assert.equal(waits, 0);
    head(h, id, 204); completion(h, id); h.close(id);
    milestone(`race-passed:${stage}`);
  } finally {
    workerThreads.receiveMessageOnPort = receive; syncBuiltinESMExports();
    Object.defineProperty(Atomics, "load", { value: load }); Object.defineProperty(Atomics, "wait", { value: wait });
    h.adapter.dispose();
  }
}

function injectedWorkerEntry(filename: string | URL, mode: string): string | URL {
  const entry = mode === "exit" ? "process.exit(7)" : mode === "async" ? 'setImmediate(() => { throw new Error("injected worker callback failure"); })' : 'throw new Error("injected worker startup failure")';
  const url = `data:text/javascript,${encodeURIComponent(entry)}`;
  if (typeof filename !== "string") return new URL(url);
  const replaced = filename.replace(JSON.stringify(moduleUrl.href), JSON.stringify(url));
  assert.notEqual(replaced, filename, "fault must replace only the actual worker entry, not its observer");
  return replaced;
}

async function synchronousWorkerFailure(mode: string): Promise<void> {
  const Original = workerThreads.Worker;
  const workers: Worker[] = [];
  workerThreads.Worker = class extends Original {
    constructor(filename: string | URL, options?: WorkerOptions) {
      super(injectedWorkerEntry(filename, mode), options);
      workers.push(this);
    }
  };
  syncBuiltinESMExports();
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const h = host(wake);
  let yielded = false;
  void Promise.resolve().then(() => { yielded = true; });
  try {
    const id = h.start("/pending-worker-failure");
    const result = h.wait(() => h.call(2, id, 2048, 4096));
    assert.equal(yielded, false, "consumer must not yield before failure is visible");
    assert.equal(result, ERROR);
    assert(Atomics.load(wake, 0) > 0, "worker must notify the shared wake before the consumer yields");
    completion(h, id, ERROR);
    const error = JSON.parse(h.text(10, id));
    assert.equal(error.name, "TypeError");
    assert.match(error.message, mode === "exit" ? /CLI fetch worker exited \(7\)/ : /injected worker .* failure/);
    h.close(id);
    const later = h.start("/pending-after-worker-failure");
    assert.equal(h.call(2, later, 2048, 4096), ERROR, "future handles must retain the failure without retrying the worker");
    h.close(later);
    milestone(`worker-failure-sync:${mode}`);
  } finally {
    h.adapter.dispose();
    workerThreads.Worker = Original;
    syncBuiltinESMExports();
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

async function workerFailures(): Promise<void> {
  for (const mode of ["startup", "async", "exit"]) await synchronousWorkerFailure(mode);
}

async function workerExit(): Promise<void> {
  const Original = workerThreads.Worker;
  const workers: Worker[] = [];
  workerThreads.Worker = class extends Original {
    constructor(filename: string | URL, options?: WorkerOptions) { super(filename, options); workers.push(this); }
  };
  syncBuiltinESMExports();
  const h = host();
  try {
    const id = h.start("/pending-worker-exit");
    assert.equal(workers.length, 1);
    const worker = workers[0]; assert(worker);
    await once(worker, "online");
    await worker.terminate();
    assert.equal(h.call(2, id, 2048, 4096), ERROR);
    completion(h, id, ERROR);
    assert.match(JSON.parse(h.text(10, id)).message, /CLI fetch worker exited/);
    h.close(id);
    milestone("worker-exit-reported");
  } finally {
    h.adapter.dispose();
    workerThreads.Worker = Original; syncBuiltinESMExports();
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

try {
  switch (process.argv[2]) {
    case "slots": await slots(); break;
    case "protocol": await protocol(); break;
    case "races": for (const stage of ["queued", "before-load", "after-load", "before-wait", "in-wait"]) race(stage); break;
    case "worker-exit": await workerExit(); break;
    case "worker-failures": await workerFailures(); break;
    default: throw new Error("unknown fixture mode");
  }
  milestone(`passed:${process.argv[2]}:${process.version}`);
} finally { process.disconnect?.(); }
