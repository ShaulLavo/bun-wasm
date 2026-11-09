import { runInNewContext } from "node:vm";
import { join } from "node:path";
import type * as Lane from "../../../web/src/shared-objects/lane";

let bundle: Promise<string> | undefined;
async function source() {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../../../web/src/shared-objects/lane.ts")], target: "browser", format: "cjs" });
  if (!result.success || !result.outputs[0]) throw new Error("Lane fixture bundle failed");
  return result.outputs[0].text();
}
export async function sourceLane(options: { grow?: (buffer: SharedArrayBuffer, length: number) => void; allocate?: (length: number) => void; fixedOnly?: boolean } = {}): Promise<typeof Lane> {
  class Native extends SharedArrayBuffer {}
  for (const key of ["byteLength", "growable", "maxByteLength"]) {
    const descriptor = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, key);
    if (descriptor && !(options.fixedOnly && key !== "byteLength")) Object.defineProperty(Native.prototype, key, descriptor);
  }
  Object.defineProperty(Native.prototype, "grow", { value: options.fixedOnly ? undefined : function(this: SharedArrayBuffer, length: number) {
    if (options.grow) options.grow(this, length);
    else SharedArrayBuffer.prototype.grow.call(this, length);
  } });
  const Bytes = new Proxy(Uint8Array, { construct(target, args) {
    if (typeof args[0] === "number") options.allocate?.(args[0]);
    return Reflect.construct(target, args);
  } });
  const module = { exports: {} };
  runInNewContext(await (bundle ??= source()), { module, exports: module.exports, SharedArrayBuffer: Native, Uint8Array: Bytes, Int32Array, DataView, Atomics, TextEncoder, TextDecoder, DOMException, Error, RangeError, TypeError, queueMicrotask });
  if (!("openSharedLane" in module.exports) || typeof module.exports.openSharedLane !== "function") throw new Error("Missing lane fixture exports");
  return module.exports as typeof Lane;
}
