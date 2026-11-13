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

/** What the next withdrawal does instead of answering: lose the call before or after the
 * directory acted, refuse for good, or fail in a way that is no lost call. */
export type WithdrawalFault = "lost-before" | "lost-after" | "refused" | "broken";
/** The answers of `nested_wire.rs`. */
const WITHDRAWN = 0, WITHDRAW_ABSENT = 1, WITHDRAW_REFUSED = 2;
// The model's own bookkeeping, taken before any test replaces these methods to interrupt the
// production code: an interruption inside the stand-in would test the stand-in.
const mapSet = Map.prototype.set, mapDelete = Map.prototype.delete;
/** The bridge failing a call or its reply: nothing says whether the native ran. */
function noAnswer() { return new Error("core data allocation failed"); }
/** A failure the host itself reports, as `nested.rs` marks it. */
function reported() { return Object.assign(new Error("nested backend failed"), { code: "ERR_BUNWASM_WITHDRAW_FAILED" }); }

// The production polyfill and codec run unchanged. Only the synchronous native
// directory boundary is supplied here; this is not real guest/worker coverage.
export function groupRuntime() {
  const memories = new Map<number, WebAssembly.Memory>();
  const directory = new Map<number, number>();
  /** `faults` are taken by the next withdrawals in order. `withdrawals` lists every request
   * that reached the directory, with its token and what the directory answered. */
  const control = { faults: [] as WithdrawalFault[], withdrawals: [] as [token: number, answer: number][], published: 0 };
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
        mapSet.call(memories, id, new host.Memory({ initial, maximum, shared: true }));
        return id;
      },
      memorySpan(id: number) { return { pointer: 1, length: memory(id).buffer.byteLength, generation: 0n, shared: true }; },
      publishSharedMemory(id: number) {
        memory(id);
        if (directory.size >= 4096) throw new Error("Directory limit");
        const token = ++nextToken;
        mapSet.call(directory, token, id);
        control.published++;
        return token;
      },
      attachSharedMemory(token: number) {
        const id = directory.get(token);
        if (id === undefined) throw new Error("BadF");
        return id;
      },
      // Tokens are issued once and an absent one changes nothing, as on both hosts.
      withdrawShared(token: number) {
        const fault = control.faults.shift();
        if (fault === "lost-before") throw noAnswer();
        if (fault === "broken") throw reported();
        if (fault === "refused") return WITHDRAW_REFUSED;
        const answer = mapDelete.call(directory, token) ? WITHDRAWN : WITHDRAW_ABSENT;
        control.withdrawals.push([token, answer]);
        if (fault === "lost-after") throw noAnswer();
        return answer;
      },
    },
    wasmSharedMemoryBuffer(id: number) { return memory(id).buffer; },
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
    base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
    transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
  };
  const internal: { native: typeof native; groupSharedObjects?: SharedObjects & { settle?(): void } } = { native };
  const api: typeof WebAssembly = factory("webassembly", host)(internal);
  const sharedObjects = internal.groupSharedObjects;
  if (!sharedObjects?.settle) throw new Error("Missing production group provider");
  const settle = sharedObjects.settle;
  const codec: Codec = factory("worker_codec", api)(internal).create({
    sharedObjects,
    isPort: () => false,
    prepare() { throw new Error("Unexpected port transfer"); },
    restore() { throw new Error("Unexpected port restore"); },
    activate() {},
  });
  return { api, codec, sharedObjects, directory, control, settle };
}
