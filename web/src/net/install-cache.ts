import { packageFetch } from "./package-fetch.js";

const METADATA = "application/vnd.npm.install-v1+json";
const TARBALL = "application/vnd.bun.install-tarball";
const CACHE = "bun-wasm-install-v1";
const CACHE_METADATA_HEADER = "x-bun-wasm-cache-metadata";
const CACHE_CAPTURE_LIMIT = 4 * 1024 * 1024;
const BODY_FORBIDDEN_STATUS = new Set([204, 205, 304]);

type CaptureState =
  | { kind: "active"; chunks: Uint8Array[]; bytes: number }
  | { kind: "completed"; bytes: ArrayBuffer }
  | { kind: "cancelled" }
  | { kind: "over-budget" };

/** Cache npm downloads across playground runs, without caching ordinary user fetches. */
export async function installFetch(url: string, options: RequestInit): Promise<Response> {
  const header = new Headers(options.headers).get("accept") ?? "";
  const accept = header.split(";", 1)[0];
  const refresh = header.includes("; no-cache");
  if (options.method !== "GET" || accept !== METADATA && accept !== TARBALL) {
    return fetch(url, options);
  }
  if (accept === METADATA || typeof caches === "undefined" || new Headers(options.headers).has("authorization")) {
    return packageFetch(url, options);
  }
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE);
    const cached = await cache.match(url);
    if (cached && !refresh) return restoreCachedResponse(cached);
  } catch {
    // Private browsing and exhausted quotas must not prevent an install.
  }
  const response = await packageFetch(url, options);
  if (!response.ok || !cache) return response;
  return prepareCachedResponse(response, cache, url, options.signal);
}

function prepareCachedResponse(response: Response, cache: Cache, url: string, signal: AbortSignal | null | undefined): Response {
  if (!response.body) {
    publishEmptyResponse(cache, url, response);
    return response;
  }
  if (BODY_FORBIDDEN_STATUS.has(response.status)) return response;
  const body = createForwardingBody(response, cache, url, signal);
  return createResponseWithBody(response, body);
}

function createForwardingBody(response: Response, cache: Cache, url: string, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
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
    if (!cancelled) {
      cancelled = true;
      await reader.cancel(reason).catch(() => {});
    }
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
    const completed = completeCapture(state);
    if (completed) state = { kind: "completed", bytes: completed };
    release();
    controller?.close();
    if (state.kind === "completed") publishCapturedResponse(cache, url, response, state.bytes);
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

function completeCapture(state: CaptureState): ArrayBuffer | undefined {
  if (state.kind !== "active") return undefined;
  const bytes = new ArrayBuffer(state.bytes);
  const target = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of state.chunks) {
    target.set(chunk, offset);
    offset += chunk.byteLength;
  }
  state.chunks.length = 0;
  return bytes;
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

function createCachedResponse(response: Response, bytes: ArrayBuffer | null): Response {
  const headers = new Headers(response.headers);
  // Cache Storage clones native response fields, not JavaScript property overrides.
  headers.set(CACHE_METADATA_HEADER, encodeURIComponent(JSON.stringify({
    url: response.url, redirected: response.redirected, header: headers.get(CACHE_METADATA_HEADER),
  })));
  return new Response(bytes, { ...responseInit(response), headers });
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

function publishEmptyResponse(cache: Cache, url: string, response: Response): void {
  void Promise.resolve().then(() => cache.put(url, createCachedResponse(response, null))).catch(() => {});
}

function publishCapturedResponse(cache: Cache, url: string, response: Response, bytes: ArrayBuffer): void {
  void Promise.resolve().then(() => cache.put(url, createCachedResponse(response, bytes))).catch(() => {});
}
