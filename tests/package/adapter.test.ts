import { quickjsPair } from "./quickjs-plan-fixture.ts";
import { prepareProgram } from "../../src/assets.ts";
import { processRuntimeFixture } from "../../web/tests/process-runtime-fixture";
import { networkPathScopeFixture, socketDirectoryFixture } from "../../web/tests/socket-runtime-fixture";
import { outcomeWord } from "waffle/proc/outcome";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { Runtime, GuestLauncher, ProgramDefinition, ProcessService } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { MemoryBackend } from "waffle/fs/backend";
import { FilesystemService } from "waffle/fs/service";
import { createFilesystemConnection, FilesystemError } from "waffle/fs/protocol";
import { installBunAdapters as installReal, BunWasmExecutableConflictError } from "../../src/bun-adapter.js";
import type { BunAdapterOptions } from "../../src/index.js";
import { runtimeSharedObjectRoute } from "../../web/src/shared-objects/runtime.js";
const workerUrl = "https://example.test/worker.js";
const notificationWorkerUrl = "https://example.test/notification-worker.js";
type FixtureOptions = Omit<BunAdapterOptions, "workerUrl" | "notificationWorkerUrl"> & { workerUrl?: string | URL; notificationWorkerUrl?: string | URL };
const installBunAdapters = (runtime: Runtime, options: FixtureOptions = {}) => installReal(runtime, { workerUrl, notificationWorkerUrl, ...options });


const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
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
  const networkOwner = processRuntimeFixture({});
  const runtime = {
    network: () => networkOwner.network(),
    registerAdapter: (name: string, value: GuestLauncher) => register("adapter", adapters, name, value),
    registerProgram: (name: string, value: ProgramDefinition) => register("program", programs, name, value),
    filesystem: {
      directoryHandle: socketDirectoryFixture,
      lookup: async (path: string) => files.has(path) ? { kind: "file" } : directories.has(path) ? { kind: "dir" } : undefined,
      readFile: async (path: string) => files.get(path),
      writeFile: async (path: string, bytes: Uint8Array, mode?: { exclusive?: boolean }) => {
        if (mode?.exclusive && (files.has(path) || directories.has(path))) throw new FilesystemError(20);
        files.set(path, new Uint8Array(bytes));
      },
      mkdirp: async (path: string) => { directories.add(path); },
      remove: async (path: string) => files.delete(path),
      drain: async () => {},
      resolvePath: async () => ({ path: "/", kind: "dir" }),
      fork: () => {
        const backend = new MemoryBackend();
        backend.execute = (operation, args, bytes) => {
          const path = args[0] as string;
          switch (operation) {
            case "writeFile": return runtime.filesystem.writeFile(path, bytes!, { exclusive: args[2] === true });
            case "mkdirp": return runtime.filesystem.mkdirp(path);
            case "lookup": return runtime.filesystem.lookup(path);
            case "readFile": return runtime.filesystem.readFile(path);
            case "remove": return runtime.filesystem.remove(path);
            default: throw new Error(`Unexpected fixture operation: ${operation}`);
          }
        };
        const service = new FilesystemService(backend);
        const connection = createFilesystemConnection();
        cleanups.push(() => { service.dispose(); connection.server.port.close(); connection.client.port.close(); });
        service.connect(connection.server);
        return connection.client;
      },
    },
  } as unknown as Runtime;
  return { runtime, adapters, programs, files, directories, removed };
}

test("install provisions /bin/bun and owns registrations without reserving a Runtime root", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime);
  expect(Array.from(f.adapters.keys())).toEqual(["bun:quickjs", "bun:jsc", "bun:browser"]);
  expect(Array.from(f.programs.keys())).toEqual(["/bin/bun", "/bin/node", "/bin/nodejs"]);
  expect(f.programs.get("/bin/bun")?.adapter).toBe("bun:browser");
  expect(f.directories.has("/bin")).toBe(true);
  expect(f.files.has("/bin/bun")).toBe(true);
  expect(f.files.has("/bin/nodejs")).toBe(true);
  expect(f.programs.get("/bin/nodejs")?.adapter).toBe("bun:browser");
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
  expect(f.removed.length).toBe(6);
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

test("installation requires the notification helper worker", async () => {
  const f = fixture();
  await expect(installBunAdapters(f.runtime, { notificationWorkerUrl: "" })).rejects.toThrow("notificationWorkerUrl is required");
  expect(f.adapters.size).toBe(0);
});

test("every engine forwards to the production process worker", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime, { module });
  const launches: Parameters<ProcessService["launchWorker"]>[1][] = [];
  const releases: number[] = [];
  const acquire = f.runtime.filesystem.directoryHandle.bind(f.runtime.filesystem);
  const directory = spyOn(f.runtime.filesystem, "directoryHandle").mockImplementation(async path => {
    const lease = await acquire(path);
    const index = releases.length;
    releases.push(0);
    return { handle: lease.handle, release() { releases[index] = (releases[index] ?? 0) + 1; lease.release(); } };
  });
  const service = {
    networkPathScope: networkPathScopeFixture,
    launchWorker(_context: unknown, options: Parameters<ProcessService["launchWorker"]>[1]) { launches.push(options); return { terminate() {} }; },
  };
  try {
    const context = { outcome: outcomeWord(), registerRevocation: () => () => {}, module, request: { executable: "/bin/bun", argv: ["bun", "-e", "0"], env: { PATH: "/bin" }, cwd: "/" } };
    for (const [name, launch] of f.adapters) {
      await launch(context as never, service as never);
      expect(launches.at(-1)).toMatchObject({ workerUrl, notificationWorkerUrl, request: { engine: name.slice(4), module, args: ["bun", "-e", "0"], env: { BUNWASM_EXEC_PATH: "/bin/bun", PATH: "/bin" } } });
      expect(directory).toHaveBeenLastCalledWith("/");
      expect(releases.at(-1)).toBe(0);
      launches.at(-1)?.cleanup?.();
      launches.at(-1)?.cleanup?.();
      expect(releases.at(-1)).toBe(1);
    }
    const load = f.programs.get("/bin/bun")!.module as () => Promise<WebAssembly.Module>;
    expect(await load()).toBe(module);
    expect(directory).toHaveBeenCalledTimes(f.adapters.size);
  } finally {
    for (const launched of launches) launched.cleanup?.();
    directory.mockRestore();
    install.dispose();
  }
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
    // The service preserves typed errno and normalizes arbitrary backend errors to EIO.
    expect(await installBunAdapters(f.runtime).catch(error => error)).toMatchObject({ errno: 29 });
    expect(f.adapters.size).toBe(0);
    expect(f.programs.size).toBe(0);
    expect(f.files.size).toBe(0);
  });
}

test("resolving an exclusive marker race never consumes a shared drain error", async () => {
  const f = fixture();
  const failure = new FilesystemError(29);
  const winner = new TextEncoder().encode("bun-wasm registered executable\n");
  f.runtime.filesystem.writeFile = async path => {
    f.files.set(path, winner);
    throw new FilesystemError(20);
  };
  f.runtime.filesystem.drain = async () => { throw failure; };
  const install = await installBunAdapters(f.runtime);
  try {
    expect(f.files.get("/bin/bun")).toBe(winner);
    await expect(f.runtime.filesystem.drain()).rejects.toBe(failure);
  } finally { install.dispose(); }
  expect(f.adapters.size).toBe(0);
  expect(f.programs.size).toBe(0);
});

for (const conflict of [false, true]) {
  test(`installer disposes its borrowed filesystem client after ${conflict ? "failure" : "success"}`, async () => {
    const f = fixture();
    if (conflict) f.files.set("/bin/bun", new Uint8Array([1]));
    const dispose = spyOn(FilesystemClient.prototype, "dispose");
    try {
      if (conflict) await expect(installBunAdapters(f.runtime)).rejects.toBeInstanceOf(BunWasmExecutableConflictError);
      else (await installBunAdapters(f.runtime)).dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally { dispose.mockRestore(); }
  });
}

for (const engine of ["quickjs", "jsc", "browser", "hermes"] as const) test(`default ${engine} nodejs registration uses its selected module`, async () => {
  const f = fixture();
  const selected = engine === "browser" ? module : await prepareProgram({ kind: engine, ...quickjsPair(engine) });
  const installed = await installBunAdapters(f.runtime, { engine, module: selected });
  try {
    const bin = engine === "browser" ? "/bin" : `/opt/bun/${engine}/bin`;
    const program = f.programs.get(`${bin}/nodejs`);
    expect(program?.adapter).toBe(`bun:${engine}`);
    expect(f.files.has(`${bin}/nodejs`)).toBe(true);
    if (typeof program?.module !== "function") throw new Error("Expected lazy module registration");
    expect(await program.module()).toBe(selected);
  } finally { installed.dispose(); }
});

test("Hermes adapters require an explicit engine and matching assets", async () => {
  const f = fixture();
  await expect(installBunAdapters(f.runtime, { engine: "hermes" })).rejects.toThrow("requires its matching guest");
  expect(f.adapters.size).toBe(0);
  const installed = await installBunAdapters(f.runtime, { engine: "hermes", module });
  try { expect(Array.from(f.adapters.keys())).toEqual(["bun:quickjs", "bun:jsc", "bun:browser", "bun:hermes"]); }
  finally { installed.dispose(); }
  expect(f.adapters.size).toBe(0);
});

test("Hermes package registration rejects another engine at actual module admission", async () => {
  const f = fixture();
  const installed = await installBunAdapters(f.runtime, { engine: "hermes", module });
  try {
    const program = f.programs.get("/opt/bun/hermes/bin/bun");
    if (typeof program?.module !== "function") throw new Error("Missing lazy program");
    await expect(program.module()).rejects.toThrow("Selected hermes core declares single");
  } finally { installed.dispose(); }
});

test("installing the adapters alone installs no shared-object service", async () => {
  const f = fixture();
  const install = await installBunAdapters(f.runtime);
  try { expect(runtimeSharedObjectRoute(f.runtime as unknown as Runtime)).toBeUndefined(); }
  finally { install.dispose(); }
});
