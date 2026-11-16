import { expect, spyOn, test } from "bun:test";
import { createToolsLoader } from "../web/src/engine-loader";

const wasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
const build = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");

async function withTools(check: (fixture: {
  load: ReturnType<typeof createToolsLoader>;
  downloads(): number;
  compilations(): number;
  writes(): number;
  stored(): Promise<void>;
  persist(error?: Error): void;
  valid(value: boolean): void;
}) => Promise<void>) {
  const names = ["location", "caches", "fetch", "__bunwasmBuilds"];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const persistence = Promise.withResolvers<Error | undefined>();
  const stored = Promise.withResolvers<void>();
  const compile = spyOn(WebAssembly, "compile");
  const pending = new Set<Promise<WebAssembly.Module>>();
  const load = createToolsLoader();
  const trackedLoad = () => {
    const result = load();
    pending.add(result);
    void result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  let downloads = 0;
  let writes = 0;
  let valid = true;
  let cached: Response | undefined;
  const cache = {
    async put(_url: string, response: Response) {
      writes++;
      const error = await persistence.promise;
      if (error) throw error;
      cached = response;
      stored.resolve();
    },
  };
  const values = {
    location: new URL("https://tools-cache.test/"),
    caches: { match: async () => cached?.clone(), open: async () => cache },
    fetch: async () => { downloads++; return new Response(Bun.gzipSync(valid ? wasm : Uint8Array.of(0))); },
    __bunwasmBuilds: { "bun-tools.wasm": build },
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    await check({ load: trackedLoad, downloads: () => downloads, compilations: () => compile.mock.calls.length,
      writes: () => writes, stored: () => stored.promise, persist: persistence.resolve, valid: value => { valid = value; } });
  } finally {
    persistence.resolve();
    await Promise.allSettled(pending);
    compile.mockRestore();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test("concurrent and later tools commands reuse one module before persistence finishes", () => withTools(async fixture => {
  const first = fixture.load();
  expect(fixture.load()).toBe(first);
  const module = await first;
  expect(await fixture.load()).toBe(module);
  expect(fixture.downloads()).toBe(1);
  expect(fixture.compilations()).toBe(1);
  expect(fixture.writes()).toBe(1);
  fixture.persist();
  await fixture.stored();
  expect(await fixture.load()).toBe(module);
  expect(fixture.compilations()).toBe(1);
}));

test("integrity rejection is shared, never compiled or stored, and a later command can load verified tools", () => withTools(async fixture => {
  fixture.valid(false);
  const rejected = fixture.load();
  expect(fixture.load()).toBe(rejected);
  await expect(rejected).rejects.toThrow("bun-tools.wasm integrity mismatch");
  expect(fixture.compilations()).toBe(0);
  expect(fixture.writes()).toBe(0);
  fixture.valid(true);
  const module = await fixture.load();
  expect(await fixture.load()).toBe(module);
  expect(fixture.downloads()).toBe(2);
  expect(fixture.compilations()).toBe(1);
}));

test("optional persistence failure cannot discard a prepared tools module", () => withTools(async fixture => {
  fixture.persist(new Error("storage unavailable"));
  const module = await fixture.load();
  expect(await fixture.load()).toBe(module);
  expect(fixture.downloads()).toBe(1);
  expect(fixture.compilations()).toBe(1);
}));

test("a new tools consumer compiles persisted verified bytes without another download", () => withTools(async fixture => {
  const first = await fixture.load();
  fixture.persist();
  await fixture.stored();
  const reload = createToolsLoader();
  const second = await reload();
  expect(second).not.toBe(first);
  expect(await reload()).toBe(second);
  expect(fixture.downloads()).toBe(1);
  expect(fixture.compilations()).toBe(2);
}));
