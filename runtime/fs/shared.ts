import type { FileHandle, FileStat } from "../core";
import { PAGE, FilesystemError, isRevoked } from "./protocol";

const MAGIC = 0x42574653;
const HEADER_WORDS = 16;
const MAX_FILES = 4096;
const MAX_FILE_PAGES = 256;
const SEGMENT_PAGES = 256;
export const SHARED_SEGMENT_BYTES = SEGMENT_PAGES * PAGE;
const SEGMENT_BYTES = SEGMENT_PAGES * PAGE;
const MAX_SEGMENTS = 64;
export const DEFAULT_SHARED_MAX_BYTES = MAX_SEGMENTS * SHARED_SEGMENT_BYTES;
const TOTAL_PAGES = SEGMENT_PAGES * MAX_SEGMENTS;
const SLOT_WORDS = 12;
const PAGE_OWNER_OFFSET = HEADER_WORDS;
const SLOT_OFFSET = PAGE_OWNER_OFFSET + TOTAL_PAGES;
const PAGE_TABLE_OFFSET = SLOT_OFFSET + MAX_FILES * SLOT_WORDS;
const DATA_OFFSET = (PAGE_TABLE_OFFSET + MAX_FILES * MAX_FILE_PAGES) * 4;
const BUFFER_SIZE = DATA_OFFSET + SEGMENT_BYTES;
const GLOBAL_LOCK = 1;
const SERVICE_OWNER = 0x7fffffff;
const USED_PAGES = 2;
const SEGMENT_COUNT = 3;
const FILE_SIZE = 1;
const MTIME_LOW = 2;
const MTIME_HIGH = 3;
const INO = 4;
const CAPACITY = 5;
const REFS = 6;
const UNLINKED = 7;
const FILE_LOCK = 8;
const HANDLE = 9;

export class MissingSegmentError extends Error {}
export interface SharedFileInfo extends FileStat { capacity: number; }
export interface SharedSegment { buffer: SharedArrayBuffer; index: number; }

/** Shared metadata and a service-grown pool of fixed-size SAB data segments. */
export class SharedFilesystemState {
  readonly cells: Int32Array;
  readonly owners: Int32Array;
  readonly slots: Int32Array;
  readonly pages: Int32Array;
  readonly segments: SharedArrayBuffer[];
  readonly pendingSegments: SharedSegment[] = [];
  private readonly firstBytes: Uint8Array;
  private serviceMutation = false;
  onContention?: () => void;
  constructor(readonly buffer: SharedArrayBuffer = SharedFilesystemState.createBuffer(), maxBytes = DEFAULT_SHARED_MAX_BYTES) {
    this.cells = new Int32Array(buffer, 0, HEADER_WORDS);
    if (Atomics.compareExchange(this.cells, 0, 0, MAGIC) === 0) {
      Atomics.store(this.cells, USED_PAGES, 0);
      Atomics.store(this.cells, SEGMENT_COUNT, 1);
      Atomics.store(this.cells, 4, Math.max(1, Math.min(MAX_SEGMENTS, Math.floor(maxBytes / SEGMENT_BYTES))));
    } else while (Atomics.load(this.cells, 0) !== MAGIC) { /* another connection initializes */ }
    this.owners = new Int32Array(buffer, PAGE_OWNER_OFFSET * 4, TOTAL_PAGES);
    this.slots = new Int32Array(buffer, SLOT_OFFSET * 4, MAX_FILES * SLOT_WORDS);
    this.pages = new Int32Array(buffer, PAGE_TABLE_OFFSET * 4, MAX_FILES * MAX_FILE_PAGES);
    this.firstBytes = new Uint8Array(buffer, DATA_OFFSET, SEGMENT_BYTES);
    this.segments = [buffer];
  }
  static createBuffer(): SharedArrayBuffer { return new SharedArrayBuffer(BUFFER_SIZE); }
  addSegment(buffer: SharedArrayBuffer, index = this.segments.length): void {
    if (buffer.byteLength < SEGMENT_BYTES || !Number.isInteger(index) || index < 1 || index >= Atomics.load(this.cells, 4)) throw new RangeError("invalid shared filesystem segment");
    this.segments[index] = buffer;
  }
  takeNewSegments(): SharedSegment[] { const out = this.pendingSegments.slice(); this.pendingSegments.length = 0; return out; }
  private segmentFor(page: number): Uint8Array {
    const segment = Math.floor(page / SEGMENT_PAGES);
    const local = page % SEGMENT_PAGES;
    const buffer = this.segments[segment];
    if (!buffer) throw new MissingSegmentError("shared filesystem segment has not reached this guest");
    return segment === 0 ? this.firstBytes.subarray(local * PAGE, (local + 1) * PAGE) : new Uint8Array(buffer, local * PAGE, PAGE);
  }
  private findSlot(handle: FileHandle, create = false): number {
    if (!Number.isInteger(handle) || handle < 0 || handle >= 0x7ffffffe) return 0;
    const start = handle % (MAX_FILES - 1);
    let available = 0;
    for (let probe = 0; probe < MAX_FILES - 1; probe++) {
      const slot = (start + probe) % (MAX_FILES - 1) + 1;
      const key = Atomics.load(this.slots, this.at(slot, HANDLE));
      if (key === handle + 1) return slot;
      if (key <= 0 && !available) available = slot;
      if (key === 0) return create ? available : 0;
    }
    return create ? available : 0;
  }
  private slot(handle: FileHandle): number {
    const slot = this.findSlot(handle);
    if (!slot) throw new FilesystemError(8);
    return slot;
  }
  private at(slot: number, field: number): number { return slot * SLOT_WORDS + field; }
  private pageAt(slot: number, logical: number): number { return slot * MAX_FILE_PAGES + logical; }
  hasFile(handle: FileHandle): boolean { const slot = this.findSlot(handle); return slot !== 0 && Atomics.load(this.slots, this.at(slot, 0)) === 1; }
  private lock(index: number, revoked?: () => boolean, owner = SERVICE_OWNER): void {
    for (;;) {
      if (revoked?.()) throw new FilesystemError(11);
      if (Atomics.compareExchange(this.slots, index, 0, owner) === 0) {
        if (!revoked?.()) return;
        Atomics.compareExchange(this.slots, index, owner, 0);
        throw new FilesystemError(11);
      }
      this.onContention?.();
    }
  }
  private unlock(index: number, owner = SERVICE_OWNER): void { Atomics.compareExchange(this.slots, index, owner, 0); }
  private globalLock(revoked?: () => boolean, owner = SERVICE_OWNER): void {
    if (this.serviceMutation && owner === SERVICE_OWNER) return;
    for (;;) {
      if (revoked?.()) throw new FilesystemError(11);
      if (Atomics.compareExchange(this.cells, GLOBAL_LOCK, 0, owner) === 0) {
        if (!revoked?.()) return;
        Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, 0);
        throw new FilesystemError(11);
      }
      this.onContention?.();
    }
  }
  private globalUnlock(owner = SERVICE_OWNER): void {
    if (!this.serviceMutation) Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, 0);
  }
  beginServiceMutation(epoch: Int32Array): void {
    this.globalLock();
    this.serviceMutation = true;
    Atomics.add(epoch, 0, 1);
  }
  endServiceMutation(epoch: Int32Array): void {
    Atomics.add(epoch, 0, 1);
    this.serviceMutation = false;
    this.globalUnlock();
  }
  get ownsServiceMutation(): boolean { return this.serviceMutation; }
  mutate<T>(epoch: Int32Array | undefined, revoked: (() => boolean) | undefined, fn: () => T, owner = SERVICE_OWNER): T {
    this.globalLock(revoked, owner);
    if (epoch) Atomics.add(epoch, 0, 1);
    try { return fn(); }
    finally { if (epoch) Atomics.add(epoch, 0, 1); this.globalUnlock(owner); }
  }
  private setTimestamp(slot: number, mtime: number): void { Atomics.store(this.slots, this.at(slot, MTIME_LOW), mtime >>> 0); Atomics.store(this.slots, this.at(slot, MTIME_HIGH), Math.floor(mtime / 0x100000000) >>> 0); }
  private getMtime(slot: number): number { return (Atomics.load(this.slots, this.at(slot, MTIME_HIGH)) >>> 0) * 0x100000000 + (Atomics.load(this.slots, this.at(slot, MTIME_LOW)) >>> 0); }
  private ensureSegment(segment: number): void {
    if (segment < this.segments.length) return;
    if (segment >= Atomics.load(this.cells, 4)) throw new FilesystemError(51, "shared filesystem storage exhausted");
    const buffer = new SharedArrayBuffer(SEGMENT_BYTES);
    this.segments.push(buffer); this.pendingSegments.push({ buffer, index: segment });
    Atomics.store(this.cells, SEGMENT_COUNT, this.segments.length);
  }
  private allocate(slot: number, needed: number): void {
    const current = Atomics.load(this.slots, this.at(slot, CAPACITY));
    if (needed <= current) return;
    if (needed > MAX_FILE_PAGES) throw new RangeError("shared filesystem file is too large");
    const target = Math.max(needed, Math.min(MAX_FILE_PAGES, Math.max(1, current * 2)));
    const allocated: number[] = [];
    const take = (count: number) => {
      for (let physical = 0; physical < Atomics.load(this.cells, 4) * SEGMENT_PAGES && allocated.length < count; physical++) {
        this.ensureSegment(Math.floor(physical / SEGMENT_PAGES));
        if (Atomics.compareExchange(this.owners, physical, 0, slot) === 0) allocated.push(physical);
      }
    };
    take(target - current);
    if (allocated.length !== target - current && target !== needed) {
      for (const physical of allocated) { Atomics.store(this.owners, physical, 0); this.segmentFor(physical).fill(0); }
      allocated.length = 0; take(needed - current);
    }
    if (allocated.length !== needed - current && allocated.length !== target - current) {
      for (const physical of allocated) { Atomics.store(this.owners, physical, 0); this.segmentFor(physical).fill(0); }
      throw new FilesystemError(51, "shared filesystem storage exhausted");
    }
    for (let i = 0; i < allocated.length; i++) { const physical = allocated[i]!; Atomics.store(this.pages, this.pageAt(slot, current + i), physical + 1); this.segmentFor(physical).fill(0); }
    Atomics.store(this.slots, this.at(slot, CAPACITY), current + allocated.length); Atomics.add(this.cells, USED_PAGES, allocated.length);
  }
  register(handle: FileHandle, stat: FileStat, data?: Uint8Array): void {
    this.globalLock();
    try {
      const slot = this.findSlot(handle, true);
      if (!slot) throw new FilesystemError(51, "shared filesystem identity table exhausted");
      if (Atomics.load(this.slots, this.at(slot, 0)) && Atomics.load(this.slots, this.at(slot, INO)) === stat.ino) {
        if (stat.kind === "directory") this.setTimestamp(slot, stat.mtime);
        return;
      }
      if (stat.kind === "file") { this.allocate(slot, Math.ceil(Math.max(data?.length ?? 0, stat.size) / PAGE)); if (data?.length) this.copyInto(slot, data, 0); }
      Atomics.store(this.slots, this.at(slot, 0), stat.kind === "file" ? 1 : 2); Atomics.store(this.slots, this.at(slot, FILE_SIZE), stat.size); Atomics.store(this.slots, this.at(slot, INO), stat.ino); this.setTimestamp(slot, stat.mtime); Atomics.store(this.slots, this.at(slot, HANDLE), handle + 1);
    } finally { this.globalUnlock(); }
  }
  info(handle: FileHandle): SharedFileInfo | undefined { if (!this.hasFile(handle)) return undefined; const slot = this.slot(handle); return { kind: "file", ino: Atomics.load(this.slots, this.at(slot, INO)), size: Atomics.load(this.slots, this.at(slot, FILE_SIZE)), mtime: this.getMtime(slot), capacity: Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE }; }
  stat(handle: FileHandle): FileStat | undefined { const slot = this.findSlot(handle); if (!slot) return undefined; const kind = Atomics.load(this.slots, this.at(slot, 0)); if (!kind) return undefined; return { kind: kind === 1 ? "file" : "directory", ino: Atomics.load(this.slots, this.at(slot, INO)), size: kind === 1 ? Atomics.load(this.slots, this.at(slot, FILE_SIZE)) : 0, mtime: this.getMtime(slot) }; }
  private copyInto(slot: number, source: Uint8Array, offset: number): void { let at = offset; for (let sourceAt = 0; sourceAt < source.length;) { const logical = Math.floor(at / PAGE); const page = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1; const inPage = at % PAGE; const count = Math.min(source.length - sourceAt, PAGE - inPage); this.segmentFor(page).set(source.subarray(sourceAt, sourceAt + count), inPage); at += count; sourceAt += count; } }
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number, revoked?: () => boolean, owner = SERVICE_OWNER): number { const slot = this.slot(handle); if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { const size = Atomics.load(this.slots, this.at(slot, FILE_SIZE)); let total = 0; for (const chunk of chunks) { let at = 0; while (at < chunk.length && offset + total < size) { const position = offset + total; const page = Atomics.load(this.pages, this.pageAt(slot, Math.floor(position / PAGE))) - 1; const inPage = position % PAGE; const count = Math.min(chunk.length - at, size - position, PAGE - inPage); chunk.set(this.segmentFor(page).subarray(inPage, inPage + count), at); at += count; total += count; } if (at < chunk.length) break; } return total; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number, revoked?: () => boolean, owner = SERVICE_OWNER): number { const slot = this.slot(handle); if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31); const total = chunks.reduce((size, chunk) => size + chunk.length, 0); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { if (revoked?.()) throw new FilesystemError(11); const end = offset + total; if (end > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE) throw new RangeError("file needs growth"); let at = offset; for (const chunk of chunks) { this.copyInto(slot, chunk, at); at += chunk.length; } if (end > Atomics.load(this.slots, this.at(slot, FILE_SIZE))) Atomics.store(this.slots, this.at(slot, FILE_SIZE), end); this.setTimestamp(slot, Date.now()); return total; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  append(handle: FileHandle, chunks: readonly Uint8Array[], revoked?: () => boolean, owner = SERVICE_OWNER): { written: number; offset: number } { const slot = this.slot(handle); if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { const offset = Atomics.load(this.slots, this.at(slot, FILE_SIZE)); const total = chunks.reduce((size, chunk) => size + chunk.length, 0); if (offset + total > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE) throw new RangeError("file needs growth"); let at = offset; for (const chunk of chunks) { this.copyInto(slot, chunk, at); at += chunk.length; } Atomics.store(this.slots, this.at(slot, FILE_SIZE), at); this.setTimestamp(slot, Date.now()); return { written: total, offset: at }; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  growLocked(handle: FileHandle, size: number): void { this.allocate(this.slot(handle), Math.ceil(size / PAGE)); }
  grow(handle: FileHandle, size: number): void { this.globalLock(); try { this.growLocked(handle, size); } finally { this.globalUnlock(); } }
  resize(handle: FileHandle, size: number, truncate: boolean, revoked?: () => boolean, owner = SERVICE_OWNER): number { const slot = this.slot(handle); if (Atomics.load(this.slots, this.at(slot, 0)) !== 1) throw new FilesystemError(31); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { const old = Atomics.load(this.slots, this.at(slot, FILE_SIZE)); if (size > Atomics.load(this.slots, this.at(slot, CAPACITY)) * PAGE) throw new RangeError("file needs growth"); if (truncate && size < old) { let position = size; while (position < old) { const page = Atomics.load(this.pages, this.pageAt(slot, Math.floor(position / PAGE))) - 1; const count = Math.min(old - position, PAGE - position % PAGE); this.segmentFor(page).fill(0, position % PAGE, position % PAGE + count); position += count; } } Atomics.store(this.slots, this.at(slot, FILE_SIZE), truncate ? size : Math.max(old, size)); if (truncate) this.setTimestamp(slot, Date.now()); return 0; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  setMtime(handle: FileHandle, mtime: number, revoked?: () => boolean, owner = SERVICE_OWNER): number { const slot = this.slot(handle); this.lock(this.at(slot, FILE_LOCK), revoked, owner); try { this.setTimestamp(slot, mtime); return 0; } finally { this.unlock(this.at(slot, FILE_LOCK), owner); } }
  retain(handle: FileHandle): void { Atomics.add(this.slots, this.at(this.slot(handle), REFS), 1); }
  release(handle: FileHandle): void { const slot = this.slot(handle); const refs = Atomics.sub(this.slots, this.at(slot, REFS), 1) - 1; if (refs === 0 && Atomics.load(this.slots, this.at(slot, UNLINKED))) this.free(slot); }
  unlink(handle: FileHandle): void { const slot = this.findSlot(handle); if (!slot) return; Atomics.store(this.slots, this.at(slot, UNLINKED), 1); if (Atomics.load(this.slots, this.at(slot, REFS)) === 0) this.free(slot); }
  private free(slot: number): void { this.globalLock(); try { if (!Atomics.load(this.slots, this.at(slot, UNLINKED)) || Atomics.load(this.slots, this.at(slot, REFS))) return; const count = Atomics.load(this.slots, this.at(slot, CAPACITY)); for (let logical = 0; logical < count; logical++) { const owner = Atomics.load(this.pages, this.pageAt(slot, logical)) - 1; if (owner >= 0) { Atomics.store(this.owners, owner, 0); this.segmentFor(owner).fill(0); } Atomics.store(this.pages, this.pageAt(slot, logical), 0); } Atomics.sub(this.cells, USED_PAGES, count); for (let field = 0; field < SLOT_WORDS; field++) Atomics.store(this.slots, this.at(slot, field), 0); Atomics.store(this.slots, this.at(slot, HANDLE), -1); } finally { this.globalUnlock(); } }
  ownerActive(owner: number): boolean {
    if (Atomics.load(this.cells, GLOBAL_LOCK) === owner) return true;
    for (let slot = 1; slot < MAX_FILES; slot++) if (Atomics.load(this.slots, this.at(slot, FILE_LOCK)) === owner) return true;
    return false;
  }
  revokeOwner(owner: number, epoch?: Int32Array): void {
    if (!owner || owner === SERVICE_OWNER) return;
    // Keep the global lock held while repairing its epoch: another writer must not enter
    // between releasing the dead owner and publishing the matching even epoch.
    const ownsGlobal = Atomics.compareExchange(this.cells, GLOBAL_LOCK, owner, SERVICE_OWNER) === owner;
    for (let slot = 1; slot < MAX_FILES; slot++) Atomics.compareExchange(this.slots, this.at(slot, FILE_LOCK), owner, 0);
    if (ownsGlobal) {
      if (epoch && (Atomics.load(epoch, 0) & 1)) Atomics.add(epoch, 0, 1);
      this.globalUnlock();
    }
  }
  resources(): { bytes: number; poolBytes: number; metadataBytes: number; usedBytes: number; freeBytes: number; maxBytes: number; files: number } {
    let files = 0;
    for (let slot = 1; slot < MAX_FILES; slot++) if (Atomics.load(this.slots, this.at(slot, 0))) files++;
    const usedBytes = Atomics.load(this.cells, USED_PAGES) * PAGE;
    const poolBytes = Atomics.load(this.cells, SEGMENT_COUNT) * SEGMENT_BYTES;
    const metadataBytes = this.buffer.byteLength - SEGMENT_BYTES;
    return { bytes: poolBytes + metadataBytes, poolBytes, metadataBytes, usedBytes, freeBytes: poolBytes - usedBytes, maxBytes: Atomics.load(this.cells, 4) * SEGMENT_BYTES, files };
  }
}
export function sharedRevoked(connection: { revocations: SharedArrayBuffer[] }): () => boolean { const words = connection.revocations.map(buffer => new Int32Array(buffer)); return () => words.some(word => Atomics.load(word, 0) !== 0); }
