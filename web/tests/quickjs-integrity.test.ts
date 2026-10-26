import { expect, test } from "bun:test";
import { loadWasm } from "../src/engine-loader";
import { programLinkPlan } from "../../src/assets";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture";

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

for (const source of ["download", "cache"] as const) {
  for (const changed of ["bun.wasm", "quickjs.wasm"] as const) test(`paired ${source} rejects changed ${changed}`, async () => {
    await withPair(source, changed, async () => {
      await expect(loadWasm("bun.wasm", () => {})).rejects.toThrow(`${changed} integrity mismatch`);
    });
  });
}

for (const filename of ["bun.wasm", "bun.wasm.gz", "custom.wasm"]) {
  for (const manifest of [undefined, { "bun.wasm": "unrelated-core", "quickjs.wasm": "unrelated-side" }]) {
    test(`custom QuickJS URL ${filename} ignores the unrelated local manifest ${Boolean(manifest)}`, async () => {
      await customPair(filename, manifest);
    });
  }
}

async function customPair(filename: string, manifest: Record<string, string> | undefined) {
  const { core, side } = quickjsPair();
  const originals = new Map(["location", "__bunwasmBuilds", "fetch"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requested: string[] = [];
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://app.test/") });
    Object.defineProperty(globalThis, "__bunwasmBuilds", { configurable: true, value: manifest });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requested.push(url);
      const bytes = url.endsWith("quickjs.wasm.gz") ? side : core;
      return new Response(Bun.gzipSync(bytes));
    } });
    const result = await loadWasm(`https://cdn.test/build/${filename}`, () => {});
    expect(result.build).toBeNull();
    expect(programLinkPlan(result.module)?.libraries[0]?.source).toEqual(side);
    expect(requested).toEqual([`https://cdn.test/build/${filename.replace(/\.gz$/, "")}.gz`, "https://cdn.test/build/quickjs.wasm.gz"]);
  } finally {
    restoreGlobals(originals);
  }
}

test("downloaded and cached pairs preserve both exact program inputs", async () => {
  await withPair("download", undefined, async ({ core, side, downloads }) => {
    const first = await loadWasm("bun.wasm", () => {});
    expect(first.size).toBe(core.length + side.length);
    const plan = programLinkPlan(first.module);
    expect(plan?.core.source.slice(0, core.length)).toEqual(core);
    expect(plan?.core.source.length).toBeGreaterThan(core.length);
    expect(plan?.libraries[0]?.source).toEqual(side);
    expect(downloads()).toBe(2);
    const cached = await loadWasm("bun.wasm", () => {});
    expect(cached.module).toBe(first.module);
    expect(downloads()).toBe(2);
  });
});

async function withPair(source: "download" | "cache", changed: string | undefined, check: (state: ReturnType<typeof quickjsPair> & { downloads(): number }) => Promise<void>) {
  const { core, side } = quickjsPair();
  const files = new Map([["bun.wasm", core], ["quickjs.wasm", side]]);
  const originals = new Map(["location", "__bunwasmBuilds", "caches", "fetch"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const cache = new Map<string, Response>();
  let downloads = 0;
  const bytesFor = (name: string) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`unexpected artifact ${name}`);
    return name === changed ? Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]) : bytes;
  };
  if (source === "cache") for (const [name, bytes] of files) cache.set(`https://example.test/${name}`, new Response(bytesFor(name), { headers: { "x-bunwasm-build": digest(bytes) } }));
  const globals = {
    location: new URL("https://example.test/"), __bunwasmBuilds: Object.fromEntries(Array.from(files, ([name, bytes]) => [name, digest(bytes)])),
    caches: {
      async match(key: string) { return cache.get(key)?.clone(); },
      async open() { return { async put(key: string, response: Response) { cache.set(key, response); }, async delete(key: string) { return cache.delete(key); } }; },
    },
    async fetch(url: string) {
      downloads++;
      const name = new URL(url, "https://example.test/").pathname.slice(1).replace(/\.gz$/, "");
      return new Response(Bun.gzipSync(bytesFor(name)));
    },
  };
  try {
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
    await check({ core, side, downloads: () => downloads });
  } finally {
    restoreGlobals(originals);
  }
}

test("default gzipped QuickJS URL still requires the build fingerprints", async () => {
  await withPair("download", "quickjs.wasm", async () => {
    await expect(loadWasm("bun.wasm.gz", () => {})).rejects.toThrow("quickjs.wasm integrity mismatch");
  });
});

function restoreGlobals(originals: Map<string, PropertyDescriptor | undefined>): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
