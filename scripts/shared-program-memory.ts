import { BUN_MEMORY_GROUP_POLICY, importedMemory, wasmMemoryLimits } from "../src/engine-kind";
import { sharedGroupMaxPages } from "./src/program-profile";

type BackingPolicy = Readonly<Record<keyof typeof BUN_MEMORY_GROUP_POLICY, number>>;
interface Cursor { readonly bytes: Uint8Array; at: number }
const PAGE = 65536;

function unsigned(cursor: Cursor): number {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    const byte = cursor.bytes[cursor.at++];
    if (byte === undefined) throw new TypeError("Truncated group layout");
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return value;
  }
  throw new TypeError("Invalid group layout integer");
}

function layoutInfo(cursor: Cursor): { bytes: number; alignment: number } {
  while (cursor.at < cursor.bytes.length) {
    const id = unsigned(cursor), length = unsigned(cursor), end = cursor.at + length;
    if (end > cursor.bytes.length) throw new TypeError("Truncated group layout subsection");
    if (id === 1) return { bytes: unsigned(cursor), alignment: 2 ** unsigned(cursor) };
    cursor.at = end;
  }
  throw new TypeError("Shared program lacks group layout");
}

function layout(bytes: Uint8Array): { bytes: number; alignment: number } {
  const cursor: Cursor = { bytes, at: 8 };
  while (cursor.at < bytes.length) {
    const id = bytes[cursor.at++], length = unsigned(cursor), end = cursor.at + length;
    if (end > bytes.length) throw new TypeError("Truncated Wasm section");
    if (id === 0 && customName(cursor) === "dylink.0") return layoutInfo({ bytes: bytes.subarray(cursor.at, end), at: 0 });
    cursor.at = end;
  }
  throw new TypeError("Shared program lacks dylink.0");
}

function customName(cursor: Cursor): string {
  const length = unsigned(cursor), end = cursor.at + length;
  const name = new TextDecoder().decode(cursor.bytes.subarray(cursor.at, end));
  cursor.at = end;
  return name;
}

/** Source declarations stay exact; supplied browser backing may have a smaller maximum. */
export function verifySharedProgramMemory(core: Uint8Array, side: Uint8Array, policy: BackingPolicy = BUN_MEMORY_GROUP_POLICY): void {
  const declaration = sharedGroupMaxPages();
  for (const bytes of [core, side]) {
    const memories = wasmMemoryLimits(bytes), memory = memories[0];
    if (memories.length !== 1 || memory?.origin !== "imported" || !memory.shared || importedMemory(bytes)?.maximum !== declaration || memory.maximum !== declaration)
      throw new TypeError("Shared program memory must match the current group address space");
    if (policy.maximumPages > memory.maximum || policy.maximumPages < memory.initial)
      throw new RangeError("Group backing maximum is outside a source memory import's limits");
  }
  const valid = Object.values(policy).every(value => Number.isSafeInteger(value) && value > 0);
  if (!valid || policy.stackBytes % 16 || policy.memberPages > policy.maximumPages)
    throw new RangeError("Invalid group backing, member allowance or stack policy");
  const data = layout(core), library = layout(side);
  if (data.alignment > PAGE || library.alignment > 2 ** 31)
    throw new RangeError("Shared program layout alignment exceeds group limits");
  const memberBytes = Math.max(1, Math.ceil(data.bytes / PAGE)) * PAGE + Math.ceil(policy.stackBytes / PAGE) * PAGE;
  const sideEnd = Math.ceil((PAGE + memberBytes) / library.alignment) * library.alignment + Math.max(1, library.bytes);
  if (memberBytes + Math.max(1, library.bytes) > policy.memberPages * PAGE || sideEnd > policy.maximumPages * PAGE)
    throw new RangeError("Group backing or member allowance cannot hold the program layout and stack");
}
