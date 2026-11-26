import { packageFetch } from "./package-fetch.js";

const METADATA = "application/vnd.npm.install-v1+json";
const TARBALL = "application/vnd.bun.install-tarball";
const CACHE = "bun-wasm-install-v1";
const CACHE_METADATA_HEADER = "x-bun-wasm-cache-metadata";
const CACHE_CAPTURE_LIMIT = 4 * 1024 * 1024;
const PUT_QUEUE_BYTE_LIMIT = 8 * 1024 * 1024;
const PUT_QUEUE_ENTRY_LIMIT = 512;
const SESSION_IDLE_REFRESH_MS = 2_000;
const BODY_FORBIDDEN_STATUS = new Set([204, 205, 304]);

type CaptureState =
  | { kind: "active"; chunks: Uint8Array[]; bytes: number }
  | { kind: "completed" }
  | { kind: "cancelled" }
  | { kind: "over-budget" };

interface OpenedCache {
  cache: Cache;
  knownKeys: Set<string> | undefined;
  generation: number;
}

interface QueuedPut {
  key: string;
  url: string;
  bytes: number;
  response: Response;
  chunks: Uint8Array[] | null;
  opened: OpenedCache;
}

interface CacheSession {
  generation: number;
  opened?: Promise<OpenedCache | undefined>;
  lastActivity: number;
  activeFetches: number;
  activePut: boolean;
  activePutBytes: number;
  queuedBytes: number;
  queue: QueuedPut[];
  queuedByKey: Map<string, QueuedPut>;
  drainScheduled: boolean;
}

const sessions = new WeakMap<CacheStorage, CacheSession>();

function getSession(storage: CacheStorage): CacheSession {
  let session = sessions.get(storage);
  if (!session) {
    session = {
      generation: 0,
      lastActivity: 0,
      activeFetches: 0,
      activePut: false,
      activePutBytes: 0,
      queuedBytes: 0,
      queue: [],
      queuedByKey: new Map(),
      drainScheduled: false,
    };
    sessions.set(storage, session);
  }
  return session;
}

function cacheKey(url: string): string {
  try {
    const base = typeof location === "object" && typeof location?.href === "string" ? location.href : undefined;
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function invalidateSession(session: CacheSession | undefined): void {
  if (!session) return;
  session.generation++;
  session.opened = undefined;
  for (const entry of session.queue) {
    if (entry.chunks) entry.chunks.length = 0;
  }
  session.queue.length = 0;
  session.queuedByKey.clear();
  session.queuedBytes = 0;
}

/** Delete the tarball download cache and discard any queued background writes. */
export async function clearInstallCache(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  invalidateSession(sessions.get(caches));
  return typeof caches.delete === "function" ? caches.delete(CACHE) : false;
}

function shouldRefreshSession(session: CacheSession, now: number): boolean {
  if (!session.opened) return true;
  if (session.activeFetches > 0 || session.activePut || session.queue.length > 0) return false;
  return now - session.lastActivity >= SESSION_IDLE_REFRESH_MS;
}

async function loadKnownKeys(cache: Cache): Promise<Set<string> | undefined> {
  if (typeof cache.keys !== "function") return undefined;
  try {
    const requests = await cache.keys();
    return new Set(requests.map(request => cacheKey(request.url)));
  } catch {
    // Fall back to cache.match() when key enumeration is unavailable or fails.
    return undefined;
  }
}

function getOpenedCache(storage: CacheStorage, session: CacheSession, now: number): Promise<OpenedCache | undefined> {
  if (!shouldRefreshSession(session, now)) return session.opened!;
  const generation = session.generation;
  let opening: Promise<OpenedCache | undefined> | undefined;
  opening = (async (): Promise<OpenedCache | undefined> => {
    try {
      const cache = await storage.open(CACHE);
      const knownKeys = await loadKnownKeys(cache);
      if (session.generation !== generation) return undefined;
      return { cache, knownKeys, generation };
    } catch {
      if (session.opened === opening) session.opened = undefined;
      return undefined;
    }
  })();
  session.opened = opening;
  return opening;
}

/** Cache npm downloads across playground runs, without caching ordinary user fetches. */
export async function installFetch(url: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  const header = headers.get("accept") ?? "";
  const accept = header.split(";", 1)[0];
  if (options.method !== "GET" || accept !== METADATA && accept !== TARBALL) {
    return fetch(url, options);
  }
  if (accept === METADATA || typeof caches === "undefined" || headers.has("authorization")) {
    return packageFetch(url, options);
  }
  const directives = headers.get("cache-control")?.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g);
  const refresh = header.includes("; no-cache") || (directives?.some(value => value.trim().toLowerCase() === "no-cache") ?? false);
  const storage = caches;
  const session = getSession(storage);
  const key = cacheKey(url);
  const now = Date.now();
  const opening = getOpenedCache(storage, session, now);
  session.activeFetches++;
  session.lastActivity = now;
  try {
    const opened = await opening;
    const activeOpened = opened && opened.generation === session.generation ? opened : undefined;
    if (activeOpened && !refresh) {
      const cached = await matchKnownEntry(activeOpened, key, url);
      if (cached) return restoreCachedResponse(cached);
    }
    const response = await packageFetch(url, options);
    if (!response.ok || !activeOpened || activeOpened.generation !== session.generation) return response;
    return prepareCachedResponse(response, session, activeOpened, key, url, options.signal);
  } finally {
    session.activeFetches--;
    session.lastActivity = Date.now();
  }
}

async function matchKnownEntry(opened: OpenedCache, key: string, url: string): Promise<Response | undefined> {
  if (opened.knownKeys !== undefined && !opened.knownKeys.has(key)) return undefined;
  try {
    const cached = await opened.cache.match(url);
    if (cached) return cached;
    opened.knownKeys?.delete(key);
  } catch {
    // Private browsing and exhausted quotas must not prevent an install.
  }
  return undefined;
}

function prepareCachedResponse(
  response: Response,
  session: CacheSession,
  opened: OpenedCache,
  key: string,
  url: string,
  signal: AbortSignal | null | undefined,
): Response {
  if (!response.body) {
    enqueuePut(session, opened, key, url, response, null, 0);
    return response;
  }
  if (BODY_FORBIDDEN_STATUS.has(response.status)) return response;
  const body = createForwardingBody(response, session, opened, key, url, signal);
  return createResponseWithBody(response, body);
}

function createForwardingBody(
  response: Response,
  session: CacheSession,
  opened: OpenedCache,
  key: string,
  url: string,
  signal: AbortSignal | null | undefined,
): ReadableStream<Uint8Array> {
  const source = response.body!;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let state: CaptureState = { kind: "active", chunks: [], bytes: 0 };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let released = false;
  let cancelled = false;
  let abortReason: unknown;

  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
    signal?.removeEventListener("abort", abort);
  };
  const cancelReader = async (reason: unknown): Promise<void> => {
    if (cancelled) return release();
    cancelled = true;
    await reader.cancel(reason).catch(() => {});
    release();
  };
  const cancelUpstream = (reason: unknown): Promise<void> => {
    cleanupPromise ??= cancelReader(reason);
    return cleanupPromise;
  };
  const cancelCapture = () => {
    if (state.kind !== "completed") state = { kind: "cancelled" };
  };
  const abort = () => {
    abortReason = signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    cancelCapture();
    void cancelUpstream(abortReason).then(() => controller?.error(abortReason));
  };

  signal?.addEventListener("abort", abort, { once: true });
  try {
    reader = source.getReader();
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    throw error;
  }
  if (signal?.aborted) abort();

  const fail = async (error: unknown) => {
    cancelCapture();
    await cancelUpstream(error);
    controller?.error(error);
  };
  const finish = () => {
    const captured = state.kind === "active" ? { chunks: state.chunks, bytes: state.bytes } : undefined;
    state = { kind: "completed" };
    release();
    controller?.close();
    if (captured) enqueuePut(session, opened, key, url, response, captured.chunks, captured.bytes);
  };
  const read = async () => {
    if (!isForwardingState(state)) return;
    try {
      const result = await reader.read();
      if (!isForwardingState(state)) return;
      if (result.done) return finish();
      state = captureChunk(state, result.value);
      controller?.enqueue(result.value);
    } catch (error) {
      await fail(error);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (state.kind === "cancelled") streamController.error(abortReason);
    },
    pull: read,
    cancel(reason) {
      cancelCapture();
      return cancelUpstream(reason);
    },
  });
}

function captureChunk(state: CaptureState, chunk: Uint8Array): CaptureState {
  if (state.kind !== "active") return state;
  if (state.bytes + chunk.byteLength > CACHE_CAPTURE_LIMIT) return { kind: "over-budget" };
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  state.chunks.push(copy);
  state.bytes += copy.byteLength;
  return state;
}

function isForwardingState(state: CaptureState): state is Extract<CaptureState, { kind: "active" | "over-budget" }> {
  return state.kind === "active" || state.kind === "over-budget";
}

function capturedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        chunks.length = 0;
        controller.close();
        return;
      }
      delete chunks[index++];
      controller.enqueue(chunk);
    },
    cancel() { chunks.length = 0; },
  });
}

function responseInit(response: Response): ResponseInit {
  return { status: response.status, statusText: response.statusText, headers: response.headers };
}

function createResponseWithBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  return withResponseMetadata(new Response(body, responseInit(response)), response);
}

function withResponseMetadata(response: Response, metadata: Pick<Response, "url" | "redirected">): Response {
  const { url, redirected } = metadata;
  Object.defineProperties(response, {
    url: { configurable: true, value: url },
    redirected: { configurable: true, value: redirected },
    clone: {
      configurable: true, writable: true,
      value(this: Response) { return withResponseMetadata(Response.prototype.clone.call(this), this); },
    },
  });
  return response;
}

function createCachedResponse(response: Response, body: ReadableStream<Uint8Array> | null): Response {
  const headers = new Headers(response.headers);
  // Cache Storage clones native response fields, not JavaScript property overrides.
  headers.set(CACHE_METADATA_HEADER, encodeURIComponent(JSON.stringify({
    url: response.url, redirected: response.redirected, header: headers.get(CACHE_METADATA_HEADER),
  })));
  return new Response(body, { ...responseInit(response), headers });
}

function readCachedMetadata(encoded: string): (Pick<Response, "url" | "redirected"> & { header: string | null }) | undefined {
  try {
    const metadata: unknown = JSON.parse(decodeURIComponent(encoded));
    if (typeof metadata !== "object" || metadata === null) return undefined;
    if (!("url" in metadata) || typeof metadata.url !== "string") return undefined;
    if (!("redirected" in metadata) || typeof metadata.redirected !== "boolean") return undefined;
    if (!("header" in metadata) || metadata.header !== null && typeof metadata.header !== "string") return undefined;
    return { url: metadata.url, redirected: metadata.redirected, header: metadata.header };
  } catch {
    return undefined;
  }
}

function restoreCachedResponse(response: Response): Response {
  const encoded = response.headers.get(CACHE_METADATA_HEADER);
  if (!encoded) return response;
  const metadata = readCachedMetadata(encoded);
  if (!metadata) return response;
  const headers = new Headers(response.headers);
  if (metadata.header === null) headers.delete(CACHE_METADATA_HEADER);
  else headers.set(CACHE_METADATA_HEADER, metadata.header);
  const restored = new Response(response.body, { ...responseInit(response), headers });
  return withResponseMetadata(restored, metadata);
}

function removeQueued(session: CacheSession, entry: QueuedPut): void {
  const index = session.queue.indexOf(entry);
  if (index !== -1) session.queue.splice(index, 1);
  session.queuedByKey.delete(entry.key);
  session.queuedBytes -= entry.bytes;
  if (entry.chunks) entry.chunks.length = 0;
}

function enqueuePut(
  session: CacheSession,
  opened: OpenedCache,
  key: string,
  url: string,
  response: Response,
  chunks: Uint8Array[] | null,
  bytes: number,
): void {
  if (opened.generation !== session.generation) {
    if (chunks) chunks.length = 0;
    return;
  }
  session.lastActivity = Date.now();
  const existing = session.queuedByKey.get(key);
  if (existing) removeQueued(session, existing);
  if (
    session.queue.length >= PUT_QUEUE_ENTRY_LIMIT
    || session.activePutBytes + session.queuedBytes + bytes > PUT_QUEUE_BYTE_LIMIT
  ) {
    if (chunks) chunks.length = 0;
    return;
  }
  const entry: QueuedPut = { key, url, bytes, response, chunks, opened };
  session.queue.push(entry);
  session.queuedByKey.set(key, entry);
  session.queuedBytes += bytes;
  scheduleDrain(session, false);
}

function scheduleDrain(session: CacheSession, yieldMacrotask: boolean): void {
  if (session.activePut || session.drainScheduled || session.queue.length === 0) return;
  session.drainScheduled = true;
  if (yieldMacrotask && typeof setTimeout === "function") {
    setTimeout(() => drainPutQueue(session), 0);
    return;
  }
  void Promise.resolve().then(() => drainPutQueue(session));
}

function drainPutQueue(session: CacheSession): void {
  session.drainScheduled = false;
  if (session.activePut) return;
  const entry = session.queue.shift();
  if (!entry) return;
  session.queuedByKey.delete(entry.key);
  session.queuedBytes -= entry.bytes;
  if (entry.opened.generation !== session.generation) {
    if (entry.chunks) entry.chunks.length = 0;
    scheduleDrain(session, false);
    return;
  }
  session.activePut = true;
  session.activePutBytes = entry.bytes;
  session.lastActivity = Date.now();
  const body = entry.chunks ? capturedBody(entry.chunks) : null;
  const putGeneration = entry.opened.generation;
  void Promise.resolve()
    .then(() => entry.opened.cache.put(entry.url, createCachedResponse(entry.response, body)))
    .then(() => {
      if (putGeneration === session.generation) {
        entry.opened.knownKeys?.add(entry.key);
      }
    })
    .catch(() => {})
    .finally(() => {
      if (entry.chunks) entry.chunks.length = 0;
      session.activePut = false;
      session.activePutBytes = 0;
      session.lastActivity = Date.now();
      scheduleDrain(session, true);
    });
}
