import { expect, test } from "bun:test";
import { installFetch } from "../src/net/install-cache.js";

const TARBALL = "application/vnd.bun.install-tarball";
const CACHE_LIMIT = 4 * 1024 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface CacheDouble {
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

async function withEnvironment<T>(cache: CacheDouble | undefined, fetcher: () => Promise<Response>, run: () => Promise<T>): Promise<T> {
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

function bytes(size: number, seed = 0): Uint8Array {
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
  const putFinished = deferred<void>();
  const first = new TextEncoder().encode("first chunk");
  let cachedBytes = new Uint8Array();
  const cache = cacheDouble({
    async put(_url, response) {
      putStarted.resolve();
      cachedBytes = new Uint8Array(await response.arrayBuffer());
      putFinished.resolve();
    },
  });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      eof.promise.then(() => controller.close());
    },
  });
  await withEnvironment(cache, async () => new Response(source), async () => {
    const response = await installFetch("https://registry.invalid/pkg.tgz", requestOptions());
    expect(await Promise.race([putStarted.promise.then(() => "started"), Promise.resolve("not-started")])).toBe("not-started");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value).toEqual(first);
    expect(await Promise.race([putStarted.promise.then(() => "started"), Promise.resolve("not-started")])).toBe("not-started");
    eof.resolve();
    expect((await reader.read()).done).toBe(true);
    await putFinished.promise;
    expect(cachedBytes).toEqual(first);
    await reader.cancel();
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

test("response metadata survives body forwarding and cache publication", async () => {
  const finalUrl = "https://cdn.invalid/final.tgz";
  let published: Response | undefined;
  const cache = cacheDouble({ async put(_url, response) { published = response; await response.arrayBuffer(); } });
  await withEnvironment(cache, async () => {
    const response = new Response(responseBody(bytes(5)), { status: 201, statusText: "Created", headers: { "x-test": "kept" } });
    Object.defineProperties(response, {
      url: { configurable: true, value: finalUrl },
      redirected: { configurable: true, value: true },
    });
    return response;
  }, async () => {
    const response = await installFetch("https://registry.invalid/pkg.tgz", requestOptions());
    expect(response.url).toBe(finalUrl);
    expect(response.redirected).toBe(true);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-test")).toBe("kept");
    expect((await readBody(response)).byteLength).toBe(5);
  });
  await Bun.sleep(0);
  expect(published?.url).toBe(finalUrl);
  expect(published?.redirected).toBe(true);
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
