import { expect, test } from "bun:test";
import { createRuntime, type RuntimeOptions } from "waffle";
import { MemoryBackend } from "waffle/fs/backend";
import { FilesystemService } from "waffle/fs/service";
import type { FilesystemConnection } from "waffle/fs/protocol";
import type { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { installBunAdapters, BunWasmProcessUnavailableError, BunWasmExecutableConflictError } from "../../web/src/bun-adapter.js";

// Keep Runtime, filesystem transport/backend, executable admission and process supervisor real.
// Only the browser filesystem worker is hosted in-process; no persistent store is created.
async function withRuntime(run: (runtime: ReturnType<typeof createRuntime>, registry: () => ExecutableRegistry) => Promise<void>) {
  const originalWorker = globalThis.Worker;
  const ports: MessagePort[] = [];
  let registry!: ExecutableRegistry;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  globalThis.Worker = class {
    service = new FilesystemService(new MemoryBackend());
    addEventListener() {}
    postMessage(message: { connect: FilesystemConnection }) {
      ports.push(message.connect.port);
      this.service.connect(message.connect);
    }
    terminate() { this.service.dispose(); }
  } as unknown as typeof Worker;
  try {
    runtime = createRuntime({
      filesystem: { workerURL: "https://example.test/fs.js", persistence: false },
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

test("fresh pinned Runtime installs without options and spawning /bin/bun reaches the typed boundary", async () => {
  await withRuntime(async (runtime, getRegistry) => {
    const installation = await installBunAdapters(runtime);
    let supervisor: ProcessSupervisor | undefined;
    try {
      expect(await runtime.filesystem.readFile("/bin/bun")).toBeInstanceOf(Uint8Array);
      await runtime.processes();
      const registry = getRegistry();
      const resolveError = await registry.resolve("/bin/bun").catch(error => error);
      expect(resolveError).toBeInstanceOf(BunWasmProcessUnavailableError);
      let failure: unknown;
      supervisor = new ProcessSupervisor({ registry,
        launch: () => { throw new Error("module loading must reject before execution"); },
        startFailed: (_pid, error) => { failure = error; },
      });
      const root = supervisor.createRoot();
      const pid = supervisor.spawn(root, { executable: "/bin/bun", argv: ["bun"], env: {}, cwd: "/", fds: [], job: 0 });
      await supervisor.start(pid);
      expect(failure).toBeInstanceOf(BunWasmProcessUnavailableError);
      expect(failure).toMatchObject({ code: "BUN_WASM_PROCESS_UNAVAILABLE" });
      expect(supervisor.get(pid)?.result?.kind).toBe("start-failed");
      installation.dispose();
      expect(await runtime.filesystem.readFile("/bin/bun")).toBeInstanceOf(Uint8Array);
      (await installBunAdapters(runtime)).dispose();
    } finally { supervisor?.dispose(); installation.dispose(); }
  });
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
