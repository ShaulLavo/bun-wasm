import { expect, spyOn, test } from "bun:test";
import { ENGINES, loadWasm, WasmMissing } from "../src/engine-loader";

const valid = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const substituted = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, 120]);
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

test("missing Hermes artifacts try compressed and plain URLs without fallback", async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const requested: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    requested.push(String(input));
    return new Response(null, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect }));
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  try {
    expect(ENGINES.hermes).toEqual({ name: "Hermes", wasm: "bun-hermes.wasm", script: "scripts/build-bun-hermes.sh" });
    const loading = loadWasm(ENGINES.hermes.wasm, () => {});
    await expect(loading).rejects.toBeInstanceOf(WasmMissing);
    await expect(loading).rejects.toThrow("bun-hermes.wasm: HTTP 404");
    expect(requested).toEqual(["bun-hermes.wasm.gz", "bun-hermes.wasm"]);
  } finally {
    fetch.mockRestore();
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

for (const source of ["download", "cache"] as const) {
  for (const bytes of [valid, substituted]) test(`tools integrity rejects ${source} mismatch before compilation (${bytes.length} bytes)`, async () => {
    const expected = "0".repeat(64);
    await withTools(bytes, expected, source, async state => {
      await expect(loadWasm("bun-tools.wasm", () => {})).rejects.toThrow(
        `bun-tools.wasm integrity mismatch: expected ${expected}, received ${hash(bytes)}`,
      );
      expect(state.compile).not.toHaveBeenCalled();
      expect(state.streaming).not.toHaveBeenCalled();
      expect(state.downloads()).toBe(source === "cache" ? 0 : 1);
      expect(state.puts()).toBe(0);
      expect(state.cached()).toBe(false);
    });
  });
}

test("verified tools compile, run and enter the cache", async () => {
  await withTools(valid, hash(valid), "download", async state => {
    const result = await loadWasm("bun-tools.wasm", () => {});
    expect(await WebAssembly.instantiate(result.module)).toBeInstanceOf(WebAssembly.Instance);
    expect(state.compile).toHaveBeenCalledTimes(1);
    expect(state.streaming).not.toHaveBeenCalled();
    expect(state.puts()).toBe(1);
    expect(state.cached()).toBe(true);
  });
});

async function withTools(bytes: Uint8Array, expected: string, source: "download" | "cache", check: (state: {
  compile: ReturnType<typeof spyOn<typeof WebAssembly, "compile">>;
  streaming: ReturnType<typeof spyOn<typeof WebAssembly, "compileStreaming">>;
  downloads(): number;
  puts(): number;
  cached(): boolean;
}) => Promise<void>): Promise<void> {
  const originals = new Map(["location", "__bunwasmBuilds", "caches", "fetch"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const compile = spyOn(WebAssembly, "compile");
  const streaming = spyOn(WebAssembly, "compileStreaming");
  let downloads = 0, puts = 0;
  let cached = source === "cache" ? new Response(new Uint8Array(bytes), { headers: { "x-bunwasm-build": expected } }) : undefined;
  const globals = {
    location: new URL("http://localhost/"),
    __bunwasmBuilds: { "bun-tools.wasm": expected },
    caches: {
      async match() { return cached?.clone(); },
      async open() { return {
        async put(_key: string, response: Response) { puts++; cached = response; },
        async delete() { cached = undefined; return true; },
      }; },
    },
    async fetch() { downloads++; return new Response(Bun.gzipSync(new Uint8Array(bytes))); },
  };
  try {
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
    await check({ compile, streaming, downloads: () => downloads, puts: () => puts, cached: () => cached !== undefined });
  } finally {
    compile.mockRestore();
    streaming.mockRestore();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}
