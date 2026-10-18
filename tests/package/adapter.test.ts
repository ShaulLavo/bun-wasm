import { expect, test } from "bun:test";
import type { Runtime, GuestLauncher, ProgramDefinition } from "waffle";
import { FilesystemError } from "waffle/fs/protocol";
import { installBunAdapters as installReal, type BunAdapterOptions, BunWasmExecutableConflictError } from "../../src/bun-adapter.js";
const workerUrl = "https://example.test/worker.js";
const installBunAdapters = (runtime: Runtime, options: Omit<BunAdapterOptions, "workerUrl"> & { workerUrl?: string | URL } = {}) => installReal(runtime, { workerUrl, ...options });


const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function fixture() {
  const adapters = new Map<string, GuestLauncher>();
  const programs = new Map<string, ProgramDefinition>();
  const files = new Map<string, Uint8Array>();
  const directories = new Set(["/"]);
  const removed: string[] = [];
  function register<T>(kind: string, entries: Map<string, T>, name: string, value: T) {
    if (entries.has(name)) throw new Error(`Already registered: ${name}`);
    entries.set(name, value);
    return () => { if (entries.get(name) === value) { entries.delete(name); removed.push(`${kind}:${name}`); } };
  }
  const runtime = {
    registerAdapter: (name: string, value: GuestLauncher) => register("adapter", adapters, name, value),
    registerProgram: (name: string, value: ProgramDefinition) => register("program", programs, name, value),
    filesystem: {
      lookup: async (path: string) => files.has(path) ? { kind: "file" } : directories.has(path) ? { kind: "dir" } : undefined,
      readFile: async (path: string) => files.get(path),
      writeFile: async (path: string, bytes: Uint8Array, mode?: { exclusive?: boolean }) => {
        if (mode?.exclusive && (files.has(path) || directories.has(path))) throw new FilesystemError(20);
        files.set(path, new Uint8Array(bytes));
      },
      mkdirp: async (path: string) => { directories.add(path); },
      remove: async (path: string) => files.delete(path),
      drain: async () => {},
    },
  } as unknown as Runtime;
  return { runtime, adapters, programs, files, directories, removed };
}

test("install provisions /bin/bun and owns registrations without reserving a Runtime root", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime);
  expect(Array.from(f.adapters.keys())).toEqual(["bun:quickjs", "bun:jsc", "bun:browser"]);
  expect(Array.from(f.programs.keys())).toEqual(["/bin/bun", "/bin/node"]);
  expect(f.programs.get("/bin/bun")?.adapter).toBe("bun:browser");
  expect(f.directories.has("/bin")).toBe(true);
  expect(f.files.has("/bin/bun")).toBe(true);
  install.dispose();
  expect(f.adapters.size).toBe(0);
  expect(f.programs.size).toBe(0);
  expect(f.files.has("/bin/bun")).toBe(true);
});

test("concurrent and duplicate installs reject; disposal unregisters once and permits reinstall", async () => {
  const f = fixture();
  const pending = installBunAdapters(f.runtime);
  await expect(installBunAdapters(f.runtime)).rejects.toThrow("already installed");
  const first = await pending;
  await expect(installBunAdapters(f.runtime)).rejects.toThrow("already installed");
  first.dispose(); first.dispose();
  expect(f.removed.length).toBe(5);
  const second = await installBunAdapters(f.runtime);
  first.dispose();
  expect(f.adapters.size).toBe(3);
  second.dispose();
});

test("failed registration rolls back only this installation", async () => {
  const f = fixture();
  const existing = { adapter: "another", module, cooperative: true } as const;
  f.programs.set("/bin/bun", existing);
  await expect(installBunAdapters(f.runtime)).rejects.toThrow("Already registered: /bin/bun");
  expect(f.adapters.size).toBe(0);
  expect(f.programs.get("/bin/bun")).toBe(existing);
  expect(f.files.size).toBe(0);
  f.programs.delete("/bin/bun");
  (await installBunAdapters(f.runtime)).dispose();
});

test("every engine forwards to the production process worker", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime, { module });
  try {
    const launches: any[] = [];
    const context = { module, request: { executable: "/bin/bun", argv: ["bun", "-e", "0"], env: { PATH: "/bin" }, cwd: "/" } };
    for (const [name, launch] of f.adapters) {
      await launch(context as never, { launchWorker(_context: unknown, options: unknown) { launches.push(options); return { terminate() {} }; } } as never);
      expect(launches.at(-1)).toMatchObject({ workerUrl, request: { engine: name.slice(4), module, args: ["bun", "-e", "0"], env: { BUNWASM_EXEC_PATH: "/bin/bun", PATH: "/bin" } } });
    }
    const load = f.programs.get("/bin/bun")!.module as () => Promise<WebAssembly.Module>;
    expect(await load()).toBe(module);
  } finally { install.dispose(); }
});

test("caller can choose canonical aliases or keep program registration separately owned", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime, { executables: ["/opt/bun/browser"], engine: "browser" });
  expect(f.programs.get("/opt/bun/browser")?.adapter).toBe("bun:browser");
  expect(f.files.has("/opt/bun/browser")).toBe(true);
  expect(f.programs.has("/bin/bun")).toBe(false);
  install.dispose();
  (await installBunAdapters(f.runtime, { executables: [] })).dispose();
});

test("provided guest module loads without fetching", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime, { module, fetch: async () => { throw new Error("unexpected download"); } });
  try { expect(await (f.programs.get("/bin/bun")!.module as () => Promise<WebAssembly.Module>)()).toBe(module); }
  finally { install.dispose(); }
});

test("different files and directories produce a typed conflict without overwriting caller data", async () => {
  for (const directory of [false, true]) {
    const f = fixture();
    const original = new Uint8Array([1, 2, 3]);
    if (directory) f.directories.add("/bin/bun");
    else f.files.set("/bin/bun", original);
    await expect(installBunAdapters(f.runtime)).rejects.toBeInstanceOf(BunWasmExecutableConflictError);
    await expect(installBunAdapters(f.runtime)).rejects.toMatchObject({ code: "BUN_WASM_EXECUTABLE_CONFLICT", path: "/bin/bun" });
    expect(f.files.get("/bin/bun")).toBe(directory ? undefined : original);
    expect(f.adapters.size).toBe(0);
    expect(f.programs.size).toBe(0);
  }
});

test("invalid executable names and explicit engines are validated before registrations", async () => {
  const f = fixture();
  for (const name of ["bun", "/", "/bin/../bun", "/bin//bun", "/bin/bun\0"]) {
    await expect(installBunAdapters(f.runtime, { executables: [name] })).rejects.toThrow("absolute and canonical");
  }
  await expect(installBunAdapters(f.runtime, { engine: "quickjs" })).rejects.toThrow("matching guest");
  const install = await installBunAdapters(f.runtime, { engine: "quickjs", module });
  expect(f.programs.get("/opt/bun/quickjs/bin/bun")?.adapter).toBe("bun:quickjs");
  install.dispose();
});

for (const failure of [new FilesystemError(29), Object.assign(new Error("not a filesystem conflict"), { errno: 20 })]) {
  test(`exclusive marker creation preserves unrelated ${failure.message} errors`, async () => {
    const f = fixture();
    f.runtime.filesystem.writeFile = async (_path, _bytes, mode) => {
      expect(mode).toEqual({ exclusive: true });
      throw failure;
    };
    expect(await installBunAdapters(f.runtime).catch(error => error)).toBe(failure);
    expect(f.adapters.size).toBe(0);
    expect(f.programs.size).toBe(0);
    expect(f.files.size).toBe(0);
  });
}

test("an unrelated queued storage failure is not swallowed while resolving an exclusive marker race", async () => {
  const f = fixture();
  const failure = new FilesystemError(29);
  const winner = new TextEncoder().encode("bun-wasm registered executable\n");
  f.runtime.filesystem.writeFile = async () => {
    f.files.set("/bin/bun", winner);
    throw new FilesystemError(20);
  };
  f.runtime.filesystem.drain = async () => { throw failure; };
  expect(await installBunAdapters(f.runtime).catch(error => error)).toBe(failure);
  expect(f.files.get("/bin/bun")).toBe(winner);
  expect(f.adapters.size).toBe(0);
  expect(f.programs.size).toBe(0);
});
