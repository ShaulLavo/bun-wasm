import assert from "node:assert/strict";
import { appendCustomSection } from "../../../src/engine-kind.ts";
import { programMemory } from "../../../src/program-memory.ts";
import { loadWasm } from "../../src/engine-loader.ts";

const source = appendCustomSection(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 1, 1, 3]), "copy-control", new Uint8Array(4 * 1024 * 1024));
const build = new Bun.CryptoHasher("sha256").update(source).digest("hex");
const events: { kind: string; bytes: number }[] = [];
const NativeBlob = globalThis.Blob;
const NativeResponse = globalThis.Response;
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
      assert.equal(new Bun.CryptoHasher("sha256").update(await response.arrayBuffer()).digest("hex"), build);
      stored.resolve();
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
  const engine = await loadWasm(new URL("copy-control.wasm", server.url).href, () => {});
  assert.equal(engine.size, source.length);
  assert.deepEqual(programMemory(engine.module), [{ kind: "private", origin: "defined", maximumPages: 3 }]);
  await Promise.race([stored.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cache did not finish")), 1000); })]);
  assert.deepEqual(events, [], "streamed bytes must not be copied through a retained Blob");
  console.log("PASS one owned engine source snapshot");
} finally {
  if (timer) clearTimeout(timer);
  await server.stop(true);
  globalThis.Blob = NativeBlob;
  globalThis.Response = NativeResponse;
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
