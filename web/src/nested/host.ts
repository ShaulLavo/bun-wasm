// Browser counterpart of the native host's runtime_nested service
// (crates/bunwasm-host/src/nested.rs). Regionized modules run on the page's own WebAssembly in
// this member's worker, over regions of the group memory the embedded engine's SABs alias.
import { WasiExit } from "waffle/core/wasi";
import { readModuleInfo, type FunctionType, type ImportInfo, type ModuleInfo, type ValueName } from "./module-info.js";
import {
  BACKEND, BAD_FRAME, FRAME_ALIGN, FRAME_BYTES, MAX_DEPTH, MAX_RESOURCES, MAX_VALUES, OK, PENDING_EXCEPTION,
  decodeRequest, encodeReply, type Binding, type Reply, type Request, type WasmNumber,
} from "./wire.js";
import {
  CELL_ALIGN, CELL_BYTES, CELL_PAGES, DESCRIPTOR_BYTES, MAX_DESCRIPTION_BYTES, MEMORY_PUBLICATION, MODULE_PUBLICATION,
  readDescriptor, validateMemory, validateModule, type PublicationDescriptor,
} from "./publication.js";

const PAGE_BYTES = 65536;
const MAX_GROUP_PAGES = 65536;
/** The largest reservation whose byte length is still a signed 32-bit size, as on the native host. */
const MAX_RESERVATION_PAGES = 32767;
/** Optional growth room when the declared maximum cannot fit. A preference, never a refusal. */
const PREFERRED_FALLBACK_HEADROOM_PAGES = 1024;
const SLOT_BITS = 12;
const MAX_GENERATION = (BACKEND - 1) >>> SLOT_BITS;
const NO_MEMORY = 48;
const SHM_ERRORS = new Map([[6, "Again"], [8, "BadF"], [28, "Inval"], [NO_MEMORY, "NoMem"], [71, "Search"]]);
const TABLE_AND_GLOBAL_REFUSAL = "Nested tables and globals are not available on the Browser host";
const TABLE_AND_GLOBAL_REQUESTS = ["TableExport", "TableLength", "TableGet", "TableSet", "TableGrow", "GlobalGet", "GlobalSet"];
const MODULE_ALIGN = 16;
const encoder = new TextEncoder();

function shmError(status: number): string { return SHM_ERRORS.get(-status) ?? String(status); }

/** The documented runtime_shm functions this member's Waffle group attachment provides. */
export interface RegionProvider {
  shm_create(length: number, align: number, out: number): number;
  shm_detach(handle: number): number;
  shm_publish(kind: number, primary: number, companion: number, meta: number, out: number): number;
  shm_publication_open(token: number, kind: number, out: number): number;
  shm_withdraw(token: number): number;
  futex_wait32(address: number, expected: number, timeoutNs: bigint): number;
  futex_wait64(address: number, expected: bigint, timeoutNs: bigint): number;
  futex_wake(address: number, count: number): number;
}

interface WasiImports { imports(module: WebAssembly.Module): WebAssembly.Imports; }

/** A core-validated group core imports only the functions it uses; this names the rest. */
function declarationModule(): WebAssembly.Module {
  const unsigned = (value: number): number[] => value < 0x80 ? [value] : [(value & 0x7f) | 0x80].concat(unsigned(value >>> 7));
  const name = (text: string) => [text.length].concat(Array.from(new TextEncoder().encode(text)));
  const section = (id: number, content: number[]) => [id].concat(unsigned(content.length), content);
  const i32 = 0x7f, i64 = 0x7e;
  const signature = (params: number[]) => [0x60, params.length].concat(params, [1, i32]);
  const types = [signature([i32, i32, i32]), signature([i32]), signature([i32, i32, i64]), signature([i32, i64, i64]), signature([i32, i32]), signature([i32, i32, i32, i32, i32])];
  const functions: readonly (readonly [string, number])[] = [["shm_create", 0], ["shm_detach", 1], ["futex_wait32", 2], ["futex_wait64", 3], ["futex_wake", 4], ["shm_publish", 5], ["shm_publication_open", 0], ["shm_withdraw", 1]];
  const imports = functions.flatMap(([text, type]) => name("runtime_shm").concat(name(text), [0, type]));
  return new WebAssembly.Module(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(
    section(1, [types.length].concat(types.flat())),
    section(2, [functions.length].concat(imports)),
  )));
}

export function regionProvider(wasi: WasiImports): RegionProvider {
  const namespace = wasi.imports(declarationModule()).runtime_shm;
  if (!namespace) throw new TypeError("Nested execution requires a memory group member");
  return namespace as unknown as RegionProvider;
}

/** A callback's original JS value is rooted on the engine side; only this marker unwinds here. */
class PendingException extends Error {}
/** Raised by an import while nested code runs; reported as a RuntimeError, like a trap. */
class NestedExecution extends Error {
  constructor(message: string) { super(`nested execution failed: ${message}`); }
}

interface Entries {
  readonly alloc: (size: number, align: number) => number;
  readonly free: (pointer: number, size: number, align: number) => void;
  readonly dispatch: (invocation: number, callback: number, pointer: number) => number;
}

/**
 * Sizes to ask the group owner for, largest first: the declared maximum, then the required pages
 * with optional growth room that halves until it fits, then the required pages alone. Each request
 * is one owner step that changes nothing when refused, so the choice needs no view of the owner's
 * free space and cannot race another member.
 */
function reservationSizes(required: number, desired: number): number[] {
  const sizes = [desired];
  for (let room = PREFERRED_FALLBACK_HEADROOM_PAGES; room > 0; room >>>= 1) {
    if (required + room < desired) sizes.push(required + room);
  }
  if (required < desired) sizes.push(required);
  return sizes;
}

/**
 * One member's lease on a nested memory. The length lives in a group cell so every member sees one
 * value. Growth only moves that cell: Waffle zeroes the whole reservation when it is created.
 * `maximum` is the declared limit that imports are matched against. `reserved` is the storage the
 * group holds for it: never more than the maximum allows, often less, and one identity page for a
 * zero-maximum memory.
 */
class Region {
  released = false;
  /** Both bounds: a zero-maximum memory's identity page must never become visible. */
  private readonly limit: number;
  constructor(
    readonly handle: number, readonly cellHandle: number, readonly base: number, readonly maximum: number,
    readonly reserved: number, private readonly cells: Int32Array,
  ) { this.limit = Math.min(maximum, reserved); }
  /** Group memory is writable by every member, so the cell is checked on each read. */
  get pages(): number {
    const pages = Atomics.load(this.cells, CELL_PAGES) >>> 0;
    if (pages > this.limit) throw new NestedExecution("nested memory page count is corrupt");
    return pages;
  }
  get bytes(): number { return this.pages * PAGE_BYTES; }
  /** The admitted contiguous storage, charged in full whatever is visible. */
  get reservedBytes(): number { return this.reserved * PAGE_BYTES; }
  grow(delta: number): number {
    for (;;) {
      const old = this.pages;
      if (old + delta > this.limit) return -1;
      if (Atomics.compareExchange(this.cells, CELL_PAGES, old, old + delta) === old) return old;
    }
  }
  contains(address: number, width: number): boolean {
    return address >= this.base && address + width <= this.base + this.bytes && address % width === 0;
  }
  lease(): this {
    if (this.released) throw new NestedExecution("nested memory lease expired");
    return this;
  }
}

/** Generational memory slots: a stale handle can never name a later reservation. */
class Slots<T> {
  private readonly slots: { generation: number; value: T | undefined }[] = [];
  private readonly free: number[] = [];
  hasRoom(): boolean { return this.free.length > 0 || this.slots.length < MAX_RESOURCES; }
  insert(value: T): number {
    let slot = this.free.pop();
    if (slot === undefined) {
      if (this.slots.length >= MAX_RESOURCES) throw new Error("nested resource limit");
      slot = this.slots.push({ generation: 0, value: undefined }) - 1;
    }
    const entry = this.slots[slot]!;
    entry.value = value;
    return (BACKEND + entry.generation * 2 ** SLOT_BITS + slot) >>> 0;
  }
  private entry(id: number): { generation: number; value: T | undefined } {
    const raw = resourceIndex(id);
    const entry = this.slots[raw & (MAX_RESOURCES - 1)];
    if (!entry || entry.generation !== raw >>> SLOT_BITS || entry.value === undefined) throw new Error("invalid nested memory");
    return entry;
  }
  get(id: number): T { return this.entry(id).value!; }
  release(id: number): void {
    const entry = this.entry(id);
    entry.value = undefined;
    if (entry.generation === MAX_GENERATION) return;
    entry.generation++;
    this.free.push(resourceIndex(id) & (MAX_RESOURCES - 1));
  }
  live(): T[] { return this.slots.flatMap(slot => slot.value === undefined ? [] : [slot.value]); }
}

function resourceIndex(id: number): number {
  if ((id & BACKEND) === 0) throw new Error("mixed-backend WebAssembly resource");
  return (id & ~BACKEND) >>> 0;
}

function pushResource<T>(items: T[], value: T): number {
  if (items.length >= MAX_RESOURCES) throw new Error("nested resource limit");
  return (items.push(value) - 1 | BACKEND) >>> 0;
}

function getResource<T>(items: readonly T[], id: number, message: string): T {
  const item = items[resourceIndex(id)];
  if (item === undefined) throw new Error(message);
  return item;
}

/** `bytes` is kept only for a module this member compiled: a received one already has a token. */
interface CompiledModule { readonly module: WebAssembly.Module; readonly info: ModuleInfo; readonly bytes?: Uint8Array<ArrayBuffer>; }
interface Created { readonly handle: number; readonly address: number; }
interface Guest{ readonly instance: WebAssembly.Instance; readonly compiled: CompiledModule; readonly memory: Region; }
interface NestedFunction { readonly fn: (...args: unknown[]) => unknown; readonly type: FunctionType; }

const floats = new Float32Array(1);
const floatBits = new Uint32Array(floats.buffer);
const doubles = new Float64Array(1);
const doubleBits = new BigUint64Array(doubles.buffer);

function f32Bits(value: number): number { floats[0] = value; return floatBits[0]!; }
function f64Bits(value: number): bigint { doubles[0] = value; return doubleBits[0]!; }
function f32Value(bits: number): number { floatBits[0] = bits; return floats[0]!; }
function f64Value(bits: bigint): number { doubleBits[0] = bits; return doubles[0]!; }

function toValue(value: WasmNumber): number | bigint {
  if ("I32" in value) return value.I32;
  if ("I64" in value) return BigInt(value.I64);
  if ("F32" in value) return f32Value(value.F32);
  return f64Value(BigInt(value.F64));
}

function toNumber(value: unknown, type: ValueName): WasmNumber {
  if (type === "i32") return { I32: Number(value) | 0 };
  if (type === "i64") return { I64: BigInt.asIntN(64, BigInt(value as bigint)).toString() };
  if (type === "f32") return { F32: f32Bits(Number(value)) };
  if (type === "f64") return { F64: f64Bits(Number(value)).toString() };
  throw new Error("unsupported nested result value");
}

function numberType(value: WasmNumber): ValueName {
  if ("I32" in value) return "i32";
  if ("I64" in value) return "i64";
  if ("F32" in value) return "f32";
  return "f64";
}

function resultList(value: unknown, count: number): unknown[] {
  if (count === 0) return [];
  return count === 1 ? [value] : Array.from(value as Iterable<unknown>);
}

const SLOT_KINDS: Partial<Record<ValueName, number>> = { i32: 0, i64: 1, f32: 2, f64: 3 };

function writeSlot(view: DataView, at: number, value: unknown, type: ValueName): void {
  const kind = SLOT_KINDS[type];
  if (kind === undefined) throw new Error("unsupported nested result value");
  view.setUint32(at, kind, true);
  view.setUint32(at + 4, 0, true);
  const bits = type === "i32" ? BigInt(Number(value) >>> 0)
    : type === "i64" ? BigInt.asUintN(64, value as bigint)
      : type === "f32" ? BigInt(f32Bits(Number(value)))
        : f64Bits(Number(value));
  view.setBigUint64(at + 8, bits, true);
}

function readSlot(view: DataView, at: number, type: ValueName): number | bigint {
  const kind = view.getUint32(at, true);
  if (view.getUint32(at + 4, true) !== 0) throw new Error("invalid callback slot");
  if (kind !== SLOT_KINDS[type]) throw new Error("callback result type mismatch");
  const bits = view.getBigUint64(at + 8, true);
  if (type === "i32") return Number(BigInt.asIntN(32, bits));
  if (type === "i64") return BigInt.asIntN(64, bits);
  if (type === "f32") return f32Value(Number(bits & 0xffff_ffffn));
  return f64Value(bits);
}

/** A Wasm trap, or a stack overflow: RangeError in V8 and WebKit, InternalError in Firefox. */
function isTrap(error: unknown): error is Error {
  return error instanceof WebAssembly.RuntimeError || error instanceof RangeError || (error instanceof Error && error.name === "InternalError");
}

function replyError(error: unknown, category: string): Reply {
  if (error instanceof PendingException) return "PendingException";
  const execution = isTrap(error) || error instanceof NestedExecution;
  return { Error: { category: execution ? "RuntimeError" : category, message: error instanceof Error ? error.message : String(error) } };
}

function bindingNames(binding: Binding): { module: string; name: string } {
  return "Callback" in binding ? binding.Callback : "Function" in binding ? binding.Function : binding.Global;
}

/** One path for Compile and AttachModule, so both keep the table and global refusal. */
function compileRegionized(bytes: Uint8Array<ArrayBuffer>): Pick<CompiledModule, "module" | "info"> {
  const module = new WebAssembly.Module(bytes);
  // Refuse here, before an instance's start code can run and then fail building its exports.
  if (WebAssembly.Module.exports(module).some(item => item.kind === "table" || item.kind === "global")) throw new Error(TABLE_AND_GLOBAL_REFUSAL);
  return { module, info: readModuleInfo(bytes) };
}

/** One member's nested service. `checkActive` is its cancellation boundary. */
export class NestedHost {
  private provider: RegionProvider | undefined;
  private entries: Entries | undefined;
  private memory: WebAssembly.Memory | undefined;
  private coreFailed = false;
  private instantiationAttempts = 0;
  private failedInstantiations = 0;
  private readonly modules: CompiledModule[] = [];
  private readonly guests: Guest[] = [];
  private readonly functions: NestedFunction[] = [];
  private readonly functionIds = new Map<unknown, number>();
  private readonly regions = new Slots<Region>();
  private readonly invocations: number[] = [];

  constructor(private readonly checkActive: () => void, private readonly diagnostic: (text: string) => void) {}

  readonly imports = { request: (pointer: number, length: number, out: number) => this.request(pointer >>> 0, length >>> 0, out >>> 0) };

  bindProvider(provider: RegionProvider): void { this.provider = provider; }

  bindCore(core: WebAssembly.Instance, memory: WebAssembly.Memory): void {
    this.memory = memory;
    const exports = core.exports as Record<string, unknown>;
    const alloc = exports.bun_core_alloc, free = exports.bun_core_free, dispatch = exports.bun_nested_dispatch;
    if (typeof alloc !== "function" || typeof free !== "function" || typeof dispatch !== "function") throw new TypeError("Group core lacks nested entries");
    this.entries = { alloc: alloc as Entries["alloc"], free: free as Entries["free"], dispatch: dispatch as Entries["dispatch"] };
  }

  /** Snapshot for trace and tests; these are counters, not a memory measurement. */
  snapshot() {
    const regions = this.regions.live();
    return {
      modules: this.modules.length, instances: this.guests.length, functions: this.functions.length, memories: regions.length,
      reservedCommittedBytes: regions.reduce((sum, region) => sum + region.reservedBytes, 0),
      visibleBytes: regions.reduce((sum, region) => sum + region.bytes, 0),
      coreFailed: this.coreFailed, activeInvocations: this.invocations.length,
      instantiationAttempts: this.instantiationAttempts, failedInstantiations: this.failedInstantiations,
    };
  }

  private shared(): WebAssembly.Memory {
    if (!this.memory) throw new Error("member shared memory is not bound");
    return this.memory;
  }

  private region(): RegionProvider {
    if (!this.provider) throw new Error("shared memory needs a group member");
    return this.provider;
  }

  /** An owned copy: neither TextDecoder nor WebAssembly.Module accepts a shared view. */
  private copy(pointer: number, length: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.shared().buffer, pointer, length).slice();
  }

  /** A failure out of a core entry unwound core and engine frames: the member cannot continue. */
  private inCore<T>(action: (entries: Entries) => T): T {
    if (!this.entries) throw new Error("nested entries are not bound");
    try { return action(this.entries); }
    catch (error) {
      this.coreFailed = true;
      throw error;
    }
  }

  /**
   * Like the native host, a trap that skipped core and engine frames ends the member with status
   * 134. Only the outermost request converts it: a stack overflow leaves no room for this deep down.
   */
  private memberExit(error: unknown): unknown {
    if (!this.coreFailed || this.invocations.length > 0 || !isTrap(error)) return error;
    this.diagnostic(`reentered core failed: ${error.message}\n`);
    return new WasiExit(134);
  }

  private allocate(bytes: number): number {
    const pointer = this.inCore(entries => entries.alloc(bytes, FRAME_ALIGN)) >>> 0;
    if (pointer === 0) throw new Error("nested transport allocation failed");
    return pointer;
  }

  private request(pointer: number, length: number, out: number): number {
    this.checkActive();
    if (length > 1 << 20) throw new Error("nested request limit");
    try { return this.exchange(decodeRequest(this.copy(pointer, length)), out); }
    catch (error) { throw this.memberExit(error); }
  }

  private exchange(request: Request, out: number): number {
    const reply = this.reply(request);
    this.checkActive();
    const bytes = encodeReply(reply);
    const target = this.allocate(bytes.length);
    const buffer = this.shared().buffer;
    new Uint8Array(buffer, target, bytes.length).set(bytes);
    const view = new DataView(buffer);
    view.setUint32(out, target, true);
    view.setUint32(out + 4, bytes.length, true);
    return 0;
  }

  private reply(request: Request): Reply {
    const category = "Instantiate" in request ? "LinkError" : "RuntimeError";
    try { return this.execute(request); }
    catch (error) {
      if (this.coreFailed) throw error;
      return replyError(error, category);
    }
  }

  private execute(request: Request): Reply {
    if ("Reserve" in request) return this.reserve(request.Reserve.initial, request.Reserve.maximum);
    if ("Span" in request) return this.span(request.Span.memory);
    if ("Grow" in request) return this.growRegion(request.Grow.memory, request.Grow.delta);
    if ("Release" in request) return this.release(request.Release.memory);
    if ("PublishMemory" in request) return this.publishMemory(request.PublishMemory.memory);
    if ("AttachMemory" in request) return this.attachMemory(request.AttachMemory.token);
    if ("PublishModule" in request) return this.publishModule(request.PublishModule.module, request.PublishModule.description);
    if ("AttachModule" in request) return this.attachModule(request.AttachModule.token);
    if ("Withdraw" in request) return this.withdraw(request.Withdraw.token);
    if ("Compile" in request) return this.compile(request.Compile.pointer, request.Compile.length);
    if ("Function" in request) return this.exported(request.Function.instance, request.Function.name);
    if ("Instantiate" in request) {
      const { module, memory, bindings, invocation } = request.Instantiate;
      return this.enter(invocation, () => this.instantiate(module, memory, bindings));
    }
    if (TABLE_AND_GLOBAL_REQUESTS.some(name => name in request)) throw new Error(TABLE_AND_GLOBAL_REFUSAL);
    if (!("Call" in request)) throw new Error("Unknown nested request");
    const { function: id, arguments: args, invocation } = request.Call;
    return this.enter(invocation, () => this.call(id, args));
  }

  /**
   * A reservation is one stable contiguous range chosen from what the group has now. The declared
   * maximum is a limit, not a promise of storage: it is reserved when it fits, and otherwise only
   * the initial bytes must fit. Optional growth room never refuses bytes that do fit.
   */
  private reserve(initial: number, maximum: number): Reply {
    if (initial > maximum || maximum > MAX_GROUP_PAGES) throw new Error("region admission: Inval");
    if (initial > MAX_RESERVATION_PAGES) throw new Error("region admission: NoMem");
    if (!this.regions.hasRoom()) throw new Error("nested resource limit");
    // A zero-page memory still owns one charged page, so its identity is a distinct address.
    const sizes = reservationSizes(Math.max(initial, 1), Math.min(Math.max(maximum, 1), MAX_RESERVATION_PAGES));
    return this.withOutput(8, out => {
      for (const pages of sizes) {
        const memory = this.reserveAt(pages, initial, maximum, out);
        if (memory !== undefined) return { Handle: memory };
      }
      throw new Error("region admission: NoMem");
    });
  }

  /** One attempt. `undefined` means the group has no room for this size and its page cell. */
  private reserveAt(pages: number, initial: number, maximum: number, out: number): number | undefined {
    const data = this.tryCreateRegion(pages * PAGE_BYTES, PAGE_BYTES, out);
    return data && this.reserveCell(data, pages, initial, maximum, out);
  }

  /** A temporary output span in member memory, for Waffle's checked output pointers. */
  private withOutput<T>(bytes: number, action: (out: number) => T): T {
    const out = this.allocate(bytes);
    try { return action(out); }
    finally { if (!this.coreFailed) this.inCore(entries => entries.free(out, bytes, FRAME_ALIGN)); }
  }

  /** `undefined` when the group has no room for it. Every other refusal is an error. */
  private tryCreateRegion(length: number, align: number, out: number): Created | undefined {
    const status = this.region().shm_create(length, align, out);
    if (status === -NO_MEMORY) return undefined;
    if (status < 0) throw new Error(`region admission: ${shmError(status)}`);
    const view = new DataView(this.shared().buffer);
    return { handle: view.getUint32(out, true), address: view.getUint32(out + 4, true) };
  }

  private createRegion(length: number, align: number, out: number): Created {
    const created = this.tryCreateRegion(length, align, out);
    if (!created) throw new Error("region admission: NoMem");
    return created;
  }

  private detach(handle: number): void { this.region().shm_detach(handle); }

  /** An unpublished region must not stay charged to the group, whether its cell fails or has no room. */
  private reserveCell(data: Created, pages: number, initial: number, maximum: number, out: number): number | undefined {
    try {
      const cell = this.tryCreateRegion(CELL_BYTES, CELL_ALIGN, out);
      if (cell) return this.insertReserved(data, cell, pages, initial, maximum);
    } catch (error) {
      this.detach(data.handle);
      throw error;
    }
    this.detach(data.handle);
    return undefined;
  }

  private insertReserved(data: Created, cell: Created, pages: number, initial: number, maximum: number): number {
    try {
      const cells = new Int32Array(this.shared().buffer, cell.address, CELL_BYTES / Int32Array.BYTES_PER_ELEMENT);
      Atomics.store(cells, CELL_PAGES, initial);
      return this.regions.insert(new Region(data.handle, cell.handle, data.address, maximum, pages, cells));
    } catch (error) {
      this.detach(cell.handle);
      throw error;
    }
  }

  /** Published tokens leave through this u32 output, so one above 0x7fffffff cannot read as an errno. */
  private commitPublication(kind: number, primary: number, companion: number, meta: number): number {
    return this.withOutput(8, out => {
      const status = this.region().shm_publish(kind, primary, companion, meta, out);
      if (status < 0) throw new Error(`shared publication: ${shmError(status)}`);
      return new DataView(this.shared().buffer).getUint32(out, true);
    });
  }

  private publishMemory(id: number): Reply {
    const region = this.regions.get(id).lease();
    return { Count: this.commitPublication(MEMORY_PUBLICATION, region.handle, region.cellHandle, region.maximum) };
  }

  /** Takes every hold of a publication in one owner step and returns the owner's own extents. */
  private openPublication(token: number, kind: number): PublicationDescriptor {
    return this.withOutput(DESCRIPTOR_BYTES, out => {
      const status = this.region().shm_publication_open(token, kind, out);
      if (status < 0) throw new Error(`shared attachment: ${shmError(status)}`);
      return readDescriptor(this.shared().buffer, out);
    });
  }

  /** Companion before primary. The primary's detach still runs if the first one is interrupted. */
  private releaseHolds(value: PublicationDescriptor): void {
    try { if (value.companion !== 0) this.detach(value.companion); }
    finally { this.detach(value.primary); }
  }

  private attachMemory(token: number): Reply {
    if (!this.regions.hasRoom()) throw new Error("nested resource limit");
    const value = this.openPublication(token, MEMORY_PUBLICATION);
    try {
      const { maximum, reserved, cells } = validateMemory(value, this.shared().buffer);
      return { Handle: this.regions.insert(new Region(value.primary, value.companion, value.primaryAddress, maximum, reserved, cells)) };
    } catch (error) {
      this.releaseHolds(value);
      throw error;
    }
  }

  private publishModule(id: number, description: string): Reply {
    const { bytes } = getResource(this.modules, id, "invalid nested module");
    if (!bytes) throw new Error("Only a module compiled by this member can be published");
    const text = encoder.encode(description);
    if (text.length === 0 || text.length > MAX_DESCRIPTION_BYTES) throw new Error("shared publication: Inval");
    const created = this.withOutput(8, out => this.createRegion(text.length + bytes.length, MODULE_ALIGN, out));
    try {
      const target = new Uint8Array(this.shared().buffer, created.address, text.length + bytes.length);
      target.set(text);
      target.set(bytes, text.length);
      return { Count: this.commitPublication(MODULE_PUBLICATION, created.handle, 0, text.length) };
    } finally { this.detach(created.handle); }
  }

  /** The copy is taken under the holds. Compiling afterward holds nothing, so it cannot leak one. */
  private readPublishedModule(token: number): ReturnType<typeof validateModule> {
    const value = this.openPublication(token, MODULE_PUBLICATION);
    try { return validateModule(value, this.shared().buffer); }
    finally { this.releaseHolds(value); }
  }

  private attachModule(token: number): Reply {
    if (this.modules.length >= MAX_RESOURCES) throw new Error("nested resource limit");
    const { description, code } = this.readPublishedModule(token);
    return { AttachedModule: { id: pushResource(this.modules, compileRegionized(code)), description } };
  }

  private withdraw(token: number): Reply {
    const status = this.region().shm_withdraw(token);
    if (status < 0) throw new Error(`shared publication withdrawal: ${shmError(status)}`);
    return { Count: 0 };
  }

  private span(id: number): Reply {
    const region = this.regions.get(id);
    return { Memory: { pointer: region.base, pages: region.pages, maximum: region.maximum, committed: region.reservedBytes } };
  }

  private growRegion(id: number, delta: number): Reply {
    const old = this.regions.get(id).grow(delta);
    if (old < 0) throw new Error("memory growth: NoMem");
    return { Count: old };
  }

  private release(id: number): Reply {
    const region = this.regions.get(id);
    region.released = true;
    this.regions.release(id);
    try { this.detach(region.handle); }
    finally { this.detach(region.cellHandle); }
    return { Count: 0 };
  }

  private compile(pointer: number, length: number): Reply {
    this.region();
    const bytes = this.copy(pointer, length);
    return { Handle: pushResource(this.modules, { ...compileRegionized(bytes), bytes }) };
  }

  private enter(invocation: number, run: () => Reply): Reply {
    if (invocation === 0 || this.invocations.length >= MAX_DEPTH) throw new Error("invalid nested invocation");
    this.invocations.push(invocation);
    try { return run(); }
    finally { this.invocations.pop(); }
  }

  private instantiate(moduleId: number, memoryId: number, bindings: readonly Binding[]): Reply {
    const compiled = getResource(this.modules, moduleId, "invalid nested module");
    const region = this.regions.get(memoryId);
    if (this.guests.length >= MAX_RESOURCES) throw new Error("nested instance limit");
    const imported = compiled.info.imports.filter(item => item.module !== "bunwasm_region");
    this.validateBindings(imported, bindings);
    const imports = this.importObject(compiled.info, region, imported, bindings);
    this.instantiationAttempts++;
    try {
      // No nested registry entry is published before generated initialization and start run.
      const instance = new WebAssembly.Instance(compiled.module, imports);
      return { Handle: pushResource(this.guests, { instance, compiled, memory: region }) };
    } catch (error) {
      this.failedInstantiations++;
      throw error;
    }
  }

  private validateBindings(imports: readonly ImportInfo[], bindings: readonly Binding[]): void {
    if (imports.length !== bindings.length) throw new Error("nested import count");
    const types = new Map<string, FunctionType>();
    imports.forEach((item, index) => {
      this.validateBinding(item, bindings[index]!);
      if (item.kind !== "function") return;
      const key = JSON.stringify([item.module, item.name]);
      const previous = types.get(key);
      // Different signatures for one import name remain outside this admitted subset.
      if (previous && JSON.stringify(previous) !== JSON.stringify(item.type)) throw new Error("incompatible duplicate nested function import");
      types.set(key, item.type);
    });
  }

  private validateBinding(item: ImportInfo, binding: Binding): void {
    const names = bindingNames(binding);
    if (names.module !== item.module || names.name !== item.name) throw new Error("nested import order mismatch");
    if ("Callback" in binding) return this.validateCallback(item);
    if ("Function" in binding) return this.validateFunction(item, binding.Function.id);
    if (item.kind !== "global") throw new Error("global import type");
    if (item.mutable || item.value !== numberType(binding.Global.value)) throw new Error("incompatible nested global import type");
  }

  private validateCallback(item: ImportInfo): void {
    if (item.kind !== "function") throw new Error("callback import type");
    if (item.type.params.length > MAX_VALUES || item.type.results.length > MAX_VALUES) throw new Error("callback value limit");
  }

  private validateFunction(item: ImportInfo, id: number): void {
    const target = getResource(this.functions, id, "invalid nested function import");
    if (item.kind !== "function") throw new Error("function import type");
    if (JSON.stringify(target.type) !== JSON.stringify(item.type)) throw new Error("incompatible nested function import type");
  }

  private importObject(info: ModuleInfo, region: Region, imported: readonly ImportInfo[], bindings: readonly Binding[]): WebAssembly.Imports {
    const imports: Record<string, Record<string, unknown>> = Object.create(null);
    const regionNames = info.imports.filter(item => item.module === "bunwasm_region").map(item => item.name);
    imports.bunwasm_region = this.regionImports(region, regionNames);
    const pending = new Map<string, unknown[]>();
    imported.forEach((item, index) => {
      const namespace = imports[item.module] ??= Object.create(null);
      const key = JSON.stringify([item.module, item.name]);
      const value = this.importValue(item, bindings[index]!);
      const previous = pending.get(key);
      if (previous) {
        previous.push(value);
        return;
      }
      const values = [value];
      pending.set(key, values);
      let next = 0;
      Object.defineProperty(namespace, item.name, { enumerable: true, get: () => values[next++] });
    });
    return imports as WebAssembly.Imports;
  }

  private importValue(item: ImportInfo, binding: Binding): unknown {
    if ("Function" in binding) return getResource(this.functions, binding.Function.id, "invalid nested function import").fn;
    if ("Global" in binding) return toValue(binding.Global.value);
    if (item.kind !== "function") throw new Error("callback import type");
    return this.callbackImport(binding.Callback.id, item.type);
  }

  private callbackImport(id: number, type: FunctionType): (...args: unknown[]) => unknown {
    return (...args) => {
      try { return this.dispatch(id, args, type); }
      catch (error) {
        if (error instanceof PendingException || this.coreFailed) throw error;
        throw new NestedExecution(error instanceof Error ? error.message : String(error));
      }
    };
  }

  private regionImports(region: Region, names: readonly string[]): Record<string, unknown> {
    const imports: Record<string, unknown> = Object.create(null);
    for (const name of names) imports[name] = this.regionImport(region, name);
    return imports;
  }

  private regionImport(region: Region, name: string): unknown {
    switch (name) {
      case "memory": return this.shared();
      case "base": return new WebAssembly.Global({ value: "i32", mutable: false }, region.base | 0);
      case "bound0": return new WebAssembly.Global({ value: "i64", mutable: false }, BigInt(region.bytes));
      case "length": return () => BigInt(region.lease().bytes);
      case "pages": return () => region.lease().pages;
      case "grow": return (delta: number) => region.lease().grow(delta >>> 0);
      case "wait32": return (address: number, expected: number, timeout: bigint) => this.wait(region, address >>> 0, 4, () => this.region().futex_wait32(address >>> 0, expected, timeout));
      case "wait64": return (address: number, expected: bigint, timeout: bigint) => this.wait(region, address >>> 0, 8, () => this.region().futex_wait64(address >>> 0, expected, timeout));
      case "notify": return (address: number, count: number) => this.notify(region, address >>> 0, count >>> 0);
      default: throw new Error("unknown region import");
    }
  }

  private wait(region: Region, address: number, width: number, wait: () => number): number {
    if (!region.lease().contains(address, width)) throw new NestedExecution(`nested wait${width * 8} outside region`);
    const status = wait();
    this.checkActive();
    if (status < 0) throw new NestedExecution(`nested wait${width * 8} failed: ${status}`);
    return status;
  }

  private notify(region: Region, address: number, count: number): number {
    if (!region.lease().contains(address, 4)) throw new NestedExecution("nested notify outside region");
    return this.region().futex_wake(address, count);
  }

  private exported(instanceId: number, name: string): Reply {
    const guest = getResource(this.guests, instanceId, "invalid instance");
    const value = guest.instance.exports[name];
    const type = guest.compiled.info.exports.get(name);
    if (typeof value !== "function" || !type) throw new Error("missing nested function");
    if (type.params.concat(type.results).includes("ref")) throw new Error("reference/SIMD values cannot cross this nested JS ABI");
    let id = this.functionIds.get(value);
    if (id === undefined) {
      id = pushResource(this.functions, { fn: value as NestedFunction["fn"], type });
      this.functionIds.set(value, id);
    }
    return { Function: { id, params: type.params, results: type.results } };
  }

  private call(id: number, args: readonly WasmNumber[]): Reply {
    const { fn, type } = getResource(this.functions, id, "invalid function");
    const result = Reflect.apply(fn, undefined, args.map(toValue));
    const values = resultList(result, type.results.length);
    return { Values: values.map((value, index) => toNumber(value, type.results[index]!)) };
  }

  private dispatch(callback: number, args: readonly unknown[], type: FunctionType): unknown {
    const invocation = this.invocations.at(-1);
    if (invocation === undefined) throw new Error("callback outside invocation");
    if (args.length > MAX_VALUES || type.results.length > MAX_VALUES) throw new Error("callback value limit");
    const pointer = this.allocate(FRAME_BYTES);
    const memory = this.shared();
    const view = new DataView(memory.buffer);
    view.setUint32(pointer, args.length, true);
    view.setUint32(pointer + 4, type.results.length, true);
    for (const [index, value] of args.entries()) writeSlot(view, pointer + 8 + index * 16, value, type.params[index]!);
    try { return this.dispatchFrame(invocation, callback, pointer, type); }
    finally { if (!this.coreFailed) this.inCore(entries => entries.free(pointer, FRAME_BYTES, FRAME_ALIGN)); }
  }

  private dispatchFrame(invocation: number, callback: number, pointer: number, type: FunctionType): unknown {
    const status = this.inCore(entries => entries.dispatch(invocation, callback, pointer)) >>> 0;
    if (status === PENDING_EXCEPTION) throw new PendingException();
    if (status === BAD_FRAME) throw new Error("invalid engine callback frame");
    if (status !== OK) throw new Error("unknown engine callback status");
    const view = new DataView(this.shared().buffer);
    if (view.getUint32(pointer + 4, true) !== type.results.length) throw new Error("callback result arity");
    const values = type.results.map((result, index) => readSlot(view, pointer + 8 + index * 16, result));
    return values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
  }
}
