// The frozen runtime_nested wire contract (crates/bunwasm-runtime/src/wasm/nested_wire.rs).
// Requests and replies are compact serde_json externally tagged enums. Handles and numeric bits
// cross it; JS values, roots and thrown objects never do.

export const BACKEND = 0x8000_0000;
export const MAX_RESOURCES = 4096;
export const MAX_VALUES = 32;
export const MAX_DEPTH = 64;
export const FRAME_BYTES = 520;
export const FRAME_ALIGN = 8;
export const OK = 0;
export const PENDING_EXCEPTION = 2;
export const BAD_FRAME = 3;

/** An i64 or f64 payload stays a decimal string so its 64 bits survive JSON. */
export type WasmNumber = { I32: number } | { I64: string } | { F32: number } | { F64: string };

interface Named { module: string; name: string; }
export type Binding =
  | { Callback: Named & { id: number } }
  | { Function: Named & { id: number } }
  | { Global: Named & { value: WasmNumber } };

export type Request =
  | { Reserve: { initial: number; maximum: number } }
  | { Span: { memory: number } }
  | { Grow: { memory: number; delta: number } }
  | { Release: { memory: number } }
  | { Compile: { pointer: number; length: number } }
  | { Instantiate: { module: number; memory: number; bindings: Binding[]; invocation: number } }
  | { Function: { instance: number; name: string } }
  | { Call: { function: number; arguments: WasmNumber[]; invocation: number } }
  | { PublishMemory: { memory: number } }
  | { AttachMemory: { token: number } }
  | { PublishModule: { module: number; description: string } }
  | { AttachModule: { token: number } }
  | { Withdraw: { token: number } };

export type Reply =
  | { Handle: number }
  | { Count: number }
  | { Memory: { pointer: number; pages: number; maximum: number; committed: number } }
  | { Function: { id: number; params: readonly string[]; results: readonly string[] } }
  | { Values: readonly WasmNumber[] }
  | { Error: { category: string; message: string } }
  | "PendingException";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** `bytes` must not be SharedArrayBuffer-backed: TextDecoder refuses those views. */
export function decodeRequest(bytes: Uint8Array): Request {
  // serde_json writes no whitespace, and a quote inside a string is always escaped, so this
  // reaches only real I64/F64 payloads. Without it JSON.parse would round them to doubles.
  const exact = decoder.decode(bytes).replace(/"(I64|F64)":(-?[0-9]+)/g, '"$1":"$2"');
  return JSON.parse(exact) as Request;
}

function encodeNumber(value: WasmNumber): string {
  if ("I32" in value) return `{"I32":${value.I32}}`;
  if ("I64" in value) return `{"I64":${value.I64}}`;
  if ("F32" in value) return `{"F32":${value.F32}}`;
  return `{"F64":${value.F64}}`;
}

export function encodeReply(reply: Reply): Uint8Array {
  if (typeof reply === "object" && "Values" in reply) {
    return encoder.encode(`{"Values":[${reply.Values.map(encodeNumber).join(",")}]}`);
  }
  return encoder.encode(JSON.stringify(reply));
}
