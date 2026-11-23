import { expect, test } from "bun:test";
import { loadEngineProgram, loadWasm } from "../src/engine-loader";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const build = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");

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
    fetch: async () => new Response(Bun.gzipSync(wasm)),
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

for (const storage of ["without", "with"] as const) test(`the Browser engine's second page load compiles from the engine cache ${storage} localStorage`, async () => {
  const names = ["location", "caches", "fetch", "__bunwasmBuilds", "localStorage"];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const entries = new Map<string, { headers: Headers; bytes: Uint8Array }>();
  const stored = Promise.withResolvers<void>();
  const fetched: string[] = [];
  const lookups: string[] = [];
  const marks = new Map<string, string>();
  const values = {
    location: new URL("https://engine-cache.test/app/"),
    localStorage: storage === "with" ? {
      getItem: (key: string) => marks.get(key) ?? null,
      setItem: (key: string, value: string) => { marks.set(key, value); },
      removeItem: (key: string) => { marks.delete(key); },
    } : undefined,
    caches: {
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
    },
    fetch: async (url: string) => { fetched.push(String(url)); return new Response(Bun.gzipSync(wasm)); },
    __bunwasmBuilds: { "bun-browser.wasm": build },
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    const key = "https://engine-cache.test/app/bun-browser.wasm";
    const first = await loadEngineProgram("browser", "split", () => {});
    expect(first.build).toBe(build);
    expect(fetched.map(url => new URL(url, location.href).href)).toEqual([`https://engine-cache.test/app/bun-browser.wasm.gz?v=${build}`]);
    // A first visit with a usable marker store never waits on CacheStorage before downloading.
    expect(lookups).toEqual(storage === "with" ? [] : [key]);
    await stored.promise;
    // The marker is written once the fake put returns to the loader.
    await Bun.sleep(1);
    expect(entries.get(key)?.headers.get("x-bunwasm-build")).toBe(build);
    if (storage === "with") expect(marks.get(`bunwasm-engine-cache:${key}`)).toBe(build);
    const second = await loadEngineProgram("browser", "split", () => {});
    expect(second.module).toBeInstanceOf(WebAssembly.Module);
    expect(second.size).toBe(wasm.length);
    expect(fetched).toHaveLength(1);
    expect(lookups.at(-1)).toBe(key);
  } finally {
    for (const [name, descriptor] of previous) restore(name, descriptor);
  }
});
