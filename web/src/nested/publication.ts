// What one member hands another through Waffle's group owner. Kind, relationship, extents and
// metadata live in the owner and are trusted as reported. Guest memory holds only a Memory's page
// cell and a Module's bytes, so everything read from it is checked here before it is used.

export const MEMORY_PUBLICATION = 1;
export const MODULE_PUBLICATION = 2;
export const CELL_BYTES = 16;
export const CELL_ALIGN = 16;
export const CELL_PAGES = 0;
const CELL_WORDS = 4;
/** Seven u32 words: a handle, address and length per region, then the metadata word. */
export const DESCRIPTOR_BYTES = 28;
const PAGE_BYTES = 65536;
const MAX_GROUP_PAGES = 65536;
/** runtime_nested's MAX_REQUEST_BYTES, which already bounded this string at publish. */
export const MAX_DESCRIPTION_BYTES = 1 << 20;

export interface PublicationDescriptor {
  readonly primary: number;
  readonly primaryAddress: number;
  readonly primaryLength: number;
  readonly companion: number;
  readonly companionAddress: number;
  readonly companionLength: number;
  readonly meta: number;
}

export function readDescriptor(buffer: ArrayBufferLike, out: number): PublicationDescriptor {
  const view = new DataView(buffer, out, DESCRIPTOR_BYTES);
  const word = (index: number) => view.getUint32(index * 4, true);
  return {
    primary: word(0), primaryAddress: word(1), primaryLength: word(2),
    companion: word(3), companionAddress: word(4), companionLength: word(5),
    meta: word(6),
  };
}

export interface ValidatedMemory { readonly maximum: number; readonly cells: Int32Array; }

/** Runs on the owner's values before any view is built over them. */
export function validateMemory(value: PublicationDescriptor, buffer: ArrayBufferLike): ValidatedMemory {
  const maximum = value.meta;
  if (maximum > MAX_GROUP_PAGES) throw new RangeError("published memory maximum exceeds wasm32");
  if (value.companion === 0 || value.companionLength !== CELL_BYTES || value.companionAddress % CELL_ALIGN !== 0) throw new RangeError("published memory page cell extent");
  if (value.primaryAddress % PAGE_BYTES !== 0 || value.primaryLength !== Math.max(maximum, 1) * PAGE_BYTES) throw new RangeError("published memory reservation extent");
  if (value.primaryAddress + value.primaryLength > buffer.byteLength || value.companionAddress + CELL_BYTES > buffer.byteLength) throw new RangeError("published memory outside group");
  const cells = new Int32Array(buffer, value.companionAddress, CELL_WORDS);
  if (Atomics.load(cells, 1) !== 0 || Atomics.load(cells, 2) !== 0 || Atomics.load(cells, 3) !== 0) throw new RangeError("published memory reserved cell words");
  if (Atomics.load(cells, CELL_PAGES) >>> 0 > maximum) throw new RangeError("published memory page count");
  return { maximum, cells };
}

export interface ValidatedModule { readonly description: string; readonly code: Uint8Array<ArrayBuffer>; }

const descriptions = new TextDecoder("utf-8", { fatal: true });

/** Checks shape only. The core's typed parse stays the authority on the description's contents. */
function checkDescription(text: string): void {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || !["memory", "imports", "exports"].every(key => Object.hasOwn(parsed, key))) throw new TypeError("published module description shape");
}

/** Copies out: neither TextDecoder nor WebAssembly.Module accepts a shared view. */
export function validateModule(value: PublicationDescriptor, buffer: ArrayBufferLike): ValidatedModule {
  if (value.companion !== 0 || value.companionAddress !== 0 || value.companionLength !== 0) throw new RangeError("published module has a companion");
  const descriptionBytes = value.meta;
  if (descriptionBytes === 0 || descriptionBytes > MAX_DESCRIPTION_BYTES || descriptionBytes >= value.primaryLength) throw new RangeError("published module description length");
  if (value.primaryAddress + value.primaryLength > buffer.byteLength) throw new RangeError("published module outside group");
  const bytes = new Uint8Array(buffer, value.primaryAddress, value.primaryLength);
  const description = descriptions.decode(bytes.slice(0, descriptionBytes));
  checkDescription(description);
  return { description, code: bytes.slice(descriptionBytes) };
}
