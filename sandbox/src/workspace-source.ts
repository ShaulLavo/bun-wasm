export const SOURCE_LIMIT_BYTES = 8 * 1024 * 1024;
export const SOURCE_LIMIT_ENTRIES = 10_000;
const SOURCE_TIMEOUT_MS = 5_000;
export const APP = "/home/user/app";
export const SEED_MARKER = `${APP}/.bunwasm-initialized`;
export const RESTORE_MARKER = `${APP}/.bunwasm-restored`;

export interface SourceMetadata {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink" | "socket";
  readonly ino: number;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
}

export interface SourceReader {
  walk(path: string, options: { signal: AbortSignal; ignoreRoots: readonly string[] }): {
    next(): Promise<{ entries: readonly SourceMetadata[]; done: boolean }>;
    close(): Promise<void>;
  };
  readFile(path: string, options: { maxBytes: number; signal: AbortSignal }): Promise<Uint8Array | undefined>;
}

type SourceEntry = {
  readonly path: string;
  readonly mode: number;
  readonly mtime: number;
} & ({ readonly kind: "file"; readonly data: Uint8Array } | { readonly kind: "dir" });

export interface SourceSnapshot {
  readonly id: string;
  readonly template: string;
  readonly takenAt: number;
  readonly entries: readonly SourceEntry[];
  readonly bytes: number;
}

export class PreservationRefused extends Error {
  constructor(message: string) { super(`Workspace kept: ${message}`); }
}

function canonicalPath(path: string): boolean {
  return path === "/" || path.startsWith("/") && !path.includes("\0") && !path.includes("\\")
    && path.slice(1).split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Template files override even an explicitly cataloged regenerable root. */
export function excludedRoots(outputs: readonly string[], templatePaths: ReadonlySet<string>): string[] {
  const candidates = [`${APP}/node_modules`, "/home/user/.bun/install/cache/bun-wasm", SEED_MARKER, RESTORE_MARKER].concat(outputs.map(path => `${APP}/${path}`));
  return candidates.filter(root => !Array.from(templatePaths).some(path => within(`${APP}/${path}`, root)));
}

export function retainedPath(path: string, ignored: readonly string[]): boolean {
  if (!canonicalPath(path)) throw new PreservationRefused(`invalid stored path ${path}`);
  return !ignored.some(root => within(path, root));
}

function supported(entry: SourceMetadata): void {
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(entry.mtime)) throw new PreservationRefused(`invalid metadata at ${entry.path}`);
  if (entry.kind !== "file" && entry.kind !== "dir") throw new PreservationRefused(`${entry.kind} at ${entry.path} cannot be restored`);
  if (entry.kind === "file" && entry.nlink !== 1) throw new PreservationRefused(`hard links at ${entry.path} cannot be restored`);
  const mode = entry.kind === "dir" ? 0o700 : 0o600;
  if (entry.mode !== mode) throw new PreservationRefused(`permissions at ${entry.path} cannot be restored`);
}

export async function readSource(reader: SourceReader, template: string, ignoreRoots: readonly string[], signal?: AbortSignal): Promise<SourceSnapshot> {
  const deadline = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const ignored = ignoreRoots.concat([SEED_MARKER, RESTORE_MARKER]);
  const cursor = reader.walk("/", { signal: bounded, ignoreRoots: ignored.filter(root => root !== SEED_MARKER) });
  const metadata: SourceMetadata[] = [];
  try {
    let done = false;
    let initialized = false;
    while (!done) {
      bounded.throwIfAborted();
      const page = await cursor.next();
      done = page.done;
      initialized ||= page.entries.some(entry => entry.path === SEED_MARKER && entry.kind === "dir");
      metadata.push(...page.entries.filter(entry => retainedPath(entry.path, ignored)));
      if (metadata.length > SOURCE_LIMIT_ENTRIES) throw new PreservationRefused(`more than ${SOURCE_LIMIT_ENTRIES} retained entries`);
    }
    if (!initialized) throw new PreservationRefused("template initialization is incomplete");
    return await readEntries(reader, template, metadata, bounded);
  } finally { await cursor.close(); }
}

async function readEntries(reader: SourceReader, template: string, metadata: readonly SourceMetadata[], signal: AbortSignal): Promise<SourceSnapshot> {
  let bytes = 0;
  const paths = new Set<string>();
  for (const entry of metadata) {
    supported(entry);
    if (paths.has(entry.path)) throw new PreservationRefused(`duplicate path ${entry.path}`);
    paths.add(entry.path);
    if (entry.kind === "file") bytes += entry.size;
    if (bytes > SOURCE_LIMIT_BYTES) throw new PreservationRefused(`source payload exceeds ${SOURCE_LIMIT_BYTES} bytes`);
  }
  const entries: SourceEntry[] = [];
  for (const entry of metadata) {
    signal.throwIfAborted();
    entries.push(await readEntry(reader, entry, signal));
  }
  signal.throwIfAborted();
  return { id: crypto.randomUUID(), template, takenAt: Date.now(), entries, bytes };
}

async function readEntry(reader: SourceReader, entry: SourceMetadata, signal: AbortSignal): Promise<SourceEntry> {
  const base = { path: entry.path, mode: entry.mode, mtime: entry.mtime };
  if (entry.kind === "dir") return { ...base, kind: "dir" };
  const data = await reader.readFile(entry.path, { maxBytes: entry.size, signal });
  if (!data || data.byteLength !== entry.size) throw new PreservationRefused(`incomplete read at ${entry.path}`);
  return { ...base, kind: "file", data };
}

export function parseSnapshot(value: unknown): SourceSnapshot {
  if (!value || typeof value !== "object") throw new PreservationRefused("invalid source snapshot");
  if (!("id" in value) || typeof value.id !== "string" || !/^[\da-f-]{36}$/.test(value.id)) throw new PreservationRefused("invalid snapshot identity");
  if (!("template" in value) || typeof value.template !== "string" || !("takenAt" in value) || typeof value.takenAt !== "number" || !Number.isFinite(value.takenAt)) throw new PreservationRefused("invalid snapshot metadata");
  if (!("entries" in value) || !Array.isArray(value.entries) || value.entries.length > SOURCE_LIMIT_ENTRIES) throw new PreservationRefused("invalid snapshot entries");
  const entries = value.entries.map(parseEntry);
  const paths = new Set(entries.map(entry => entry.path));
  const bytes = entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.data.byteLength : 0), 0);
  if (paths.size !== entries.length || bytes > SOURCE_LIMIT_BYTES || !("bytes" in value) || value.bytes !== bytes) throw new PreservationRefused("invalid snapshot size or paths");
  return { id: value.id, template: value.template, takenAt: value.takenAt, entries, bytes };
}

function parseEntry(value: unknown): SourceEntry {
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string" || !canonicalPath(value.path)) throw new PreservationRefused("invalid snapshot path");
  if (!("mtime" in value) || typeof value.mtime !== "number" || !Number.isFinite(value.mtime) || !("mode" in value) || !("kind" in value)) throw new PreservationRefused("invalid snapshot entry metadata");
  const base = { path: value.path, mtime: value.mtime };
  if (value.kind === "dir" && value.mode === 0o700) return { ...base, mode: value.mode, kind: "dir" };
  if (value.kind === "file" && value.mode === 0o600 && "data" in value && value.data instanceof Uint8Array) return { ...base, mode: value.mode, kind: "file", data: value.data };
  throw new PreservationRefused("unsupported snapshot entry");
}
