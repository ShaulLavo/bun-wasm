import { FilesystemClient, type FilesystemCompletion } from "waffle/fs/client";
import type { Runtime } from "waffle";
import { nextBuildFiles, record, type FileRead } from "./next-build-files";

declare const playground: { fs?: Pick<Runtime["filesystem"], "fork">; runtime?: Pick<Runtime, "processes"> };
type Available<T> = { status: "observed"; value: T } | { status: "unavailable"; reason: string };
export interface NextBuildCapture { at: number; files: FileRead[]; memory: Available<unknown>; processes: Available<unknown> }
declare global {
  var __goalsNextBuildRead: ((deadline: number) => Promise<NextBuildCapture>) | undefined;
  var __goalsNextBuildClose: (() => void) | undefined;
}
const numberKeys = ["pid", "parentPid", "rootPid", "job", "bytes", "members", "reserved", "retained", "regions", "pins", "published", "holds", "watches", "committedBytes", "memberPages", "freeBytes"];
function selectedNumbers(value: unknown, keys: readonly string[]): Record<string, number | null> {
  const input = record(value);
  return Object.fromEntries(keys.map(key => [key, typeof input?.[key] === "number" && Number.isSafeInteger(input[key]) && input[key] >= 0 ? input[key] : null]));
}
function failure(value: unknown): unknown {
  const item = record(value);
  if (!item) return null;
  return { ...selectedNumbers(item, ["bytes", "previousUsableBytes", "allocatorLiveBytes", "allocatorPeakBytes", "wasmCapacityBeforeBytes", "wasmCapacityAfterBytes"]), category: typeof item.category === "string" ? item.category.slice(0, 128) : null, reason: "unknown" };
}
function memoryRow(value: unknown): unknown[] {
  const item = record(value);
  if (!item || item.engine !== "quickjs") return [];
  return [{ engine: "quickjs", id: typeof item.id === "string" ? item.id.slice(0, 128) : null, commandId: typeof item.commandId === "string" ? item.commandId.slice(0, 128) : null,
    ...selectedNumbers(item, ["time", "commandStartedAt", "commandSequence", "wasmCapacityBytes", "memoryLimitBytes", "allocatorLiveBytes", "allocatorPeakBytes", "jsHeapBytes", "arrayBufferBytes", "swcBytes"]),
    terminal: typeof item.terminal === "boolean" ? item.terminal : null, acknowledgement: "unknown; supported hook does not expose an acknowledgement field",
    notes: typeof item.notes === "string" ? item.notes.slice(0, 2048) : null,
    failedAllocation: failure(item.failedAllocation), allocatorFailure: failure(item.allocatorFailure), frozenAllocatorFailure: failure(item.frozenAllocatorFailure), engineFailure: failure(item.engineFailure),
    engineCounters: selectedNumbers(item.engineCounters, ["refreshSequence", "mallocBytes", "structuralHeapBytes", "arrayBufferBytes", "arrayBufferCount", "countersValid", "automaticGcCount", "mallocBytesAfterAutomaticGc", "mallocGcThreshold", "currentMallocBytes"]),
  }];
}
async function memory(active: () => void): Promise<unknown> {
  active();
  const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
  if (typeof getter !== "function") throw new Error("QuickJS memory hook unavailable");
  const rows: unknown = await getter("quickjs", false);
  active();
  if (!Array.isArray(rows)) throw new Error("Unexpected memory snapshot shape");
  return { rows: rows.slice(0, 64).flatMap(memoryRow), truncated: rows.length > 64, freshness: "Counters can be stale between host-import boundaries; null is unknown, not headroom" };
}
async function processes(active: () => void): Promise<unknown> {
  active();
  if (!playground.runtime) throw new Error("Runtime process metadata unavailable");
  const service = await playground.runtime.processes();
  active();
  const workers: unknown = service.workerMemory();
  active();
  const groups: unknown = service.memoryGroups();
  active();
  if (!Array.isArray(workers) || !Array.isArray(groups)) throw new Error("Unexpected process metadata shape");
  return { workers: workers.slice(0, 64).map(row => selectedNumbers(row, numberKeys.slice(0, 5))),
    groups: groups.slice(0, 64).map(groupRow), truncated: workers.length > 64 || groups.length > 64,
    freshness: "Worker byte counts may be stale; group counters are owner metadata, not allocation headroom" };
}
function groupRow(value: unknown): unknown {
  const item = record(value);
  return { ...selectedNumbers(item, numberKeys.slice(5)), id: typeof item?.id === "string" ? item.id.slice(0, 128) : null,
    pids: Array.isArray(item?.pids) ? item.pids.filter((pid: unknown) => typeof pid === "number" && Number.isSafeInteger(pid) && pid >= 0).slice(0, 64) : null,
    bypassed: typeof item?.bypassed === "boolean" ? item.bypassed : null };
}
async function capture(deadline: number): Promise<NextBuildCapture> {
  const at = Date.now();
  if (at >= deadline - 25) throw new Error("Next observation deadline expired");
  const client = playground.fs ? new FilesystemClient(playground.fs.fork()) : undefined;
  const held: FilesystemCompletion[] = [];
  let closed = false;
  function active(): void {
    if (closed || Date.now() >= deadline - 25) throw new Error("Next observation closed or deadline expired");
  }
  let rejectClosed: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { rejectClosed = reject; });
  function close(): void {
    if (closed) return;
    closed = true;
    for (const completion of held) completion.release();
    client?.dispose();
    rejectClosed(new Error("Next observation closed or deadline expired"));
  }
  globalThis.__goalsNextBuildClose = close;
  const timer = setTimeout(close, Math.max(0, deadline - Date.now() - 25));
  async function request(operation: string, args: unknown[]): Promise<unknown> {
    active();
    if (!client) throw new Error("Guest filesystem unavailable");
    const completion = client.submit(operation, args);
    // Keep resolve completions pinned through the read: path replacement cannot redirect a checked inode.
    held.push(completion);
    return completion.value();
  }
  async function read(spec: typeof nextBuildFiles[number]): Promise<FileRead> {
    try {
      const handle = await checkedFile(spec.path, request);
      const stat = record(await request("stat", [handle]));
      const size = stat?.size;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new Error("File size unavailable");
      const offset = spec.tail ? Math.max(0, size - spec.limit) : 0;
      const bytes = await request("read", [handle, spec.limit, offset]);
      if (!(bytes instanceof Uint8Array) || bytes.length > spec.limit) throw new Error("File bytes unavailable or exceed bound");
      const after = record(await request("stat", [handle]));
      return { path: spec.path, status: "read", bytes: bytes.length, size, offset, truncated: offset > 0 || bytes.length !== size || after?.size !== size, text: new TextDecoder().decode(bytes) };
    } catch (error) { return { path: spec.path, status: "unavailable", reason: String(error) }; }
  }
  const available = async <T>(operation: () => Promise<T>): Promise<Available<T>> => {
    try { return { status: "observed", value: await Promise.race([operation(), cancelled]) }; }
    catch (error) { return { status: "unavailable", reason: String(error) }; }
  };
  try {
    const files = Promise.all(nextBuildFiles.map(spec => available(() => read(spec)).then(result => result.status === "observed" ? result.value : { path: spec.path, ...result })));
    const [observedFiles, observedMemory, observedProcesses] = await Promise.all([files, available(() => memory(active)), available(() => processes(active))]);
    return { at, files: observedFiles, memory: observedMemory, processes: observedProcesses };
  } finally { clearTimeout(timer); close(); }
}
async function checkedFile(path: string, request: (operation: string, args: unknown[]) => Promise<unknown>): Promise<number> {
  const components = path.slice(1).split("/");
  const root = await request("preopen", ["/"]);
  if (typeof root !== "number") throw new Error("Guest root unavailable");
  let directory = root;
  for (const [index, component] of components.entries()) {
    const resolved = record(await request("resolve", [directory, component, false]));
    if (typeof resolved?.node !== "number") throw new Error("Build path unavailable");
    directory = resolved.node;
    const stat = record(await request("stat", [directory]));
    if (stat?.kind !== (index === components.length - 1 ? "file" : "directory")) throw new Error("Build path is non-regular or a symlink");
  }
  return directory;
}
globalThis.__goalsNextBuildRead = capture;
