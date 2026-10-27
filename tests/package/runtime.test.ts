import { expect, test } from "bun:test";
import { createRuntime, type Runtime, type RuntimeOptions } from "waffle";
import { MemoryBackend } from "waffle/fs/backend";
import { FilesystemService } from "waffle/fs/service";
import type { FilesystemConnection } from "waffle/fs/protocol";
import type { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { installBunAdapters as installReal, type BunAdapterOptions, BunWasmExecutableConflictError } from "../../src/bun-adapter.js";
const workerUrl = "https://example.test/worker.js";
const installBunAdapters = (runtime: Runtime, options: Omit<BunAdapterOptions, "workerUrl"> & { workerUrl?: string | URL } = {}) => installReal(runtime, { workerUrl, ...options });


// Keep Runtime, filesystem transport/backend, executable admission and process supervisor real.
// Only the browser filesystem worker is hosted in-process; no persistent store is created.
async function withRuntime(run: (runtime: ReturnType<typeof createRuntime>, registry: () => ExecutableRegistry) => Promise<void>, backend = new MemoryBackend()) {
  const originalWorker = globalThis.Worker;
  const ports: MessagePort[] = [];
  let registry!: ExecutableRegistry;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  globalThis.Worker = class {
    service = new FilesystemService(backend);
    addEventListener() {}
    postMessage(message: { connect: FilesystemConnection }) {
      ports.push(message.connect.port);
      this.service.connect(message.connect);
    }
    terminate() { this.service.dispose(); }
  } as unknown as typeof Worker;
  try {
    runtime = createRuntime({
      filesystem: { workerURL: "https://example.test/fs.js", mode: "memory" },
      processHost: options => {
        registry = options.registry;
        return {
          ready: async () => ({}), suspend() {}, async quiesce() {}, async dispose() {},
        } as Awaited<ReturnType<NonNullable<RuntimeOptions["processHost"]>>>;
      },
    });
    await run(runtime, () => registry);
  } finally {
    try { await runtime?.dispose(); }
    finally {
      for (const port of ports) port.close();
      globalThis.Worker = originalWorker;
    }
  }
}

test("fresh Runtime installs canonical files and executes through the generic launcher", async () => {
  await withRuntime(async (runtime, getRegistry) => {
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const installation = await installBunAdapters(runtime, { module });
    let supervisor: ProcessSupervisor | undefined;
    try {
      expect(await runtime.filesystem.readFile("/bin/bun")).toBeInstanceOf(Uint8Array);
      await runtime.processes();
      const registry = getRegistry();
      expect(await registry.resolve("/bin/bun")).toMatchObject({ module, adapter: "bun:browser" });
      let launched = 0;
      supervisor = new ProcessSupervisor({ registry, launch(context) {
        launched++;
        expect(context.module).toBe(module);
        expect(context.request.executable).toBe("/bin/bun");
        return { terminate() {} };
      } });
      const root = supervisor.createRoot();
      const pid = supervisor.spawn(root, { executable: "/bin/bun", argv: ["bun"], env: {}, cwd: "/", fds: [], job: 0 });
      await supervisor.start(pid);
      expect(launched).toBe(1);
      supervisor.exit(pid, 23);
      expect(supervisor.wait(root, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
      installation.dispose();
      expect(await runtime.filesystem.readFile("/bin/bun")).toBeInstanceOf(Uint8Array);
      (await installBunAdapters(runtime, { module })).dispose();
    } finally { supervisor?.dispose(); installation.dispose(); }
  });
});

function blockParentDuringInstall(backend: MemoryBackend): MemoryBackend {
  const execute = backend.execute.bind(backend);
  backend.execute = (operation, args, data) => {
    if (operation === "mkdirp" && args[0] === "/blocked") {
      execute("writeFile", ["/blocked", false, false], new TextEncoder().encode("caller-owned parent file"));
    }
    return execute(operation, args, data);
  };
  return backend;
}

test("real Runtime rolls back markers after a later filesystem mutation fails", async () => {
  await withRuntime(async runtime => {
    const error = await installBunAdapters(runtime, { executables: ["/bin/bun", "/blocked/bun"] }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("filesystem errno");
    expect(await runtime.filesystem.readFile("/bin/bun")).toBeUndefined();
    expect(new TextDecoder().decode(await runtime.filesystem.readFile("/blocked"))).toBe("caller-owned parent file");
    (await installBunAdapters(runtime)).dispose();
  }, blockParentDuringInstall(new MemoryBackend()));
});

test("real Runtime installation never replaces a different existing executable file", async () => {
  await withRuntime(async runtime => {
    await runtime.filesystem.mkdirp("/bin");
    await runtime.filesystem.writeFile("/bin/bun", "caller-owned command");
    const error = await installBunAdapters(runtime).catch(error => error);
    expect(error).toBeInstanceOf(BunWasmExecutableConflictError);
    expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/bun"))).toBe("caller-owned command");
  });
});

function racingBackend(winner: "file" | "directory" | "marker") {
  const backend = new MemoryBackend();
  const execute = backend.execute.bind(backend);
  let raced = false;
  backend.execute = (operation, args, data) => {
    if (!raced && operation === "writeFile" && args[0] === "/bin/bun" && args[2] === true) {
      raced = true;
      const winnerOperation = winner === "directory" ? "mkdirp" : "writeFile";
      const winnerBytes = winner === "marker" ? data : new TextEncoder().encode("concurrent caller-owned command");
      execute(winnerOperation, ["/bin/bun", false, false], winnerBytes);
    }
    return execute(operation, args, data);
  };
  return { backend, raced: () => raced };
}

for (const winner of ["file", "directory"] as const) {
  test(`real Runtime exclusive installation preserves a concurrent ${winner} winner and rolls back only its own files`, async () => {
    const race = racingBackend(winner);
    await withRuntime(async runtime => {
      const error = await installBunAdapters(runtime, { executables: ["/owned/bun", "/bin/bun"] }).catch(error => error);
      expect(error).toBeInstanceOf(BunWasmExecutableConflictError);
      expect(error).toMatchObject({ code: "BUN_WASM_EXECUTABLE_CONFLICT", path: "/bin/bun" });
      expect(race.raced()).toBe(true);
      expect(await runtime.filesystem.lookup("/owned/bun")).toBeUndefined();
      expect((await runtime.filesystem.lookup("/bin/bun"))?.kind).toBe(winner === "directory" ? "dir" : "file");
      expect(winner === "file" ? new TextDecoder().decode(await runtime.filesystem.readFile("/bin/bun")) : undefined)
        .toBe(winner === "file" ? "concurrent caller-owned command" : undefined);
      await runtime.filesystem.remove("/bin/bun");
      (await installBunAdapters(runtime)).dispose();
    }, race.backend);
  });
}

test("real Runtime shares a concurrent identical marker without a queued exclusive-create failure", async () => {
  const race = racingBackend("marker");
  await withRuntime(async runtime => {
    const installation = await installBunAdapters(runtime);
    try {
      expect(race.raced()).toBe(true);
      expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/bun"))).toBe("bun-wasm registered executable\n");
      expect(await runtime.filesystem.readFile("/bin/node")).toBeInstanceOf(Uint8Array);
      await runtime.filesystem.drain();
    } finally { installation.dispose(); }
  }, race.backend);
});

test("real Runtime rollback preserves a concurrent identical marker when a later path fails", async () => {
  const race = racingBackend("marker");
  blockParentDuringInstall(race.backend);
  await withRuntime(async runtime => {
    const error = await installBunAdapters(runtime, { executables: ["/owned/bun", "/bin/bun", "/blocked/bun"] }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("filesystem errno");
    expect(race.raced()).toBe(true);
    expect(await runtime.filesystem.lookup("/owned/bun")).toBeUndefined();
    expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/bun"))).toBe("bun-wasm registered executable\n");
    expect(new TextDecoder().decode(await runtime.filesystem.readFile("/blocked"))).toBe("caller-owned parent file");
  }, race.backend);
});

for (const order of ["before", "after"] as const) {
  test(`real Runtime preserves an unrelated queued ENOTDIR ${order} an exclusive collision`, async () => {
    const race = racingBackend("marker");
    const execute = race.backend.execute.bind(race.backend);
    let queueFailure: (() => void) | undefined;
    race.backend.execute = (operation, args, bytes) => {
      if (operation === "writeFile" && args[0] === "/bin/bun" && args[2] === true) queueFailure?.();
      return execute(operation, args, bytes);
    };
    await withRuntime(async runtime => {
      await runtime.filesystem.writeFile("/blocked", "caller-owned parent file");
      let unrelated: Promise<unknown> | undefined;
      const enqueue = () => { unrelated = runtime.filesystem.writeFile("/blocked/unrelated", "failure").catch(error => error); };
      if (order === "before") enqueue();
      else queueFailure = enqueue;
      const installation = await installBunAdapters(runtime);
      try {
        expect(race.raced()).toBe(true);
        expect(unrelated).toBeDefined();
        const failure = await unrelated;
        expect(failure).toMatchObject({ errno: 54 });
        // The caller, not the installer, owns consumption of this page-queue failure.
        await expect(runtime.filesystem.drain()).rejects.toBe(failure);
        await runtime.filesystem.drain();
        expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/bun"))).toBe("bun-wasm registered executable\n");
      } finally { installation.dispose(); }
    }, race.backend);
  });
}

test("real Runtime installer observes an undrained page write before reading through its borrowed client", async () => {
  await withRuntime(async runtime => {
    // Neither mkdir nor write has been awaited or drained when installation begins.
    const parent = runtime.filesystem.mkdirp("/bin");
    const pending = runtime.filesystem.writeFile("/bin/bun", "caller-owned queued command");
    await expect(installBunAdapters(runtime)).rejects.toBeInstanceOf(BunWasmExecutableConflictError);
    await Promise.all([parent, pending]);
    expect(new TextDecoder().decode(await runtime.filesystem.readFile("/bin/bun"))).toBe("caller-owned queued command");
    await runtime.filesystem.remove("/bin/bun");
    (await installBunAdapters(runtime)).dispose();
  });
});
