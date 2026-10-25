import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { WorkerCodec, WorkerCodecHooks, WorkerErrorData } from "./worker-error-data-types";

const context = {
  ArrayBuffer, BigInt64Array, BigUint64Array, Blob, Boolean, Buffer, DataView, Date, DOMException,
  Error, Event, EventTarget, Float32Array, Float64Array, Int16Array, Int32Array, Map,
  MessageEvent, Number, RangeError, RegExp, Set, String, SyntaxError, TypeError, URL,
  Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, WebAssembly, structuredClone,
};
const native = {
  base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
  base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
  transferArrayBuffers() {},
};
const workerSource = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.workerFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/worker_threads.ts", import.meta.url), "utf8")}`);
const codecSource = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.codecFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/worker_codec.ts", import.meta.url), "utf8")}`);

type CodecRuntime = { create(hooks: WorkerCodecHooks): WorkerCodec };
type CodecFactory = (internal: { native: typeof native; require: (name: string) => unknown }) => CodecRuntime;
type WorkerInternal = {
  native: typeof native;
  realTimers: { setImmediate(): void };
  require(name: string): unknown;
  addIoWaiter(): void;
  messagePortRefs: number;
  workerErrorData?: (error: unknown) => WorkerErrorData;
};

function isCodecFactory(value: unknown): value is CodecFactory {
  return typeof value === "function";
}

function isCodecRuntime(value: unknown): value is CodecRuntime {
  return typeof value === "object" && value !== null && "create" in value && typeof value.create === "function";
}

function isWorkerFactory(value: unknown): value is (internal: WorkerInternal) => unknown {
  return typeof value === "function";
}

function workerErrorData() {
  const codecFactoryValue = runInNewContext(codecSource, context);
  if (!isCodecFactory(codecFactoryValue)) throw new Error("Codec factory was not emitted");
  let implementation: WorkerCodec | undefined;
  const modules: Record<string, unknown> = {
    process: { env: {}, execArgv: [], execPath: "bun", cwd: () => "/" },
    events: EventEmitter,
    structured_clone: { structuredClone },
    worker_codec: {
      create(hooks: WorkerCodecHooks) {
        const codecRuntime = codecFactoryValue({ native, require: internal.require });
        if (!isCodecRuntime(codecRuntime)) throw new Error("Codec runtime was not created");
        implementation = codecRuntime.create(hooks);
        return implementation;
      },
    },
    net: {},
  };
  const internal: WorkerInternal = {
    native,
    realTimers: { setImmediate() {} },
    require(name: string) {
      if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
      return modules[name];
    },
    addIoWaiter() {},
    messagePortRefs: 0,
  };
  const workerFactoryValue = runInNewContext(workerSource, context);
  if (!isWorkerFactory(workerFactoryValue)) throw new Error("Worker factory was not emitted");
  workerFactoryValue(internal);
  if (!implementation || typeof internal.workerErrorData !== "function") throw new Error("Worker error data hook was not installed");
  return { encode: internal.workerErrorData, codec: implementation };
}

test("uncloneable worker error uses the fallback error code as sideband data", () => {
  const { encode, codec } = workerErrorData();
  const original = Object.assign(new Error("original"), { cause: () => undefined });
  const frame = encode(original);
  expect(frame.code).toBe("ERR_WORKER_UNSERIALIZABLE_ERROR");
  const decoded = codec.decode(frame.graph);
  expect(decoded).toBeInstanceOf(Error);
  if (!(decoded instanceof Error)) throw new Error("Expected an Error graph");
  expect(decoded.message).toBe("Cannot serialize worker error");
});

test("serializable worker error preserves its ordinary code sideband", () => {
  const { encode, codec } = workerErrorData();
  const original = Object.assign(new TypeError("ordinary"), { code: "ERR_SYNTHETIC" });
  const frame = encode(original);
  expect(frame.code).toBe("ERR_SYNTHETIC");
  const decoded = codec.decode(frame.graph);
  expect(decoded).toBeInstanceOf(TypeError);
  if (!(decoded instanceof Error)) throw new Error("Expected an Error graph");
  expect(decoded.message).toBe("ordinary");
});


test("non-string and throwing error codes are omitted from the sideband", () => {
  const { encode } = workerErrorData();
  const numeric = Object.assign(new Error("numeric"), { code: 1n });
  expect(encode(numeric).code).toBeUndefined();
  const throwing = new Error("throwing");
  Object.defineProperty(throwing, "code", { configurable: true, get() { throw new Error("code getter"); } });
  expect(() => encode(throwing)).not.toThrow();
  expect(encode(throwing).code).toBeUndefined();
});

test("malformed error fields use the unserializable worker fallback", () => {
  const { encode, codec } = workerErrorData();
  const original = new Error("malformed");
  Object.defineProperty(original, "message", { configurable: true, value: 42 });
  const frame = encode(original);
  expect(frame.code).toBe("ERR_WORKER_UNSERIALIZABLE_ERROR");
  expect(codec.decode(frame.graph)).toBeInstanceOf(Error);
});

test("formatted BuildError is sent as a SyntaxError", () => {
  const { encode, codec } = workerErrorData();
  const original = new Error("parser failure");
  Object.defineProperty(original, "name", { value: "BuildError" });
  Object.defineProperty(original, "__bunwasmFormatted", { value: true });
  const frame = encode(original);
  expect(frame.code).toBeUndefined();
  const decoded = codec.decode(frame.graph);
  expect(decoded).toBeInstanceOf(SyntaxError);
  if (!(decoded instanceof Error)) throw new Error("Expected an Error graph");
  expect(decoded.message).toBe("parser failure");
});
