// Process and page helpers for page-load-profile.ts, kept apart so tests can import them.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

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

/** One IndexedDB read request or SHA-256 digest, on the epoch clock shared by every realm. */
export interface StorageRead {
  kind: "get" | "getAll" | "cursor" | "digest"; start: number; end: number; bytes: number;
  /** The logical file size a Waffle chunk manifest names, which identifies the file read. */
  file?: number;
  /** The chunk index of a Waffle chunk record read. */
  chunk?: number;
}

/**
 * A worker script, run through `worker.evaluate`: records every IndexedDB read request and
 * SHA-256 digest the worker starts, so a profile can split storage reads by startup stage.
 * Waffle's filesystem worker reads file payloads through these.
 */
export function installStorageReadCounter(): void {
  const scope = globalThis as typeof globalThis & { __storageReads?: StorageRead[] };
  if (scope.__storageReads) return;
  const reads: StorageRead[] = scope.__storageReads = [];
  const now = () => performance.timeOrigin + performance.now();
  const size = (value: unknown): number => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + size(item), 0);
    if (!value || typeof value !== "object") return 0;
    return Object.values(value).reduce((sum: number, item) => sum + (item instanceof ArrayBuffer || ArrayBuffer.isView(item) ? item.byteLength : 0), 0);
  };
  const manifest = (value: unknown): number | undefined =>
    value && typeof value === "object" && "chunkSize" in value && "size" in value && typeof value.size === "number" ? value.size : undefined;
  const track = (kind: StorageRead["kind"], request: IDBRequest) => {
    const start = now();
    request.addEventListener("success", () => {
      const key: unknown = Reflect.get(request, "__key");
      reads.push({ kind, start, end: now(), bytes: kind === "cursor" ? 0 : size(request.result), file: kind === "get" ? manifest(request.result) : undefined, chunk: Array.isArray(key) && typeof key[1] === "number" ? key[1] : undefined });
    });
    return request;
  };
  const store = IDBObjectStore.prototype;
  const { get, getAll, openCursor } = store;
  store.get = function (...args: Parameters<IDBObjectStore["get"]>) {
    const request = get.apply(this, args);
    Reflect.set(request, "__key", args[0]);
    return track("get", request);
  };
  store.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) { return track("getAll", getAll.apply(this, args)); };
  store.openCursor = function (...args: Parameters<IDBObjectStore["openCursor"]>) { return track("cursor", openCursor.apply(this, args)) as IDBRequest<IDBCursorWithValue | null>; };
  const subtle = crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  subtle.digest = async (algorithm, data) => {
    const start = now();
    const result = await digest(algorithm, data);
    reads.push({ kind: "digest", start, end: now(), bytes: data.byteLength });
    return result;
  };
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
