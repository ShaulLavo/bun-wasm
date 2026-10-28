import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

// The portable engines' ReadableStream (generated streams_polyfill.js) with the
// generated `direct_stream` runtime module, as internal.require wires them in bun.wasm.
const root = resolve(import.meta.dir, "..");
const js = join(root, "crates/bunwasm-runtime/src/js");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "bun-wasm-direct-stream-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function load(): { ReadableStream: typeof ReadableStream } {
  const emitted = join(scratch, "direct_stream.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/generate-direct-stream.ts"), join(root, "web/src/native-direct-stream.ts"), emitted]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const context = { queueMicrotask, TextEncoder, Uint8Array, ArrayBuffer, TypeError, RangeError, Promise, Reflect, Proxy, Number };
  const direct = runInNewContext(readFileSync(emitted, "utf8"), context)();
  const internal = { require: (name: string) => {
    if (name !== "direct_stream") throw new Error(`unexpected module ${name}`);
    return direct;
  } };
  return runInNewContext(readFileSync(join(js, "streams_polyfill.js"), "utf8"), context)(internal);
}
const { ReadableStream: Portable } = load();

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const parts: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(new Uint8Array(parts));
    parts.push(...value);
  }
}

test("a React-shaped synchronous producer writes, flushes and ends", async () => {
  const written: unknown[] = [];
  const stream = new Portable({
    type: "direct",
    pull(controller: { write(chunk: unknown): unknown; flush?(): unknown; end(): void }) {
      written.push(controller.write("<html>é"), controller.write(new TextEncoder().encode("</html>")));
      controller.flush?.();
      controller.end();
    },
  } as unknown as UnderlyingDefaultSource, { highWaterMark: 2048 });
  expect(stream).toBeInstanceOf(Portable);
  expect(stream.constructor).toBe(Portable);
  expect(await collect(stream)).toBe("<html>é</html>");
  expect(written).toEqual([8, 7]);
});

test("writes past the watermark return a pressure promise settled on delivery", async () => {
  let pressure: unknown;
  const stream = new Portable({
    type: "direct",
    async pull(controller: { write(chunk: unknown): unknown; end(): void }) {
      expect(controller.write("ab")).toBe(2);
      pressure = controller.write("cdef");
      expect(pressure).toBeInstanceOf(Promise);
      expect(await pressure).toBe(4);
      controller.write("g");
      controller.end();
    },
  } as unknown as UnderlyingDefaultSource, { highWaterMark: 4 });
  expect(await collect(stream)).toBe("abcdefg");
});

test("cancel and producer errors keep their reason identity", async () => {
  const reason = new Error("stop");
  let cancelled: unknown;
  const open = new Portable({ type: "direct", pull() {}, cancel(value: unknown) { cancelled = value; } } as unknown as UnderlyingDefaultSource);
  const reader = open.getReader();
  void reader.read();
  await reader.cancel(reason);
  expect(cancelled).toBe(reason);

  const failure = new Error("render failed");
  const failing = new Portable({ type: "direct", pull(controller: { error(error: unknown): void }) { controller.error(failure); } } as unknown as UnderlyingDefaultSource);
  await expect(failing.getReader().read()).rejects.toBe(failure);
  const thrown = new Portable({ type: "direct", pull() { throw failure; } } as unknown as UnderlyingDefaultSource);
  await expect(thrown.getReader().read()).rejects.toBe(failure);
});

test("other stream types keep the polyfill's conversion", () => {
  expect(() => new Portable({ type: "other" } as unknown as UnderlyingDefaultSource)).toThrow("First parameter has member 'type' that 'other' is not a valid enumeration value for ReadableStreamType");
  expect(() => new Portable({ type: "direct" } as unknown as UnderlyingDefaultSource, { highWaterMark: -1 })).toThrow(RangeError);
  expect(new Portable({ type: "bytes" })).toBeInstanceOf(Portable);
  expect(new Portable({ start(controller) { controller.close(); } })).toBeInstanceOf(Portable);
});

type Sink = { write(chunk: unknown): unknown; end(): void };
const settle = (promise: Promise<unknown>) => promise.then(() => "fulfilled", (reason: unknown) => reason);

test("a throwing source cancel rejects the cancel promise with the exact value", async () => {
  for (const thrown of [{ exact: "failure" }, false]) {
    const stream = new Portable({ type: "direct", pull() {}, cancel() { throw thrown; } } as unknown as UnderlyingDefaultSource);
    let result: Promise<void> | undefined;
    expect(() => { result = stream.getReader().cancel("requested"); }).not.toThrow();
    expect(await settle(result!)).toBe(thrown);
  }
});

test("a thenable pull result resumes queued reads after it settles", async () => {
  let pulls = 0;
  let thenReads = 0;
  const stream = new Portable({
    type: "direct",
    pull(controller: Sink) {
      controller.write(String(++pulls));
      if (pulls === 2) controller.end();
      return { get then() { thenReads++; return (resolve: () => void) => queueMicrotask(resolve); } };
    },
  } as unknown as UnderlyingDefaultSource);
  const reader = stream.getReader();
  const values = await Promise.all([reader.read(), reader.read(), reader.read()]);
  expect(values.map(value => value.done ? "done" : new TextDecoder().decode(value.value))).toEqual(["1", "2", "done"]);
  expect([pulls, thenReads]).toEqual([2, 2]);

  const rejected = new Portable({ type: "direct", pull() { return { then(_: unknown, reject: (reason: unknown) => void) { reject(false); } }; } } as unknown as UnderlyingDefaultSource);
  expect(await settle(rejected.getReader().read())).toBe(false);
});

test("a synchronous producer without output is not pulled again", async () => {
  for (const returned of [undefined, {}]) {
    let pulls = 0;
    const stream = new Portable({ type: "direct", pull() { pulls++; return returned; } } as unknown as UnderlyingDefaultSource);
    const reader = stream.getReader();
    void reader.read();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(pulls).toBe(1);
    await reader.cancel();
  }
});
