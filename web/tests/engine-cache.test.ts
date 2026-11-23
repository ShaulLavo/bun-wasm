import { expect, test } from "bun:test";
import { WasmMissing, loadEngineProgram, loadWasm } from "../src/engine-loader";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const build = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");

type Host = "negotiating" | "plain";

/**
 * A negotiating host (site/worker.ts, web/serve.ts) answers the logical URL with a native
 * Content-Encoding, which fetch has already decoded. A plain static host has only the `.gz` twin.
 */
function guestHost(kind: Host, fetched: string[] = [], bytes: Uint8Array<ArrayBuffer> = wasm, headers: Record<string, string> = {}) {
  return async (url: string) => {
    fetched.push(String(url));
    if (new URL(String(url), "https://engine-cache.test/").pathname.endsWith(".gz")) return new Response(Bun.gzipSync(bytes));
    if (kind === "plain") return new Response(null, { status: 404 });
    return new Response(bytes, { headers: { "content-type": "application/wasm", "content-encoding": "br", ...headers } });
  };
}

async function withCache(check: (cache: {
  started: Promise<void>;
  release(error?: Error): void;
  load(): ReturnType<typeof loadWasm>;
  stored(): Promise<Uint8Array>;
}) => Promise<void>) {
  const names = ["location", "caches", "fetch", "__bunwasmBuilds"];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Error | undefined>();
  const stored = Promise.withResolvers<Uint8Array>();
  const cache = {
    async put(_url: string, response: Response) {
      started.resolve();
      const error = await release.promise;
      if (error) throw error;
      stored.resolve(new Uint8Array(await response.arrayBuffer()));
    },
  };
  const values = {
    location: new URL("https://engine-cache.test/"),
    caches: { match: async () => undefined, open: async () => cache },
    fetch: guestHost("negotiating"),
    __bunwasmBuilds: { "bun-tools.wasm": build },
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    await check({ started: started.promise, release: release.resolve, load: () => loadWasm("bun-tools.wasm", () => {}), stored: () => stored.promise });
  } finally {
    release.resolve();
    for (const [name, descriptor] of previous) restore(name, descriptor);
  }
}

function restore(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

test("verified engine preparation does not wait for optional cache persistence", () => withCache(async cache => {
  const loading = cache.load();
  await cache.started;
  try {
    const loaded = await Promise.race([loading, Bun.sleep(1000).then(() => { throw new Error("Verified engine is blocked on optional CacheStorage.put"); })]);
    expect(loaded.module).toBeInstanceOf(WebAssembly.Module);
    expect(loaded.build).toBe(build);
    expect(loaded.size).toBe(wasm.length);
  } finally { cache.release(); await loading; }
  expect(await cache.stored()).toEqual(wasm);
}));

test("engine integrity failure cannot publish bytes to the cache", () => withCache(async cache => {
  Reflect.set(globalThis, "__bunwasmBuilds", { "bun-tools.wasm": "0".repeat(64) });
  let stored = false;
  void cache.started.then(() => { stored = true; });
  await expect(cache.load()).rejects.toThrow("integrity mismatch");
  expect(stored).toBe(false);
}));

test("optional cache storage failure preserves the prepared module", () => withCache(async cache => {
  cache.release(new Error("storage unavailable"));
  const loaded = await cache.load();
  expect(loaded.module).toBeInstanceOf(WebAssembly.Module);
  expect(loaded.build).toBe(build);
}));

/** An in-memory CacheStorage that records lookups; `stored` settles after each completed put. */
function memoryCaches() {
  const entries = new Map<string, { headers: Headers; bytes: Uint8Array }>();
  const lookups: string[] = [];
  let stored = Promise.withResolvers<void>();
  const caches = {
    async match(url: string) {
      lookups.push(url);
      const entry = entries.get(url);
      return entry && new Response(entry.bytes.slice(), { headers: entry.headers });
    },
    async open() {
      return {
        async put(url: string, response: Response) {
          entries.set(url, { headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) });
          stored.resolve();
        },
        async delete(url: string) { return entries.delete(url); },
      };
    },
  };
  return {
    caches, entries, lookups,
    /** Waits for the next put, then a turn for the loader's marker write after it. */
    async stored() { await stored.promise; stored = Promise.withResolvers<void>(); await Bun.sleep(1); },
  };
}

/** Replaces the page globals a loader reads; the returned function puts the originals back. */
function pageGlobals(values: Record<string, unknown>): () => void {
  const previous = Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => { for (const [name, descriptor] of previous) restore(name, descriptor); };
}

const storageHosts = (["without", "with"] as const).flatMap(storage => (["negotiating", "plain"] as const).map(host => [storage, host] as const));

for (const [storage, host] of storageHosts) test(`the Browser engine's second page load compiles from the engine cache ${storage} localStorage from a ${host} host`, async () => {
  const cache = memoryCaches();
  const fetched: string[] = [];
  const marks = new Map<string, string>();
  const restoreGlobals = pageGlobals({
    location: new URL("https://engine-cache.test/app/"),
    localStorage: storage === "with" ? {
      getItem: (key: string) => marks.get(key) ?? null,
      setItem: (key: string, value: string) => { marks.set(key, value); },
      removeItem: (key: string) => { marks.delete(key); },
    } : undefined,
    caches: cache.caches,
    fetch: guestHost(host, fetched),
    __bunwasmBuilds: { "bun-browser.wasm": build },
  });
  try {
    const key = "https://engine-cache.test/app/bun-browser.wasm";
    const first = await loadEngineProgram("browser", "split", () => {});
    expect(first.build).toBe(build);
    const logical = `https://engine-cache.test/app/bun-browser.wasm?v=${build}`;
    const requests = host === "negotiating" ? [logical] : [logical, `https://engine-cache.test/app/bun-browser.wasm.gz?v=${build}`];
    expect(fetched.map(url => new URL(url, location.href).href)).toEqual(requests);
    // A first visit with a usable marker store never waits on CacheStorage before downloading.
    expect(cache.lookups).toEqual(storage === "with" ? [] : [key]);
    await cache.stored();
    expect(cache.entries.get(key)?.headers.get("x-bunwasm-build")).toBe(build);
    if (storage === "with") expect(marks.get(`bunwasm-engine-cache:${key}`)).toBe(build);
    const second = await loadEngineProgram("browser", "split", () => {});
    expect(second.module).toBeInstanceOf(WebAssembly.Module);
    expect(second.size).toBe(wasm.length);
    expect(fetched).toHaveLength(requests.length);
    expect(cache.lookups.at(-1)).toBe(key);
  } finally {
    restoreGlobals();
  }
});

const lostMarkerCases = [
  { name: "Browser engine", asset: "bun-browser.wasm", load: () => loadEngineProgram("browser", "split", () => {}) },
  { name: "verified tools", asset: "bun-tools.wasm", load: () => loadWasm("bun-tools.wasm", () => {}) },
] as const;

/** How the network fails on the last load: before any headers, or after them, mid-body. */
const failures = {
  headers: async (): Promise<Response> => { throw new TypeError("Failed to fetch"); },
  body: async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("network error")); } })),
};

const failureCases = lostMarkerCases.flatMap(entry => (["headers", "body"] as const).map(failure => ({ ...entry, failure })));

for (const { name, asset, load, failure } of failureCases) test(`${name}: a marker that cannot be written still leaves the cached bytes when the network fails at the ${failure}`, async () => {
  const key = `https://engine-cache.test/app/${asset}`;
  const cache = memoryCaches();
  const marks = new Map<string, string>([[`bunwasm-engine-cache:${key}`, "0".repeat(64)]]);
  let online = true;
  let fetched = 0;
  const restoreGlobals = pageGlobals({
    location: new URL("https://engine-cache.test/app/"),
    // A full localStorage: reads work, writes throw, removal still works.
    localStorage: {
      getItem: (item: string) => marks.get(item) ?? null,
      setItem: () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); },
      removeItem: (item: string) => { marks.delete(item); },
    },
    caches: cache.caches,
    fetch: async (url: string) => {
      fetched++;
      if (!online) return failures[failure]();
      return guestHost("negotiating")(url);
    },
    __bunwasmBuilds: { [asset]: build },
  });
  try {
    await load();
    await cache.stored();
    expect(cache.entries.get(key)?.headers.get("x-bunwasm-build")).toBe(build);
    // The stale marker is gone rather than naming a build the cache no longer holds.
    expect(marks.size).toBe(0);
    await load();
    expect(cache.lookups).toEqual([]);
    online = false;
    const offline = await load();
    expect(offline.module).toBeInstanceOf(WebAssembly.Module);
    expect(offline.build).toBe(build);
    expect(cache.lookups).toEqual([key]);
    // Offline, the logical URL and then its `.gz` twin fail before the cached bytes serve.
    expect(fetched).toBe(4);
  } finally {
    restoreGlobals();
  }
});

for (const { name, asset, load } of lostMarkerCases) test(`${name}: a missing asset is reported as missing even with cached bytes`, async () => {
  const key = `https://engine-cache.test/app/${asset}`;
  const cache = memoryCaches();
  cache.entries.set(key, { headers: new Headers({ "x-bunwasm-build": build, "content-type": "application/wasm" }), bytes: wasm });
  const restoreGlobals = pageGlobals({
    location: new URL("https://engine-cache.test/app/"),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    caches: cache.caches,
    fetch: async () => new Response(null, { status: 404 }),
    __bunwasmBuilds: { [asset]: build },
  });
  try {
    const outcome = await load().then(() => () => {}, (error: unknown) => () => { throw error; });
    expect(outcome).toThrow(WasmMissing);
    expect(cache.lookups).toEqual([]);
  } finally {
    restoreGlobals();
  }
});

const cancelledTwinCases = lostMarkerCases.flatMap(entry => (["held index page", "missing logical URL"] as const).map(logical => ({ ...entry, logical })));

for (const { name, asset, load, logical } of cancelledTwinCases) test(`${name}: a twin cancelled after a ${logical} is not answered from cached bytes`, async () => {
  const key = `https://engine-cache.test/app/${asset}`;
  const cache = memoryCaches();
  cache.entries.set(key, { headers: new Headers({ "x-bunwasm-build": build, "content-type": "application/wasm" }), bytes: wasm });
  let heldCancelled = false;
  const restoreGlobals = pageGlobals({
    location: new URL("https://engine-cache.test/app/"),
    // No marker, so the loader downloads first and would otherwise recover from the cached bytes.
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    caches: cache.caches,
    fetch: async (url: string) => {
      if (url.includes(".gz")) throw new DOMException("The operation was aborted.", "AbortError");
      if (logical === "missing logical URL") return new Response(null, { status: 404 });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("<!doctype html>")); },
        cancel() { heldCancelled = true; },
      }), { headers: { "content-type": "text/html" } });
    },
    __bunwasmBuilds: { [asset]: build },
  });
  try {
    await expect(load()).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.lookups).toEqual([]);
    expect(heldCancelled).toBe(logical === "held index page");
  } finally {
    restoreGlobals();
  }
});

/** Loads the Browser engine without a build fingerprint, so nothing is cached between cases. */
async function loadUncached(fetch: (url: string) => Promise<Response>, url = "bun-browser.wasm", progress: (text: string) => void = () => {}) {
  const restoreGlobals = pageGlobals({
    location: new URL("https://engine-cache.test/app/"),
    caches: memoryCaches().caches,
    fetch,
    __bunwasmBuilds: {},
  });
  try { return await loadWasm(url, progress); } finally { restoreGlobals(); }
}

const logicalFailures: [string, () => Response][] = [
  ["404", () => new Response(null, { status: 404 })],
  ["406", () => new Response(null, { status: 406 })],
  ["a single-page index", () => new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } })],
  ["an uppercase TEXT/HTML index", () => new Response("<!doctype html>", { headers: { "content-type": "TEXT/HTML" } })],
  ["an index labeled application/octet-stream", () => new Response("<!doctype html>", { headers: { "content-type": "application/octet-stream" } })],
  ["an empty body", () => new Response(new Uint8Array(0), { headers: { "content-type": "application/wasm" } })],
  ["500", () => new Response(null, { status: 500 })],
  ["a rejected fetch", () => { throw new TypeError("Failed to fetch"); }],
  ["a body that fails while decoding", () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(wasm.slice(0, 6)); controller.error(new TypeError("Decoding failed")); },
  }), { headers: { "content-type": "application/wasm", "content-encoding": "br" } })],
];

const loaders = [
  ["Browser engine", (fetch: (url: string) => Promise<Response>) => loadUncached(fetch)],
  ["verified tools", async (fetch: (url: string) => Promise<Response>) => {
    const restoreGlobals = pageGlobals({ location: new URL("https://engine-cache.test/app/"), caches: memoryCaches().caches, fetch, __bunwasmBuilds: { "bun-tools.wasm": build } });
    try { return await loadWasm("bun-tools.wasm", () => {}); } finally { restoreGlobals(); }
  }],
] as const;

const fallbackCases = logicalFailures.flatMap(([label, answer]) => loaders.map(([loader, load]) => [label, loader, answer, load] as const));

test.each(fallbackCases)("a logical URL answered with %s falls back to the gzip twin for the %s", async (_label, _loader, answer, load) => {
  const fetched: string[] = [];
  const loaded = await load(async url => {
    fetched.push(new URL(url).pathname);
    return url.includes(".gz") ? new Response(Bun.gzipSync(wasm)) : answer();
  });
  expect(loaded.size).toBe(wasm.length);
  expect(fetched.map(path => path.replace("bun-tools", "bun-browser"))).toEqual(["/app/bun-browser.wasm", "/app/bun-browser.wasm.gz"]);
});

test.each(loaders)("a cancelled logical download stays cancelled for the %s instead of retrying the twin", async (_loader, load) => {
  const fetched: string[] = [];
  const cancelled = load(async url => {
    fetched.push(new URL(url).pathname);
    throw new DOMException("The operation was aborted.", "AbortError");
  });
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(fetched).toHaveLength(1);
});

test("a transport failure on both URLs reports the failure, not a missing asset", async () => {
  const failing = async (url: string) => {
    if (url.includes(".gz")) return new Response(null, { status: 404 });
    throw new TypeError("Failed to fetch");
  };
  const outcome = await loadUncached(failing).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(TypeError);
  expect(outcome).not.toBeInstanceOf(WasmMissing);
});

test("non-WebAssembly bytes at the logical URL with no twin reach verification instead of reading as missing", async () => {
  const [, tools] = loaders;
  const garbage = async (url: string) => url.includes(".gz") ? new Response(null, { status: 404 }) : new Response("not a module", { headers: { "content-type": "application/wasm" } });
  await expect(tools[1](garbage)).rejects.toThrow("bun-tools.wasm integrity mismatch");
});

/** A logical answer that is an index page whose stream fails again when discarded. */
function lateFailingIndex(): Response {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("<!doctype html>")); },
    cancel() { throw new TypeError("late decode error"); },
  }), { headers: { "content-type": "application/wasm" } });
}

test.each(loaders)("a held logical body that fails when discarded does not hide a healthy twin for the %s", async (_loader, load) => {
  const loaded = await load(async url => url.includes(".gz") ? new Response(Bun.gzipSync(wasm)) : lateFailingIndex());
  expect(loaded.size).toBe(wasm.length);
});

const unusableTwins: [string, () => Response][] = [
  ["a 204", () => new Response(null, { status: 204 })],
  ["an HTML 200", () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })],
  ["a 404", () => new Response(null, { status: 404 })],
];

test.each(unusableTwins)("%s twin keeps the held logical bytes for verification", async (_label, twin) => {
  const [, tools] = loaders;
  const answer = async (url: string) => url.includes(".gz") ? twin() : new Response("not a module", { headers: { "content-type": "application/wasm" } });
  await expect(tools[1](answer)).rejects.toThrow("bun-tools.wasm integrity mismatch");
});

const twinCancellations: [string, () => Response][] = [
  ["a held index page", () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })],
  ["a 404", () => new Response(null, { status: 404 })],
];

test.each(twinCancellations)("a cancelled twin fetch after %s stays cancelled", async (_label, logical) => {
  for (const [, load] of loaders) {
    const answer = async (url: string) => {
      if (url.includes(".gz")) throw new DOMException("The operation was aborted.", "AbortError");
      return logical();
    };
    await expect(load(answer)).rejects.toMatchObject({ name: "AbortError" });
  }
});

test("a module that does not compile is not downloaded again from its twin", async () => {
  const fetched: string[] = [];
  const broken = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 5]);
  await expect(loadUncached(async url => { fetched.push(new URL(url).pathname); return new Response(broken, { headers: { "content-type": "application/wasm" } }); }))
    .rejects.toBeInstanceOf(WebAssembly.CompileError);
  expect(fetched).toEqual(["/app/bun-browser.wasm"]);
});

test("a failed logical URL with no twin reports its own status, and two misses report a missing asset", async () => {
  const missingTwin = (status: number) => async (url: string) => new Response(null, { status: url.includes(".gz") ? 404 : status });
  await expect(loadUncached(missingTwin(500))).rejects.toThrow("bun-browser.wasm: HTTP 500");
  for (const status of [404, 406]) await expect(loadUncached(missingTwin(status))).rejects.toBeInstanceOf(WasmMissing);
});

test("an explicit gzip URL is fetched once as given and decompressed", async () => {
  const fetched: string[] = [];
  const loaded = await loadUncached(async url => { fetched.push(new URL(url).pathname); return new Response(Bun.gzipSync(wasm)); }, "custom/bun-browser.wasm.gz");
  expect(loaded.size).toBe(wasm.length);
  expect(fetched).toEqual(["/app/custom/bun-browser.wasm.gz"]);
});

// A valid module with a 1 MiB custom section, large enough for the progress text to name sizes.
const large = new Uint8Array(Buffer.concat([wasm, Buffer.from([0, 0x80, 0x80, 0x40]), Buffer.alloc(1024 * 1024)]));

test.each([
  ["no decoded size", { "content-length": "1000" }, null],
  ["a decoded size", { "content-length": "1000", "x-uncompressed-length": String(large.length) }, "1.0 MB"],
] as const)("natively decoded progress with %s never divides by the encoded length", async (_label, headers, total) => {
  const messages: string[] = [];
  const loaded = await loadUncached(guestHost("negotiating", [], large, headers), undefined, text => messages.push(text));
  expect(loaded.size).toBe(large.length);
  const downloads = messages.filter(text => text.startsWith("downloading bun.wasm… "));
  expect(downloads.length).toBeGreaterThan(0);
  if (total === null) for (const text of downloads) expect(text).not.toContain(" / ");
  else expect(downloads.at(-1)).toBe(`downloading bun.wasm… 1.0 MB / ${total}`);
});
