import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as nativeConsumers from "node:stream/consumers";
import { sourceRuntime, type Consumers } from "./stream-consumers-runtime.ts";

type Constructors = { Readable: typeof Readable; ReadableStream: typeof ReadableStream };
type CommonConsumers = Omit<Consumers, "bytes"> & { bytes?: Consumers["bytes"] };

async function* failingInput(reason: Error, finalizer: () => void) {
  try { yield Uint8Array.of(65); throw reason; }
  finally { finalizer(); }
}

async function* invalidInput(finalizer: () => void) {
  try { yield 42; yield "unreachable"; }
  finally { finalizer(); }
}

export async function consumptionControls(consumers: CommonConsumers, constructors: Constructors, nativeBun = false) {
  const rows: string[] = [];
  const { Readable: NodeReadable, ReadableStream: WebReadable } = constructors;
  const inputs: [string, (chunks: unknown[]) => unknown][] = [
    ["async iterable", async function* (chunks) { yield* chunks; }],
    ["sync iterable", chunks => chunks],
    ["Node readable", chunks => NodeReadable.from(chunks)],
    ["web readable", chunks => new WebReadable({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } })],
  ];
  const encoded = new TextEncoder().encode('\uFEFF{"value":"€😀"}');
  for (const [name, input] of inputs) {
    const chunks = Array.from(encoded, byte => Uint8Array.of(byte));
    assert.equal(await consumers.text(input(chunks)), '{"value":"€😀"}');
    assert.equal(JSON.stringify(await consumers.json(input(chunks))), '{"value":"€😀"}');
    assert.equal(await consumers.text(input([Uint8Array.of(0xe2, 0x82)])), "�");
    const mixed = await consumers.text(input([Uint8Array.of(0xe2), "x", Uint8Array.of(0x82, 0xac)]));
    assert.equal(mixed, nativeBun && name === "web readable" ? "�x��" : "x€");
    rows.push(`${name}: mixed string and split UTF-8 = ${mixed}`);
    assert.equal(await consumers.text(input([])), "");
    const view = Uint8Array.of(99, 65, 66, 99).subarray(1, 3);
    const bytes = new Uint8Array(await consumers.arrayBuffer(input([view, "C"])));
    assert.deepEqual(Array.from(bytes), [65, 66, 67]);
    view.fill(88);
    assert.deepEqual(Array.from(bytes), [65, 66, 67]);
    const buffer = await consumers.buffer(input([Uint8Array.of(65), "B"]));
    assert.equal(Object.getPrototypeOf(buffer).constructor.name, "Buffer");
    assert.deepEqual(Array.from(buffer), [65, 66]);
    const blob = await consumers.blob(input([Uint8Array.of(65), "B"]));
    assert.equal(blob.size, 2);
    assert.equal(blob.type, "");
    assert.equal(await blob.text(), "AB");
    assert.equal((await consumers.blob(input([]))).size, 0);
    await assert.rejects(consumers.json(input(["{invalid"])), { name: "SyntaxError" });
    rows.push(`${name}: outputs, UTF-8 boundaries, copies, empty and malformed JSON`);
  }
  const methods: [string, (stream: unknown) => Promise<unknown>][] = [
    ["blob", consumers.blob], ["arrayBuffer", consumers.arrayBuffer], ["buffer", consumers.buffer],
    ["text", consumers.text], ["json", consumers.json],
  ];
  if (consumers.bytes) methods.push(["bytes", consumers.bytes]);
  for (const [name, consume] of methods) {
    const reason = new Error(`${name} source failure`);
    let finalized = false;
    const failing = () => failingInput(reason, () => { finalized = true; });
    await assert.rejects(consume(failing()), error => error === reason);
    assert.equal(finalized, true);
    const node = NodeReadable.from(failing());
    await assert.rejects(consume(node), error => error === reason);
    assert.equal(node.destroyed, true);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const web = new WebReadable<Uint8Array>({ start(value) { controller = value; } });
    const promise = consume(web);
    controller?.enqueue(Uint8Array.of(65));
    await Promise.resolve();
    controller?.error(reason);
    await assert.rejects(promise, error => error === reason);
    assert.equal(web.locked, false);
    rows.push(`${name}: original source errors and iterator/reader cleanup`);
  }
  for (const consume of [consumers.text, consumers.json]) {
    let returned = false;
    const invalid = () => invalidInput(() => { returned = true; });
    await assert.rejects(consume(invalid()), { name: "TypeError" });
    assert.equal(returned, true);
    const node = NodeReadable.from(invalid());
    await assert.rejects(consume(node), { name: "TypeError" });
    assert.equal(node.destroyed, true);
    const cancellations: unknown[] = [];
    let controller: ReadableStreamDefaultController<unknown> | undefined;
    const web = new WebReadable({
      start(value) { controller = value; value.enqueue(42); },
      cancel(reason) { cancellations.push(reason); },
    });
    const result = consume(web);
    if (nativeBun) {
      const reason = new Error("stop Bun native web collection");
      controller?.error(reason);
      await assert.rejects(result, error => error === reason);
      assert.deepEqual(cancellations, []);
    } else {
      await assert.rejects(result, { name: "TypeError" });
      assert.deepEqual(cancellations, [undefined]);
    }
    assert.equal(web.locked, false);
  }
  rows.push(`text/json: invalid chunks close iterators and destroy Node streams; web ${nativeBun ? "collects until source error" : "cancels on invalid chunk"}`);
  const locked = new WebReadable({ start(controller) { controller.close(); } });
  const reader = locked.getReader();
  await assert.rejects(consumers.text(locked), { name: "TypeError" });
  assert.equal(locked.locked, true);
  reader.releaseLock();
  rows.push("locked web stream rejects without taking the existing lock");
  let close: (() => void) | undefined;
  const open = new WebReadable({ start(controller) { controller.enqueue(Uint8Array.of(65)); close = () => controller.close(); } });
  let settled = false;
  const pending = consumers.text(open).then(value => { settled = true; return value; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  close?.();
  assert.equal(await pending, "A");
  assert.equal(open.locked, false);
  rows.push("partial web stream waits for close and releases its reader");
  if (consumers.bytes) {
    assert.deepEqual(Array.from(await consumers.bytes([Uint8Array.of(65), "B"])), [65, 66]);
    rows.push("bytes export returns Uint8Array");
  }
  return rows;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "native") {
    console.log(JSON.stringify(await consumptionControls(nativeConsumers, { Readable, ReadableStream }, Boolean(process.versions.bun))));
  } else if (mode === "source") {
    const scratch = process.argv[3] ?? mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-stream-consumers-oracle-"));
    try {
      const source = sourceRuntime(scratch);
      console.log(JSON.stringify(await source.run(() => consumptionControls(source.consumers(), source.constructors()))));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  } else throw new Error("Expected native or source");
}
