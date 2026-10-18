import { expect, test } from "bun:test";
import type { Runtime, GuestLauncher, ProgramDefinition } from "waffle";
import { BunWasmAssetError } from "../../web/src/assets";
import { installBunAdapters } from "../../web/src/bun-adapter";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function fixture() {
  const adapters = new Map<string, GuestLauncher>();
  const programs = new Map<string, ProgramDefinition>();
  const removed: string[] = [];
  function register<T>(kind: string, entries: Map<string, T>, name: string, value: T) {
    if (entries.has(name)) throw new Error(`Already registered: ${name}`);
    entries.set(name, value);
    return () => { if (entries.get(name) === value) { entries.delete(name); removed.push(`${kind}:${name}`); } };
  }
  const runtime = {
    registerAdapter: (name: string, value: GuestLauncher) => register("adapter", adapters, name, value),
    registerProgram: (name: string, value: ProgramDefinition) => register("program", programs, name, value),
  } as unknown as Runtime;
  return { runtime, adapters, programs, removed };
}

test("install owns only registrations and does not create or reserve a Runtime root", () => {
  const f = fixture();
  const install = installBunAdapters(f.runtime, { workerUrl: "worker.js", module });
  expect(Array.from(f.adapters.keys())).toEqual(["bun:quickjs", "bun:jsc", "bun:browser"]);
  expect(Array.from(f.programs.keys())).toEqual(["bun", "/bin/bun"]);
  expect(f.programs.get("bun")?.adapter).toBe("bun:browser");
  install.dispose();
  expect(f.adapters.size).toBe(0);
  expect(f.programs.size).toBe(0);
});

test("duplicate install rejects; disposal unregisters once and permits reinstall", () => {
  const f = fixture();
  const first = installBunAdapters(f.runtime, { workerUrl: "worker.js", module });
  expect(() => installBunAdapters(f.runtime, { workerUrl: "worker2.js", module })).toThrow("already installed");
  first.dispose(); first.dispose();
  expect(f.removed.length).toBe(5);
  expect(f.programs.has("bun")).toBe(false);
  const second = installBunAdapters(f.runtime, { workerUrl: "worker2.js", engine: "browser", module });
  expect(f.programs.get("bun")?.adapter).toBe("bun:browser");
  first.dispose();
  expect(f.adapters.size).toBe(3);
  second.dispose();
});

test("failed registration rolls back only this installation", () => {
  const f = fixture();
  const existing = { adapter: "another", module, cooperative: true } as const;
  f.programs.set("bun", existing);
  expect(() => installBunAdapters(f.runtime, { workerUrl: "worker.js", module })).toThrow("Already registered: bun");
  expect(f.adapters.size).toBe(0);
  expect(f.programs.get("bun")).toBe(existing);
  f.programs.delete("bun");
  installBunAdapters(f.runtime, { workerUrl: "worker.js", module }).dispose();
});

test.each(["quickjs", "jsc", "browser"] as const)("external %s launch delegates to Waffle's generic worker service", async engine => {
  const f = fixture();
  const workerUrl = "/assets/worker-entry-fixture.js";
  const install = installBunAdapters(f.runtime, { workerUrl, module });
  const launch = f.adapters.get(`bun:${engine}`)!;
  let launched: unknown;
  let terminated = false;
  const handle = { terminate() { terminated = true; } };
  const context = {
    module,
    interruptible: true,
    request: { executable: "bun", argv: ["bun", "run"], env: { TEST: "1" }, cwd: "/tmp", job: 0, fds: [] },
  };
  const service = { launchWorker(selected: unknown, options: unknown) { expect(selected).toBe(context); launched = options; return handle; } };
  const accepted = launch(context as never, service as never);
  install.dispose();
  await expect(accepted).resolves.toBe(handle);
  expect(terminated).toBe(false);
  expect(launched).toMatchObject({
    workerUrl,
    // Public Vite workers do not have the site's named module-serving cache. Browser-engine
    // cyclic imports therefore remain outside this entry's capabilities.
    request: { engine, adapter: "bun", module, args: ["bun", "run"], env: { TEST: "1", PWD: "/tmp" }, net: null, moduleCache: null },
  });
  install.dispose();
});

test("caller can choose alias names or keep program registration separately owned", async () => {
  const f = fixture();
  const install = installBunAdapters(f.runtime, { workerUrl: "worker.js", module, executables: ["bun-browser"], engine: "browser" });
  const definition = f.programs.get("bun-browser")!;
  expect(typeof definition.module).toBe("function");
  await expect((definition.module as () => Promise<WebAssembly.Module>)()).resolves.toBe(module);
  expect(f.programs.has("bun")).toBe(false);
  install.dispose();
  installBunAdapters(f.runtime, { workerUrl: "worker.js", executables: [] }).dispose();
});


test("guest loading stays lazy and uses the verified package loader", async () => {
  const f = fixture();
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const asset = { url: "https://example.test/fixture.wasm", bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  let fetched = 0;
  const install = installBunAdapters(f.runtime, { workerUrl: "worker.js", asset, fetch: async url => {
    expect(url).toBe(asset.url);
    fetched++;
    return new Response(bytes);
  } });
  expect(fetched).toBe(0);
  const definition = f.programs.get("bun")!;
  expect(await (definition.module as () => Promise<WebAssembly.Module>)()).toBeInstanceOf(WebAssembly.Module);
  expect(fetched).toBe(1);
  install.dispose();
});

test("invalid guest metadata produces the typed asset error", async () => {
  const f = fixture();
  const install = installBunAdapters(f.runtime, { workerUrl: "worker.js", asset: { url: "https://example.test/fixture", bytes: 8, sha256: "invalid" } });
  const definition = f.programs.get("bun")!;
  await expect((definition.module as () => Promise<WebAssembly.Module>)()).rejects.toBeInstanceOf(BunWasmAssetError);
  install.dispose();
});
