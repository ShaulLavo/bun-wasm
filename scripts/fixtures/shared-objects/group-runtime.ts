import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import type { SharedObjects } from "../../../web/src/shared-objects/protocol";
import type { Codec } from "./runtime-types";

const host = globalThis.WebAssembly;
function factory(name: string, api: typeof WebAssembly) {
  const source = readFileSync(new URL(`../../../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url), "utf8");
  const scope: unknown = runInThisContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__groupPublicationFactory = (WebAssembly => ${source})`));
  if (typeof scope !== "function") throw new Error("Missing source scope");
  const create: unknown = scope(api);
  if (typeof create !== "function") throw new Error("Missing source factory");
  return create;
}

// The production polyfill and codec run unchanged. Only the synchronous native
// directory boundary is supplied here; this is not real guest/worker coverage.
export function groupRuntime() {
  const memories = new Map<number, WebAssembly.Memory>();
  const directory = new Map<number, number>();
  let nextMemory = 0x80000000, nextToken = 0;
  function memory(id: number) {
    const value = memories.get(id);
    if (!value) throw new Error("Invalid memory");
    return value;
  }
  const native = {
    wasm: {
      sharedMemorySupported: () => true,
      createSharedMemory(initial: number, maximum: number) {
        const id = ++nextMemory;
        memories.set(id, new host.Memory({ initial, maximum, shared: true }));
        return id;
      },
      memorySpan(id: number) { return { pointer: 1, length: memory(id).buffer.byteLength, generation: 0n, shared: true }; },
      publishSharedMemory(id: number) {
        memory(id);
        if (directory.size >= 4096) throw new Error("Directory limit");
        const token = ++nextToken;
        directory.set(token, id);
        return token;
      },
      attachSharedMemory(token: number) {
        const id = directory.get(token);
        if (id === undefined) throw new Error("BadF");
        return id;
      },
      withdrawShared(token: number) { directory.delete(token); },
    },
    wasmSharedMemoryBuffer(id: number) { return memory(id).buffer; },
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
    base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
    transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
  };
  const internal: { native: typeof native; groupSharedObjects?: SharedObjects } = { native };
  const api: typeof WebAssembly = factory("webassembly", host)(internal);
  const sharedObjects = internal.groupSharedObjects;
  if (!sharedObjects) throw new Error("Missing production group provider");
  const codec: Codec = factory("worker_codec", api)(internal).create({
    sharedObjects,
    isPort: () => false,
    prepare() { throw new Error("Unexpected port transfer"); },
    restore() { throw new Error("Unexpected port restore"); },
    activate() {},
  });
  return { api, codec, sharedObjects, directory };
}
