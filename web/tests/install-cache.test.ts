import { expect, test } from "bun:test";
import { clearInstallCache, installFetch } from "../src/net/install-cache.js";

const TARBALL = "application/vnd.bun.install-tarball";
const CACHE_LIMIT = 4 * 1024 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface CacheDouble {
  keys?(): Promise<readonly Request[]>;
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withEnvironment<T>(cache: CacheDouble | undefined, fetcher: (...args: Parameters<typeof fetch>) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  if (cache) {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { async open() { return cache; } } });
  } else {
    Reflect.deleteProperty(globalThis, "caches");
  }
  globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect });
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
}

async function observeBeforeDeadline<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 1000);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function releasePendingResponse(pending: Promise<Response>, reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<void> {
  const response = await pending.catch(() => undefined);
  if (!reader) {
    await response?.body?.cancel();
    return;
  }
  await reader.cancel();
  reader.releaseLock();
}

function requestOptions(signal?: AbortSignal): RequestInit {
  return { method: "GET", signal, headers: { accept: TARBALL } };
}

async function readBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytes(size: number, seed = 0): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(size);
  for (let index = 0; index < result.length; index++) result[index] = (index + seed) % 251;
  return result;
}

function responseBody(payload: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(payload.byteLength);
  new Uint8Array(copy).set(payload);
  return copy;
}

function cacheDouble(overrides: Partial<CacheDouble> = {}): CacheDouble {
  return {
    async match() { return undefined; },
    async put() {},
    ...overrides,
  };
}

test("cold cache miss exposes the first chunk before EOF and cache completion", async () => {
  const eof = deferred<void>();
  const putStarted = deferred<void>();
  const publications: Promise<void>[] = [];
  const first = new TextEncoder().encode("first chunk");
  let cachedBytes = new Uint8Array();
  const cache = cacheDouble({
    put(_url, response) {
      putStarted.resolve();
      const publication = response.arrayBuffer().then(value => { cachedBytes = new Uint8Array(value); });
      publications.push(publication);
      return publication;
    },
  });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      void eof.promise.then(() => controller.close());
    },
  });
  await withEnvironment(cache, async () => new Response(source), async () => {
    const pending = installFetch("https://registry.invalid/pkg.tgz", requestOptions());
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await observeBeforeDeadline(pending, "cache miss withheld response until EOF");
      expect(await Promise.race([putStarted.promise.then(() => "started"), Promise.resolve("not-started")])).toBe("not-started");
      reader = response.body!.getReader();
      const chunk = await observeBeforeDeadline(reader.read(), "cache miss withheld first chunk until EOF");
      expect(chunk.done).toBe(false);
      expect(chunk.value).toEqual(first);
      expect(await Promise.race([putStarted.promise.then(() => "started"), Promise.resolve("not-started")])).toBe("not-started");
      eof.resolve();
      expect((await reader.read()).done).toBe(true);
      await observeBeforeDeadline(putStarted.promise, "cache did not publish after EOF");
      await Promise.all(publications);
      expect(cachedBytes).toEqual(first);
    } finally {
      eof.resolve();
      await releasePendingResponse(pending, reader);
      await Promise.all(publications);
    }
  });
});

test("cache hits and unavailable storage preserve the existing fallthroughs", async () => {
  const hit = new Response("cached");
  let fetchCalls = 0;
  const hitCache = cacheDouble({ async match() { return hit; } });
  await withEnvironment(hitCache, async () => {
    fetchCalls++;
    return new Response("network");
  }, async () => {
    expect(await installFetch("https://registry.invalid/pkg.tgz", requestOptions())).toBe(hit);
  });
  expect(fetchCalls).toBe(0);

  await withEnvironment(undefined, async () => {
    fetchCalls++;
    return new Response("network");
  }, async () => {
    expect(await (await installFetch("https://registry.invalid/pkg.tgz", requestOptions())).text()).toBe("network");
  });
  expect(fetchCalls).toBe(1);
});

test("cache persistence obeys the four MiB boundary and keeps over-budget bodies intact", async () => {
  const sizes = [CACHE_LIMIT - 1, CACHE_LIMIT, CACHE_LIMIT + 1];
  for (const size of sizes) {
    const publications: number[] = [];
    const cache = cacheDouble({
      async put(_url, response) {
        publications.push((await response.arrayBuffer()).byteLength);
      },
    });
    const payload = bytes(size, size % 251);
    await withEnvironment(cache, async () => new Response(responseBody(payload)), async () => {
      const response = await installFetch("https://registry.invalid/pkg.tgz", requestOptions());
      expect((await readBody(response)).byteLength).toBe(size);
    });
    await Bun.sleep(0);
    expect(publications).toEqual(size <= CACHE_LIMIT ? [size] : []);
  }
});

test("cache publication streams owned chunks without assembling a second full body", async () => {
  const published = deferred<Response>();
  const cache = cacheDouble({ async put(_url, response) { published.resolve(response); } });
  const first = bytes(4096, 17);
  const second = bytes(8192, 23);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    },
  });
  await withEnvironment(cache, async () => new Response(source), async () => {
    const response = await installFetch("https://registry.invalid/chunks.tgz", requestOptions());
    const reader = response.body!.getReader();
    try {
      const forwardedFirst = await reader.read();
      forwardedFirst.value!.fill(0);
      const forwardedSecond = await reader.read();
      forwardedSecond.value!.fill(0);
      expect((await reader.read()).done).toBe(true);
    } finally {
      reader.releaseLock();
    }
    const stored = await observeBeforeDeadline(published.promise, "cache publication did not start");
    const storedReader = stored.body!.getReader();
    try {
      expect((await storedReader.read()).value).toEqual(bytes(4096, 17));
      expect((await storedReader.read()).value).toEqual(bytes(8192, 23));
      expect((await storedReader.read()).done).toBe(true);
    } finally {
      await storedReader.cancel();
      storedReader.releaseLock();
    }
  });
});

test("the sequential synthetic corpus records only bounded cache-owned payloads", async () => {
  const corpus = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];
  const published: number[] = [];
  for (const size of corpus) {
    const cache = cacheDouble({
      async put(_url, response) {
        published.push((await response.arrayBuffer()).byteLength);
      },
    });
    const payload = bytes(size, 17);
    await withEnvironment(cache, async () => new Response(responseBody(payload)), async () => {
      expect((await readBody(await installFetch("https://registry.invalid/pkg.tgz", requestOptions()))).byteLength).toBe(size);
    });
    await Bun.sleep(0);
  }
  expect(published).toEqual([64 * 1024, 1024 * 1024]);
});

test("quota failures and non-OK responses never change the downloaded result", async () => {
  let quotaAttempts = 0;
  const quotaCache = cacheDouble({ async put() { quotaAttempts++; throw new Error("quota"); } });
  await withEnvironment(quotaCache, async () => new Response("quota body"), async () => {
    expect(await (await installFetch("https://registry.invalid/quota.tgz", requestOptions())).text()).toBe("quota body");
  });
  await Bun.sleep(0);
  expect(quotaAttempts).toBe(1);

  let failedPublishes = 0;
  const failedCache = cacheDouble({ async put() { failedPublishes++; } });
  await withEnvironment(failedCache, async () => new Response("server failure", { status: 503 }), async () => {
    const response = await installFetch("https://registry.invalid/failure.tgz", requestOptions());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("server failure");
  });
  await Bun.sleep(0);
  expect(failedPublishes).toBe(0);
});

test("empty successful bodies use the original response and publish without wrapping", async () => {
  let published: Response | undefined;
  const cache = cacheDouble({ async put(_url, response) { published = response; } });
  await withEnvironment(cache, async () => new Response(null, { status: 204 }), async () => {
    const response = await installFetch("https://registry.invalid/empty.tgz", requestOptions());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
  await Bun.sleep(0);
  expect(published?.status).toBe(204);
});

test("abort and consumer cancellation release the upstream reader without caching", async () => {
  const pending = deferred<void>();
  let upstreamCancelled = false;
  let puts = 0;
  const cache = cacheDouble({ async put() { puts++; } });
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes(3)); },
    pull() { return pending.promise; },
    cancel() { upstreamCancelled = true; pending.resolve(); },
  });
  const controller = new AbortController();
  await withEnvironment(cache, async () => new Response(source), async () => {
    const response = await installFetch("https://registry.invalid/pkg.tgz", requestOptions(controller.signal));
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(upstreamCancelled).toBe(true);
    expect(puts).toBe(0);
  });
});

test("consumer cancellation releases a pending upstream read", async () => {
  const pending = deferred<void>();
  let upstreamCancelled = false;
  let puts = 0;
  const cache = cacheDouble({ async put() { puts++; } });
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes(2)); },
    pull() { return pending.promise; },
    cancel() { upstreamCancelled = true; pending.resolve(); },
  });
  await withEnvironment(cache, async () => new Response(source), async () => {
    const response = await installFetch("https://registry.invalid/pkg.tgz", requestOptions());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("consumer stopped");
    expect(upstreamCancelled).toBe(true);
    expect(puts).toBe(0);
  });
});

test("an already-aborted signal cancels the source before its first read", async () => {
  let upstreamCancelled = false;
  const cache = cacheDouble();
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes(2)); },
    cancel() { upstreamCancelled = true; },
  });
  const controller = new AbortController();
  controller.abort();
  await withEnvironment(cache, async () => new Response(source), async () => {
    const response = await installFetch("https://registry.invalid/pkg.tgz", requestOptions(controller.signal));
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(upstreamCancelled).toBe(true);
  });
});

test("body errors discard partial captures", async () => {
  let puts = 0;
  const cache = cacheDouble({ async put() { puts++; } });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(4));
      controller.error(new Error("body failed"));
    },
  });
  await withEnvironment(cache, async () => new Response(source), async () => {
    await expect(readBody(await installFetch("https://registry.invalid/pkg.tgz", requestOptions()))).rejects.toThrow("body failed");
    expect(puts).toBe(0);
  });
});

function cloningCache(initial?: Response): { cache: CacheDouble; published: Promise<void> } {
  const published = deferred<void>();
  let stored = initial;
  return {
    published: published.promise,
    cache: cacheDouble({
      async match() { return stored && Response.prototype.clone.call(stored); },
      async put(_url, response) {
        stored = Response.prototype.clone.call(response);
        await response.arrayBuffer();
        published.resolve();
      },
    }),
  };
}

test("guest cache-control no-cache refreshes a warm tarball and replaces the cached bytes", async () => {
  const url = "https://registry.invalid/pkg/-/pkg-1.0.0.tgz";
  const { cache, published } = cloningCache(new Response("old tarball"));
  let networkCalls = 0;
  const controller = new AbortController();
  const refresh: RequestInit = {
    method: "GET",
    signal: controller.signal,
    headers: [["accept", TARBALL], ["accept-encoding", "gzip"], ["cache-control", "no-cache"]],
  };
  await withEnvironment(cache, async (input, options) => {
    networkCalls++;
    expect(input).toBe(url);
    expect(Array.from(new Headers(options?.headers))).toEqual(Array.from(new Headers(refresh.headers)));
    expect(options?.signal).toBe(controller.signal);
    expect(options?.redirect).toBe("manual");
    return new Response("new tarball", { headers: { "content-type": "application/octet-stream", "x-version": "new" } });
  }, async () => {
    expect(await (await installFetch(url, requestOptions())).text()).toBe("old tarball");
    expect(networkCalls).toBe(0);
    const refreshed = await installFetch(url, refresh);
    expect(refreshed.headers.get("x-version")).toBe("new");
    expect(await refreshed.text()).toBe("new tarball");
    await published;
    const hit = await installFetch(url, requestOptions());
    expect(Array.from(hit.headers)).toEqual(Array.from(refreshed.headers));
    expect(await hit.text()).toBe("new tarball");
    expect(networkCalls).toBe(1);
  });
});

test.each([
  { cacheControl: "NO-CACHE", refresh: true },
  { cacheControl: "max-age=60, no-cache", refresh: true },
  { cacheControl: "no-cache\t, max-age=0", refresh: true },
  { cacheControl: "max-age=0", refresh: false },
  { cacheControl: "x-no-cache, no-cacheable", refresh: false },
  { cacheControl: 'extension="no-cache"', refresh: false },
  { cacheControl: 'extension=", no-cache, "', refresh: false },
  { cacheControl: 'extension="a,b", no-cache', refresh: true },
])("tarball refresh recognizes exact Cache-Control directives: $cacheControl", async ({ cacheControl, refresh }) => {
  const { cache, published } = cloningCache(new Response("old tarball"));
  let networkCalls = 0;
  await withEnvironment(cache, async () => {
    networkCalls++;
    return new Response("new tarball");
  }, async () => {
    const options: RequestInit = { method: "GET", headers: { accept: TARBALL, "cache-control": cacheControl } };
    const response = await installFetch("https://registry.invalid/pkg.tgz", options);
    expect(await response.text()).toBe(refresh ? "new tarball" : "old tarball");
    if (refresh) await published;
    expect(networkCalls).toBe(refresh ? 1 : 0);
  });
});

test("authenticated refresh forwards credentials without reading or replacing the shared cache", async () => {
  let cacheOperations = 0;
  const cache = cacheDouble({
    async match() { cacheOperations++; return new Response("public tarball"); },
    async put() { cacheOperations++; },
  });
  const options: RequestInit = {
    method: "GET",
    headers: { accept: TARBALL, "cache-control": "no-cache", authorization: "Bearer fixture-token" },
  };
  await withEnvironment(cache, async (_input, forwarded) => {
    expect(Array.from(new Headers(forwarded?.headers))).toEqual(Array.from(new Headers(options.headers)));
    return new Response("private tarball");
  }, async () => {
    const response = await installFetch("https://registry.invalid/private.tgz", options);
    expect(await response.text()).toBe("private tarball");
    expect(cacheOperations).toBe(0);
  });
});

async function expectResponseMetadata(response: Response, expected: Response): Promise<void> {
  const clone = response.clone();
  const secondClone = clone.clone();
  try {
    expect(response.url).toBe(expected.url);
    expect(response.redirected).toBe(expected.redirected);
    expect(response.status).toBe(expected.status);
    expect(response.statusText).toBe(expected.statusText);
    expect(Array.from(response.headers)).toEqual(Array.from(expected.headers));
    expect(clone.url).toBe(expected.url);
    expect(clone.redirected).toBe(expected.redirected);
    expect(secondClone.url).toBe(expected.url);
    expect(secondClone.redirected).toBe(expected.redirected);
    expect(await Promise.all([response.text(), clone.text(), secondClone.text()])).toEqual(["metadata body", "metadata body", "metadata body"]);
  } finally {
    await Promise.allSettled([response.body?.cancel(), clone.body?.cancel(), secondClone.body?.cancel()]);
  }
}

test("native response URL survives a native-cloned cache fill and hit", async () => {
  const network = await fetch("data:text/plain,metadata%20body");
  expect(network.url).not.toBe("");
  const expected = network.clone();
  const { cache, published } = cloningCache();
  let networkCalls = 0;
  await withEnvironment(cache, async () => { networkCalls++; return network; }, async () => {
    const cold = await installFetch("https://registry.invalid/pkg.tgz", requestOptions());
    expect(cold.url).toBe(expected.url);
    expect(await cold.text()).toBe("metadata body");
    await published;
    await expectResponseMetadata(await installFetch("https://registry.invalid/pkg.tgz", requestOptions()), expected);
  });
  expect(networkCalls).toBe(1);
  await expected.body?.cancel();
});

test("status, redirect metadata and colliding headers survive native cache clones", async () => {
  const network = new Response("metadata body", {
    status: 201, statusText: "Created", headers: { "x-test": "kept", "x-bun-wasm-cache-metadata": "upstream-value" },
  });
  Object.defineProperties(network, {
    url: { configurable: true, value: "https://cdn.invalid/final.tgz" },
    redirected: { configurable: true, value: true },
  });
  const { cache, published } = cloningCache();
  await withEnvironment(cache, async () => network, async () => {
    await expectResponseMetadata(await installFetch("https://registry.invalid/pkg.tgz", requestOptions()), network);
    await published;
    await expectResponseMetadata(await installFetch("https://registry.invalid/pkg.tgz", requestOptions()), network);
  });
});

test("empty cached responses preserve null bodies and metadata through native clones", async () => {
  const network = new Response(null, { status: 204, headers: { "x-bun-wasm-cache-metadata": "upstream-value" } });
  Object.defineProperty(network, "url", { value: "https://cdn.invalid/empty.tgz" });
  const { cache, published } = cloningCache();
  let networkCalls = 0;
  await withEnvironment(cache, async () => { networkCalls++; return network; }, async () => {
    expect((await installFetch("https://registry.invalid/pkg.tgz", requestOptions())).body).toBeNull();
    await published;
    const hit = await installFetch("https://registry.invalid/pkg.tgz", requestOptions());
    expect(hit.body).toBeNull();
    expect(hit.status).toBe(204);
    expect(hit.url).toBe(network.url);
    expect(hit.clone().url).toBe(network.url);
    expect(Array.from(hit.headers)).toEqual(Array.from(network.headers));
  });
  expect(networkCalls).toBe(1);
});

test("cache hits with unrelated metadata headers remain unchanged", async () => {
  const hit = new Response("cached", { headers: { "x-bun-wasm-cache-metadata": "ordinary-header-value" } });
  let networkCalls = 0;
  await withEnvironment(cacheDouble({ async match() { return hit; } }), async () => {
    networkCalls++;
    return new Response("unexpected network");
  }, async () => {
    expect(await installFetch("https://registry.invalid/pkg.tgz", requestOptions())).toBe(hit);
    expect(await hit.text()).toBe("cached");
  });
  expect(networkCalls).toBe(0);
});

test("authentication, metadata and ordinary requests bypass tarball persistence", async () => {
  let opens = 0;
  let fetchCalls = 0;
  const cache = cacheDouble();
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { async open() { opens++; return cache; } } });
  globalThis.fetch = Object.assign(async () => { fetchCalls++; return new Response("ok"); }, { preconnect: originalFetch.preconnect });
  try {
    expect(await (await installFetch("https://registry.invalid/pkg.tgz", { ...requestOptions(), headers: { accept: TARBALL, authorization: "Bearer token" } })).text()).toBe("ok");
    expect(await (await installFetch("https://registry.invalid/metadata", { ...requestOptions(), headers: { accept: "application/vnd.npm.install-v1+json" } })).text()).toBe("ok");
    expect(await (await installFetch("https://registry.invalid/ordinary", { method: "GET", headers: { accept: "text/plain" } })).text()).toBe("ok");
    expect(opens).toBe(0);
    expect(fetchCalls).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});

interface IndexedCacheStorage {
  storage: { open(name: string): Promise<CacheDouble>; delete(name: string): Promise<boolean> };
  opens: string[];
  deletes: string[];
  keysCalls: number;
  matchCalls: string[];
  putCalls: string[];
  stored: Map<string, Response>;
}

function indexedCacheStorage(initial: Record<string, Response> = {}, overrides: Partial<CacheDouble> = {}): IndexedCacheStorage {
  const stored = new Map<string, Response>(Object.entries(initial).map(([url, response]) => [new URL(url).href, response]));
  const opens: string[] = [];
  const deletes: string[] = [];
  const matchCalls: string[] = [];
  const putCalls: string[] = [];
  const state: IndexedCacheStorage = {
    opens,
    deletes,
    keysCalls: 0,
    matchCalls,
    putCalls,
    stored,
    storage: {
      async open(name: string) {
        opens.push(name);
        return cache;
      },
      async delete(name: string) {
        deletes.push(name);
        stored.clear();
        return true;
      },
    },
  };
  const cache: CacheDouble = {
    async keys() {
      state.keysCalls++;
      return Array.from(stored.keys(), url => new Request(url));
    },
    async match(url: string) {
      matchCalls.push(url);
      const hit = stored.get(new URL(url).href);
      return hit ? Response.prototype.clone.call(hit) : undefined;
    },
    async put(url: string, response: Response) {
      putCalls.push(url);
      stored.set(new URL(url).href, Response.prototype.clone.call(response));
      await response.arrayBuffer();
    },
    ...overrides,
  };
  return state;
}

async function withStorage<T>(
  storage: { open(name: string): Promise<CacheDouble>; delete?(name: string): Promise<boolean> },
  fetcher: (...args: Parameters<typeof fetch>) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: storage });
  globalThis.fetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect });
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
}

test("cold misses skip cache.match once cache.keys loads and reuse the opened cache", async () => {
  const env = indexedCacheStorage();
  let networkCalls = 0;
  await withStorage(env.storage, async (input) => {
    networkCalls++;
    return new Response(`body:${String(input)}`);
  }, async () => {
    const urls = Array.from({ length: 12 }, (_, index) => `https://registry.invalid/pkg-${index}.tgz`);
    const bodies = await Promise.all(urls.map(async url => (await installFetch(url, requestOptions())).text()));
    expect(bodies).toEqual(urls.map(url => `body:${url}`));
    expect(env.opens).toEqual(["bun-wasm-install-v1"]);
    expect(env.keysCalls).toBe(1);
    expect(env.matchCalls).toEqual([]);
    expect(networkCalls).toBe(urls.length);
  });
});

test("warm hits match normalized URLs and newly persisted cold misses become warm hits", async () => {
  const warmUrl = "https://registry.invalid/warm.tgz";
  const coldUrl = "https://registry.invalid/cold.tgz";
  const coldPublished = deferred<void>();
  const env = indexedCacheStorage({ [warmUrl]: new Response("warm body") }, {
    async put(url, response) {
      env.putCalls.push(url);
      env.stored.set(new URL(url).href, Response.prototype.clone.call(response));
      await response.arrayBuffer();
      coldPublished.resolve();
    },
  });
  let networkCalls = 0;
  await withStorage(env.storage, async () => {
    networkCalls++;
    return new Response("cold body");
  }, async () => {
    const warm = await installFetch("https://REGISTRY.INVALID:443/dir/../warm.tgz", requestOptions());
    expect(await warm.text()).toBe("warm body");
    expect(env.matchCalls).toEqual(["https://REGISTRY.INVALID:443/dir/../warm.tgz"]);
    expect(networkCalls).toBe(0);

    const cold = await installFetch(coldUrl, requestOptions());
    expect(await cold.text()).toBe("cold body");
    expect(env.matchCalls).toEqual(["https://REGISTRY.INVALID:443/dir/../warm.tgz"]);
    expect(networkCalls).toBe(1);

    await observeBeforeDeadline(coldPublished.promise, "cold tarball was not persisted");
    const hit = await installFetch(coldUrl, requestOptions());
    expect(await hit.text()).toBe("cold body");
    expect(networkCalls).toBe(1);
    expect(env.matchCalls).toEqual(["https://REGISTRY.INVALID:443/dir/../warm.tgz", coldUrl]);
  });
});

test("keys enumeration failures fall back to cache.match without breaking warm hits", async () => {
  const hit = new Response("fallback cached");
  const matchCalls: string[] = [];
  const cache = cacheDouble({
    async keys() { throw new Error("keys unavailable"); },
    async match(url) { matchCalls.push(url); return hit; },
  });
  let networkCalls = 0;
  await withEnvironment(cache, async () => { networkCalls++; return new Response("network"); }, async () => {
    expect(await installFetch("https://registry.invalid/fallback.tgz", requestOptions())).toBe(hit);
    expect(matchCalls).toEqual(["https://registry.invalid/fallback.tgz"]);
    expect(networkCalls).toBe(0);
  });
});

test("evicted keys drop from the index and no-cache refresh skips cache.match", async () => {
  const url = "https://registry.invalid/evicted.tgz";
  const env = indexedCacheStorage({ [url]: new Response("stale") });
  let status = 503;
  await withStorage(env.storage, async () => new Response("network", { status }), async () => {
    // Simulate external eviction after keys() already reported the URL.
    const originalKeys = env.storage.open;
    let openedOnce = false;
    env.storage.open = async (name) => {
      const opened = await originalKeys(name);
      if (!openedOnce) {
        openedOnce = true;
        const originalKeysFn = opened.keys!;
        opened.keys = async () => {
          const list = await originalKeysFn();
          env.stored.clear();
          return list;
        };
      }
      return opened;
    };

    expect((await installFetch(url, requestOptions())).status).toBe(503);
    expect(env.matchCalls).toEqual([url]);
    // After the miss evicted the key from the index, a second miss skips cache.match.
    expect((await installFetch(url, requestOptions())).status).toBe(503);
    expect(env.matchCalls).toEqual([url]);

    // Refresh also bypasses cache.match even when the key is known.
    status = 200;
    const refreshed = await installFetch(url, { method: "GET", headers: { accept: TARBALL, "cache-control": "no-cache" } });
    expect(await refreshed.text()).toBe("network");
    expect(env.matchCalls).toEqual([url]);
  });
});

test("background cache.put writes stay serialized at concurrency 1 and survive failures", async () => {
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  const started: string[] = [];
  const startedSignals = gates.map(() => deferred<void>());
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  const allDone = deferred<void>();
  const env = indexedCacheStorage({}, {
    async put(url, response) {
      const index = started.length;
      started.push(url);
      startedSignals[index]!.resolve();
      active++;
      peak = Math.max(peak, active);
      try {
        await response.arrayBuffer();
        await gates[index]!.promise;
        if (index === 1) throw new Error("quota error on second put");
        completed.push(url);
      } finally {
        active--;
        if (started.length === gates.length && active === 0) allDone.resolve();
      }
    },
  });
  await withStorage(env.storage, async (input) => new Response(`payload:${String(input)}`), async () => {
    const urls = gates.map((_, index) => `https://registry.invalid/serial-${index}.tgz`);
    for (const url of urls) {
      expect(await (await installFetch(url, requestOptions())).text()).toBe(`payload:${url}`);
    }
    await observeBeforeDeadline(startedSignals[0]!.promise, "first put did not start");
    await Bun.sleep(10);
    expect(started).toEqual([urls[0]!]);
    expect(peak).toBe(1);

    for (let index = 0; index < gates.length; index++) {
      gates[index]!.resolve();
      if (index + 1 < gates.length) {
        await observeBeforeDeadline(startedSignals[index + 1]!.promise, `put ${index + 1} did not start`);
      }
    }
    await observeBeforeDeadline(allDone.promise, "serial puts did not drain");
    expect(peak).toBe(1);
    expect(started).toEqual(urls);
    expect(completed).toEqual([urls[0]!, urls[2]!, urls[3]!]);
  });
});

test("put queue bounds total buffered bytes and drops overflow without stalling downloads", async () => {
  const chunkSize = 3 * 1024 * 1024;
  const firstPutStarted = deferred<void>();
  const releaseFirstPut = deferred<void>();
  const putUrls: string[] = [];
  const secondPutDone = deferred<void>();
  const env = indexedCacheStorage({}, {
    async put(url, response) {
      putUrls.push(url);
      if (putUrls.length === 1) {
        firstPutStarted.resolve();
        await releaseFirstPut.promise;
      }
      await response.arrayBuffer();
      if (putUrls.length === 2) secondPutDone.resolve();
    },
  });
  const payload = bytes(chunkSize, 5);
  await withStorage(env.storage, async () => new Response(responseBody(payload)), async () => {
    const urls = [
      "https://registry.invalid/big-0.tgz",
      "https://registry.invalid/big-1.tgz",
      "https://registry.invalid/big-2.tgz",
    ];
    // First 3 MiB response starts in-flight put (3 MiB <= 8 MiB).
    expect((await readBody(await installFetch(urls[0]!, requestOptions()))).byteLength).toBe(chunkSize);
    await observeBeforeDeadline(firstPutStarted.promise, "first big put did not start");
    // Second 3 MiB response fits in the 8 MiB budget (3 + 3 = 6 MiB <= 8 MiB).
    expect((await readBody(await installFetch(urls[1]!, requestOptions()))).byteLength).toBe(chunkSize);
    // Third 3 MiB response exceeds 8 MiB (3 + 3 + 3 = 9 MiB > 8 MiB): download still completes cleanly, put is dropped.
    expect((await readBody(await installFetch(urls[2]!, requestOptions()))).byteLength).toBe(chunkSize);

    releaseFirstPut.resolve();
    await observeBeforeDeadline(secondPutDone.promise, "second big put did not drain");
    await Bun.sleep(15);
    expect(putUrls).toEqual([urls[0]!, urls[1]!]);
  });
});

test("clearInstallCache drops queued puts, resets the key index, and deletes the cache", async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const putUrls: string[] = [];
  const env = indexedCacheStorage({}, {
    async put(url, response) {
      putUrls.push(url);
      if (putUrls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      await response.arrayBuffer();
    },
  });
  let networkCalls = 0;
  await withStorage(env.storage, async (input) => {
    networkCalls++;
    return new Response(`fresh:${String(input)}`);
  }, async () => {
    const firstUrl = "https://registry.invalid/clear-0.tgz";
    const secondUrl = "https://registry.invalid/clear-1.tgz";
    expect(await (await installFetch(firstUrl, requestOptions())).text()).toBe(`fresh:${firstUrl}`);
    await observeBeforeDeadline(firstStarted.promise, "first put did not start");
    expect(await (await installFetch(secondUrl, requestOptions())).text()).toBe(`fresh:${secondUrl}`);

    expect(await clearInstallCache()).toBe(true);
    expect(env.deletes).toEqual(["bun-wasm-install-v1"]);

    releaseFirst.resolve();
    await Bun.sleep(15);
    // Queued second put was dropped by clearInstallCache, and first put did not populate the next session.
    expect(putUrls).toEqual([firstUrl]);

    expect(await (await installFetch(firstUrl, requestOptions())).text()).toBe(`fresh:${firstUrl}`);
    expect(env.opens).toEqual(["bun-wasm-install-v1", "bun-wasm-install-v1"]);
    expect(env.matchCalls).toEqual([]);
    expect(networkCalls).toBe(3);
  });
});

test("slow streaming body finishing after an idle session refresh still updates the active key index", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const firstBodyChunk = deferred<void>();
  const firstPutDone = deferred<void>();
  const env = indexedCacheStorage({}, {
    async put(url, response) {
      env.putCalls.push(url);
      env.stored.set(new URL(url).href, Response.prototype.clone.call(response));
      await response.arrayBuffer();
      if (url.endsWith("/slow.tgz")) firstPutDone.resolve();
    },
  });
  let networkCalls = 0;
  try {
    await withStorage(env.storage, async (input) => {
      networkCalls++;
      const url = String(input);
      if (url.endsWith("/slow.tgz") && networkCalls === 1) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            await firstBodyChunk.promise;
            controller.enqueue(new TextEncoder().encode("slow-tarball-bytes"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      if (url.endsWith("/other.tgz")) return new Response("other-bytes", { status: 200 });
      return new Response("upstream down", { status: 503 });
    }, async () => {
      const slowUrl = "https://registry.invalid/slow.tgz";
      const otherUrl = "https://registry.invalid/other.tgz";
      // Headers for slow.tgz arrive first; its body is still streaming.
      const slowResponse = await installFetch(slowUrl, requestOptions());
      const slowTextPromise = slowResponse.text();

      // Advance past the 2 s idle refresh window and trigger another request that rebuilds knownKeys.
      clock += 2_500;
      expect(await (await installFetch(otherUrl, requestOptions())).text()).toBe("other-bytes");

      // Now finish streaming slow.tgz and wait for its background cache.put() to complete.
      firstBodyChunk.resolve();
      expect(await slowTextPromise).toBe("slow-tarball-bytes");
      await observeBeforeDeadline(firstPutDone.promise, "slow.tgz put did not complete");
      await Bun.sleep(10);

      // A subsequent request for slow.tgz must hit the cache instead of skipping cache.match() and getting 503.
      const hit = await installFetch(slowUrl, requestOptions());
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe("slow-tarball-bytes");
      expect(networkCalls).toBe(2);
    });
  } finally {
    Date.now = realNow;
  }
});

test("clearInstallCache broadcasts invalidation so another tab drops its cached handle immediately", async () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  class FakeBroadcastChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    private closed = false;
    constructor(public readonly name: string) {
      listeners.add(this.dispatch);
    }
    private dispatch = (event: MessageEvent) => {
      if (!this.closed) this.onmessage?.(event);
    };
    postMessage(data: unknown) {
      for (const listener of Array.from(listeners)) {
        if (listener !== this.dispatch) listener(new MessageEvent("message", { data }));
      }
    }
    close() {
      this.closed = true;
      listeners.delete(this.dispatch);
    }
  }
  const originalBC = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: FakeBroadcastChannel });
  try {
    // Tab B holds an open CacheStorage session with one warm entry.
    const tabB = indexedCacheStorage({ "https://registry.invalid/cross.tgz": new Response("stale-tab-b") });
    const tabA = indexedCacheStorage();
    await withStorage(tabB.storage, async () => new Response("unexpected"), async () => {
      expect(await (await installFetch("https://registry.invalid/cross.tgz", requestOptions())).text()).toBe("stale-tab-b");
      expect(tabB.opens).toHaveLength(1);
    });
    // Tab A clears the cache, broadcasting invalidation to Tab B before 2 s have elapsed.
    await withStorage(tabA.storage, async () => new Response("unused"), async () => {
      expect(await clearInstallCache()).toBe(true);
    });
    tabB.stored.clear();
    // Tab B must reopen the cache and skip cache.match on the now-empty cache instead of reusing the deleted handle.
    await withStorage(tabB.storage, async () => new Response("fresh-after-clear"), async () => {
      expect(await (await installFetch("https://registry.invalid/cross.tgz", requestOptions())).text()).toBe("fresh-after-clear");
      expect(tabB.opens).toHaveLength(2);
      expect(tabB.matchCalls).toHaveLength(1);
    });
  } finally {
    if (originalBC) Object.defineProperty(globalThis, "BroadcastChannel", originalBC);
    else Reflect.deleteProperty(globalThis, "BroadcastChannel");
  }
});
