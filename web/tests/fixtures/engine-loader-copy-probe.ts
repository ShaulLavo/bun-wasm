import assert from "node:assert/strict";
import { appendCustomSection } from "../../../src/engine-kind.ts";
import { programMemory } from "../../../src/program-memory.ts";
import { loadWasm } from "../../src/engine-loader.ts";

const source = appendCustomSection(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 1, 1, 3]), "copy-control", new Uint8Array(4 * 1024 * 1024));
const build = new Bun.CryptoHasher("sha256").update(source).digest("hex");
const events: { kind: string; bytes: number }[] = [];
const NativeBlob = globalThis.Blob;
const NativeResponse = globalThis.Response;
const NativeUint8Array = globalThis.Uint8Array;
const nativeSet = NativeUint8Array.prototype.set;
const arrayConstructor = Object.getOwnPropertyDescriptor(NativeUint8Array.prototype, "constructor");
let measuring = true;
let sourceAllocations = 0;
let sourceCopyBytes = 0;
const TrackedUint8Array = new Proxy(NativeUint8Array, {
  construct(target, args, newTarget) {
    const bytes: unknown = Reflect.construct(target, args, newTarget);
    assert(bytes instanceof NativeUint8Array);
    if (measuring && bytes.byteLength === source.byteLength && bytes.buffer !== args[0]) sourceAllocations++;
    return bytes;
  },
});
async function verifyCached(response: Response): Promise<void> {
  // Cache consumption owns its reconstruction; count only loader assembly and preparation.
  measuring = false;
  const cached = await response.arrayBuffer();
  measuring = true;
  assert.equal(new Bun.CryptoHasher("sha256").update(cached).digest("hex"), build);
  stored.resolve();
}
const previous = new Map(["location", "caches", "__bunwasmBuilds"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const stored = Promise.withResolvers<void>();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (new URL(request.url).pathname.endsWith(".gz")) return new Response(null, { status: 404 });
  return new NativeResponse(source, { headers: { "Content-Type": "application/wasm" } });
} });
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  Object.defineProperty(globalThis, "location", { configurable: true, value: server.url });
  Object.defineProperty(globalThis, "__bunwasmBuilds", { configurable: true, value: { [new URL("copy-control.wasm", server.url).href]: build } });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {
    async match() { return null; },
    async open() { return { async put(_key: string, response: Response) {
      await verifyCached(response);
    } }; },
  } });
  globalThis.Response = class extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) events.push({ kind: "response-buffer-copy", bytes: body.byteLength });
    }
  };
  globalThis.Blob = class extends NativeBlob {
    constructor(...args: ConstructorParameters<typeof NativeBlob>) { super(...args); events.push({ kind: "blob", bytes: this.size }); }
    override async arrayBuffer() { events.push({ kind: "arrayBuffer", bytes: this.size }); return super.arrayBuffer(); }
  };
  globalThis.Uint8Array = TrackedUint8Array;
  Object.defineProperty(NativeUint8Array.prototype, "constructor", { ...arrayConstructor, value: TrackedUint8Array });
  NativeUint8Array.prototype.set = function (values: ArrayLike<number>, offset?: number) {
    if (measuring && this.byteLength === source.byteLength) sourceCopyBytes += values.length;
    return nativeSet.call(this, values, offset);
  };
  const engine = await loadWasm(new URL("copy-control.wasm", server.url).href, () => {});
  assert.equal(engine.size, source.length);
  assert.deepEqual(programMemory(engine.module), [{ kind: "private", origin: "defined", maximumPages: 3 }]);
  await Promise.race([stored.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cache did not finish")), 1000); })]);
  assert.deepEqual(events, [], "streamed bytes must not be copied through a retained Blob");
  assert.equal(sourceAllocations, 1, "loader must allocate exactly one whole-source typed array");
  assert.equal(sourceCopyBytes, source.byteLength, "loader must copy source chunks only once");
  console.log("PASS one owned engine source snapshot");
} finally {
  if (timer) clearTimeout(timer);
  await server.stop(true);
  globalThis.Blob = NativeBlob;
  globalThis.Response = NativeResponse;
  globalThis.Uint8Array = NativeUint8Array;
  NativeUint8Array.prototype.set = nativeSet;
  if (arrayConstructor) Object.defineProperty(NativeUint8Array.prototype, "constructor", arrayConstructor);
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
