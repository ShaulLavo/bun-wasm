// Process and page helpers for page-load-profile.ts, kept apart so tests can import them.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Worker } from "playwright";

export interface PageLoadState { ready: number | null; error: string | null }

/**
 * A page init script. Readiness comes from the page's own marks, or, for builds that predate
 * them, from when `#status` first said ready. It publishes `__pageLoad.state(app)`, which both
 * the wait and the report read, so they agree on one timestamp.
 */
export function installPageLoadObserver(): void {
  const dom: PageLoadState = { ready: null, error: null };
  const watch = () => {
    const status = document.querySelector<HTMLElement>("#status");
    if (!status) return;
    const text = status.textContent ?? "";
    if (status.dataset.kind === "error") dom.error ??= text;
    if (dom.ready === null && /^(bun\.wasm ready|dev server ready)/.test(text)) dom.ready = performance.now();
  };
  new MutationObserver(watch).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const state = (app: string): PageLoadState => {
    const statuses = performance.getEntriesByName("bunwasm:status") as PerformanceMark[];
    const marked = app === "sandbox"
      ? performance.getEntriesByName("bunwasm:preview")[0]
      : statuses.find(mark => String(mark.detail).startsWith("bun.wasm ready"));
    const ready = marked ? marked.startTime + marked.duration : dom.ready;
    if (ready !== null) return { ready, error: null };
    const last = String(statuses.at(-1)?.detail ?? "");
    return { ready, error: /could not|not in this build|failed|error/i.test(last) ? last : dom.error };
  };
  Object.assign(globalThis, { __pageLoad: { state } });
}

/**
 * One IndexedDB read or SHA-256 digest, on the epoch clock shared by every realm. A cursor
 * contributes one entry per row it delivers, timed from its open or `continue()` call to that
 * row; its final empty result is not a read.
 */
export interface StorageRead {
  kind: "get" | "getAll" | "cursor" | "sha256"; start: number; end: number; bytes: number;
  /** The logical file size a Waffle chunk manifest names, which identifies the file read. */
  file?: number;
  /** The chunk index of a Waffle chunk record read. */
  chunk?: number;
}

/**
 * A worker script, run through `worker.evaluate`: records every IndexedDB read and SHA-256
 * digest the worker starts from then on, so a profile can split storage reads by startup stage.
 * Waffle's filesystem worker reads file payloads through these. It runs after the worker's
 * script has started, so `__storageCounter.installedAt` says from when the worker is covered.
 */
export function installStorageReadCounter(): number {
  const scope = globalThis as typeof globalThis & { __storageReads?: StorageRead[]; __storageCounter?: { installedAt: number } };
  const now = () => performance.timeOrigin + performance.now();
  if (scope.__storageCounter) return scope.__storageCounter.installedAt;
  const installedAt = now();
  scope.__storageCounter = { installedAt };
  const reads: StorageRead[] = scope.__storageReads = [];
  const size = (value: unknown): number => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + size(item), 0);
    if (!value || typeof value !== "object") return 0;
    return Object.values(value).reduce((sum: number, item) => sum + (item instanceof ArrayBuffer || ArrayBuffer.isView(item) ? item.byteLength : 0), 0);
  };
  const manifest = (value: unknown): number | undefined =>
    value && typeof value === "object" && "chunkSize" in value && "size" in value && typeof value.size === "number" ? value.size : undefined;
  const chunkIndex = (key: unknown) => Array.isArray(key) && typeof key[1] === "number" ? key[1] : undefined;
  const track = (kind: "get" | "getAll", request: IDBRequest, key?: unknown) => {
    const start = now();
    request.addEventListener("success", () => {
      reads.push({ kind, start, end: now(), bytes: size(request.result), file: kind === "get" ? manifest(request.result) : undefined, chunk: chunkIndex(key) });
    });
    return request;
  };
  // Each cursor step is timed from the call that requested it: the open, then each continue().
  const stepStarts = new WeakMap<IDBRequest, number>();
  const trackCursor = (request: IDBRequest<IDBCursorWithValue | null>) => {
    stepStarts.set(request, now());
    request.addEventListener("success", () => {
      const row = request.result;
      if (row) reads.push({ kind: "cursor", start: stepStarts.get(request)!, end: now(), bytes: size(row.value) });
    });
    return request;
  };
  const store = IDBObjectStore.prototype;
  const { get, getAll, openCursor } = store;
  store.get = function (...args: Parameters<IDBObjectStore["get"]>) { return track("get", get.apply(this, args), args[0]); };
  store.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) { return track("getAll", getAll.apply(this, args)); };
  store.openCursor = function (...args: Parameters<IDBObjectStore["openCursor"]>) { return trackCursor(openCursor.apply(this, args)); };
  const cursor = IDBCursor.prototype;
  const { continue: next, advance } = cursor;
  cursor.continue = function (...args: Parameters<IDBCursor["continue"]>) {
    stepStarts.set(this.request, now());
    return next.apply(this, args);
  };
  cursor.advance = function (...args: Parameters<IDBCursor["advance"]>) {
    stepStarts.set(this.request, now());
    return advance.apply(this, args);
  };
  const subtle = crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  const sha256 = (algorithm: AlgorithmIdentifier) => String(typeof algorithm === "string" ? algorithm : algorithm?.name).toUpperCase() === "SHA-256";
  subtle.digest = async (algorithm, data) => {
    // Classified at the call, as digest() reads it: the caller may reuse and change the object.
    const counted = sha256(algorithm);
    const start = now();
    const result = await digest(algorithm, data);
    if (counted) reads.push({ kind: "sha256", start, end: now(), bytes: data.byteLength });
    return result;
  };
  return installedAt;
}

/** Whether a worker's reads were collected, and from when its counter covered it. */
export interface WorkerCoverage {
  url: string;
  status: "observed" | "unavailable";
  /** Epoch ms the worker was reported and its counter installed; reads before `installedAt` are missed. */
  createdAt: number;
  /** Present whenever the counter was installed, also when its reads could not be read back. */
  installedAt?: number;
  /** Why an unavailable worker's reads are missing: closed, blocked, or a failed evaluation. */
  reason?: string;
  reads: number;
}

export interface StorageCollection { reads: StorageRead[]; workers: WorkerCoverage[] }

interface WatchedWorker {
  worker: Worker;
  createdAt: number;
  installed: Promise<number | Error>;
  closed: boolean;
}

/**
 * Installs the read counter in each worker as Playwright reports it and collects every worker's
 * reads, naming each worker whose reads are missing or start late instead of counting it as idle.
 */
export class StorageReadObserver {
  private readonly watched: WatchedWorker[] = [];

  watch(worker: Worker): void {
    const entry: WatchedWorker = { worker, createdAt: Date.now(), installed: Promise.resolve(new Error("not installed")), closed: false };
    entry.installed = worker.evaluate(installStorageReadCounter).catch(asError);
    worker.on("close", () => { entry.closed = true; });
    this.watched.push(entry);
  }

  /** A guest worker blocked in `Atomics.wait` never runs an evaluation; it is reported after `waitMs`. */
  async collect(waitMs = 2_000): Promise<StorageCollection> {
    const results = await Promise.all(this.watched.map(entry => collectWorker(entry, waitMs)));
    return { reads: results.flatMap(result => result.reads), workers: results.map(result => result.coverage) };
  }
}

type Collected = { reads: StorageRead[]; coverage: WorkerCoverage };
const firstLine = (error: Error) => error.message.split("\n")[0];
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

async function collectWorker(entry: WatchedWorker, waitMs: number): Promise<Collected> {
  const base = { url: entry.worker.url(), createdAt: entry.createdAt };
  if (entry.closed) {
    // No readback, but an install that already finished still says from when it was covered.
    // The next task runs after every already-settled install result has been delivered.
    const known = await Promise.race([entry.installed, new Promise<"pending">(resolve => setTimeout(resolve, 0, "pending"))]);
    return unavailable(typeof known === "number" ? { ...base, installedAt: known } : base, "closed before collection");
  }
  const timeout = new Promise<"blocked">(resolve => setTimeout(resolve, waitMs, "blocked"));
  const installed = await Promise.race([entry.installed, timeout]);
  if (installed === "blocked") return unavailable(base, `counter not installed within ${waitMs} ms`);
  if (installed instanceof Error) return unavailable(base, `counter not installed: ${firstLine(installed)}`);
  // From here the counter is known to be installed, so every outcome keeps its timestamp.
  const covered = { ...base, installedAt: installed };
  const reads = await Promise.race([readBack(entry.worker), timeout]);
  if (reads === "blocked") return unavailable(covered, `reads not collected within ${waitMs} ms`);
  if (reads instanceof Error) return unavailable(covered, entry.closed ? "closed before collection" : `reads not collected: ${firstLine(reads)}`);
  if (!Array.isArray(reads)) return unavailable(covered, "counter buffer missing");
  return { reads, coverage: { ...covered, status: "observed", reads: reads.length } };
}

/** The worker's read buffer as it is: a missing buffer is not an empty one. */
function readBack(worker: Worker): Promise<StorageRead[] | null | Error> {
  return worker.evaluate(() => (globalThis as { __storageReads?: StorageRead[] }).__storageReads ?? null).catch(asError);
}

function unavailable(base: Omit<WorkerCoverage, "status" | "reads" | "reason">, reason: string): Collected {
  return { reads: [], coverage: { ...base, status: "unavailable", reason, reads: 0 } };
}

/** IndexedDB reads and SHA-256 digests that started between the previous stage and this one. */
export interface StoragePhase { phase: string; until: number; reads: number; bytes: number; readMs: number; digests: number; digestMs: number; files: Record<number, number> }

/**
 * Buckets reads by the boot stage each one started in, on the page's clock. Readiness ends
 * startup, also for builds without stage marks: everything after it, including stages marked
 * later, is `after-ready`. A visit that never became ready leaves `after-last-stage` instead.
 */
export function storagePhases(entries: readonly { name: string; end: number }[], ready: number | null, origin: number, reads: readonly StorageRead[]): StoragePhase[] {
  const stages = entries.filter(entry => entry.name.startsWith("bunwasm:stage:") || entry.name === "bunwasm:dev-server" || entry.name === "bunwasm:preview")
    .map(entry => ({ phase: entry.name.replace(/^bunwasm:(stage:)?/, ""), until: entry.end }))
    .filter(stage => ready === null || stage.until <= ready)
    .sort((a, b) => a.until - b.until);
  const last = stages.at(-1)?.until ?? Number.NEGATIVE_INFINITY;
  const bounded = ready !== null && ready > last ? stages.concat([{ phase: "ready", until: ready }]) : stages;
  const tail = { phase: ready === null ? "after-last-stage" : "after-ready", until: Number.POSITIVE_INFINITY };
  const phases: StoragePhase[] = bounded.concat([tail]).map(stage => ({ ...stage, reads: 0, bytes: 0, readMs: 0, digests: 0, digestMs: 0, files: {} }));
  for (const read of reads) addRead(phases.find(item => read.start - origin <= item.until)!, read);
  return phases;
}

function addRead(phase: StoragePhase, read: StorageRead): void {
  if (read.kind === "sha256") {
    phase.digests++;
    phase.digestMs += read.end - read.start;
    return;
  }
  if (read.file !== undefined) phase.files[read.file] = (phase.files[read.file] ?? 0) + 1;
  phase.reads++;
  phase.bytes += read.bytes;
  phase.readMs += read.end - read.start;
}

export function requireUniqueNames(names: readonly string[]): void {
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new Error(`Variant ${repeated || "(unnamed)"} is named twice; each needs its own name`);
}

interface Tracked { readonly child: ChildProcess; readonly ended: Promise<void>; done: boolean }

/** Children tracked from the moment they spawn, so teardown reaches one whose start failed. */
export class ChildGroup {
  private readonly children = new Set<Tracked>();

  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const child = spawn(command, args, options);
    // A child that never starts (ENOENT) emits error and close but no exit; any of them ends it.
    const ended = new Promise<void>(resolveEnded => {
      for (const event of ["exit", "close", "error"] as const) child.once(event, () => resolveEnded());
    });
    const tracked: Tracked = { child, ended, done: false };
    void ended.then(() => { tracked.done = true; });
    this.children.add(tracked);
    return child;
  }

  stop(graceMs = 10_000): Promise<void> {
    return Promise.all(Array.from(this.children, tracked => stopChild(tracked, graceMs))).then(() => {});
  }
}

/** Stops a child and waits for it to end; one that ignores SIGTERM past `graceMs` is killed. */
async function stopChild({ child, ended, done }: Tracked, graceMs: number): Promise<void> {
  if (done || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await ended;
  clearTimeout(timer);
}

/**
 * Browser contexts tracked from the launch call until their close settles, so teardown closes
 * one still launching and waits for closes already under way. Teardown is single-shot and
 * refuses later launches. A context that fails to close fails its visit (its profile must not
 * be reused), while teardown still closes every other context before reporting the failures.
 */
export class ContextGroup<Context extends { close(): Promise<void> }> {
  private readonly launches = new Set<Promise<Context>>();
  private readonly lifetimes = new Set<Promise<void>>();
  /**
   * One close per launch, shared by its visit and by teardown, and never forgotten: a teardown
   * step queued behind another context still gets this context's original outcome.
   */
  private readonly closes = new WeakMap<Promise<Context>, Promise<void>>();
  private closing: Promise<void> | undefined;

  open<T>(launch: () => Promise<Context>, use: (context: Context) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Browser contexts are closing; no new launch"));
    const launching = launch();
    this.launches.add(launching);
    const lifetime = this.visit(launching, use);
    const settled = lifetime.then(() => {}, () => {});
    this.lifetimes.add(settled);
    void settled.then(() => { this.launches.delete(launching); this.lifetimes.delete(settled); });
    return lifetime;
  }

  closeAll(): Promise<void> {
    return this.closing ??= (async () => {
      try { await runAll(Array.from(this.launches, launching => () => this.close(launching))); }
      finally { await Promise.allSettled(this.lifetimes); }
    })();
  }

  /** Uses a context, then closes it. A close failure fails the visit unless the visit failed first. */
  private async visit<T>(launching: Promise<Context>, use: (context: Context) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await use(await launching);
    } catch (error) {
      await this.close(launching).catch(() => {});
      throw error;
    }
    await this.close(launching);
    return result;
  }

  private close(launching: Promise<Context>): Promise<void> {
    let closing = this.closes.get(launching);
    if (!closing) this.closes.set(launching, closing = launching.then(context => context.close(), () => {}));
    return closing;
  }
}

/** Runs every step in order even when one fails, then reports the failures together. */
export async function runAll(steps: readonly (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) await step().catch((error: unknown) => { failures.push(error); });
  if (failures.length) throw new AggregateError(failures, "Teardown failed");
}

/** Runs `cleanup` once on SIGINT, SIGTERM or SIGHUP, then exits with the signal's status. */
export function onInterrupt(cleanup: () => Promise<void>): void {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
  }
}
