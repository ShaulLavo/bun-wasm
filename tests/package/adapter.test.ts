import { expect, test } from "bun:test";
import type { Runtime, GuestLauncher, ProgramDefinition } from "waffle";
import { installBunAdapters, BunWasmProcessUnavailableError, BunWasmExecutableConflictError } from "../../src/bun-adapter.js";

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
      writeFile: async (path: string, bytes: Uint8Array) => { files.set(path, new Uint8Array(bytes)); },
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
  expect(Array.from(f.programs.keys())).toEqual(["/bin/bun"]);
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
  expect(f.removed.length).toBe(4);
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

test("every engine rejects with the typed unimplemented-process-bridge boundary", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime);
  try {
    for (const launch of f.adapters.values()) {
      await expect(launch({} as never, {} as never)).rejects.toBeInstanceOf(BunWasmProcessUnavailableError);
      await expect(launch({} as never, {} as never)).rejects.toMatchObject({ code: "BUN_WASM_PROCESS_UNAVAILABLE" });
    }
    const load = f.programs.get("/bin/bun")!.module as () => Promise<WebAssembly.Module>;
    await expect(load()).rejects.toMatchObject({ code: "BUN_WASM_PROCESS_UNAVAILABLE" });
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

test("disabled bridge refuses before guest fetch or compilation", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime, { fetch: async () => { throw new Error("unexpected download"); } });
  const definition = f.programs.get("/bin/bun")!;
  await expect((definition.module as () => Promise<WebAssembly.Module>)()).rejects.toBeInstanceOf(BunWasmProcessUnavailableError);
  install.dispose();
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
  expect(f.programs.get("/bin/bun")?.adapter).toBe("bun:quickjs");
  install.dispose();
});
