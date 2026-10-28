import { expect, test } from "bun:test";
import { createRuntime, type Runtime } from "waffle";
import { basePrograms } from "waffle-base";
import { DescriptorTable, type Stream } from "waffle/core/descriptors";
import { createWorkerProcessTransport, WorkerProcessClient, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { BrowserPrograms } from "../src/browser-programs";

const urls = {
  worker: new URL(import.meta.resolve("waffle/browser/preview1-worker")),
  shellWorker: new URL("https://example.test/shell-worker.js"),
  shell: new URL("https://example.test/programs/shell-engine.wasm"),
};

async function consumerRoot(runtime: Runtime) {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const output: string[] = [];
  await service.adoptRuntimeRoot(transport, { output: (_fd, bytes) => output.push(new TextDecoder().decode(bytes)) });
  const descriptors = new DescriptorTable();
  const write = (chunks: readonly Uint8Array[]) => {
    for (const bytes of chunks) output.push(new TextDecoder().decode(bytes));
    return chunks.reduce((total, bytes) => total + bytes.length, 0);
  };
  const terminal: Stream = { kind: "terminal", read: () => 0, write, tryWrite: write, readiness: () => ({ readable: true, writable: true, hangup: false }) };
  descriptors.openAt(1, terminal, 64n, 0n);
  descriptors.inherit(2, descriptors.get(1)!);
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport, descriptors,
    codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    postMessage: message => notices.push(message),
  });
  const supervisor = await service.ready();
  async function flush() {
    for (let message = notices.shift(); message; message = notices.shift()) await service.runtimeMessage(message, transport.pid);
  }
  return {
    descriptors, output,
    async access(path: string) {
      const id = supervisor.accessStart(transport.pid, path, "/");
      while (!supervisor.accessReady(transport.pid, id)) await Bun.sleep(1);
      return supervisor.accessTake(transport.pid, id);
    },
    async exec(executable: string, argv: string[], path: string) {
      const child = client.spawn(transport.pid, { executable, argv, env: { PATH: path }, cwd: "/", job: -1, fds: [{ parent: 1, child: 1 }, { parent: 2, child: 2 }] });
      await flush();
      await supervisor.start(child);
      const exit = await supervisor.waitForExit(transport.pid, child);
      client.wait(transport.pid, child);
      await flush();
      return exit;
    },
  };
}

async function withPrograms(run: (runtime: Runtime, programs: BrowserPrograms, fetches: string[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const fetches: string[] = [];
  globalThis.fetch = new Proxy(originalFetch, { apply(target, receiver, args) {
    fetches.push(String(args[0]));
    return Reflect.apply(target, receiver, args);
  } });
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL(import.meta.resolve("waffle/browser/fs-worker")) } });
  const programs = new BrowserPrograms(runtime, urls);
  try { await run(runtime, programs, fetches); }
  finally {
    try { await runtime.dispose(); }
    finally { await programs.dispose(); globalThis.fetch = originalFetch; }
  }
}

test("one app install publishes PATH metadata without guest downloads; which and cat execute on its runtime", async () => {
  await withPrograms(async (runtime, programs, fetches) => {
    const first = programs.ready();
    expect(programs.ready()).toBe(first);
    const installed = await first;
    expect(installed.path).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(basePrograms).toHaveLength(23);
    for (const program of basePrograms) expect((await runtime.filesystem.lookup(program.path))?.kind).toBe("file");
    expect(fetches).toEqual([]);
    const root = await consumerRoot(runtime);
    try {
      expect(await root.access("/usr/bin/cat")).toBe(0);
      expect(await root.access("/bin/cat")).toBe(0);
      expect(fetches).toEqual([]);
      expect(await root.exec("/usr/bin/which", ["which", "cat"], installed.path)).toMatchObject({ kind: "exited", code: 0 });
      expect(root.output.join("")).toContain("/usr/bin/cat");
      await runtime.filesystem.writeFile("/hello.txt", "Bun base programs\n");
      expect(await root.exec("/bin/cat", ["cat", "/hello.txt"], installed.path)).toMatchObject({ kind: "exited", code: 0 });
      expect(root.output.join("")).toContain("Bun base programs\n");
      expect(fetches.filter(url => url.endsWith("/cat.wasm"))).toHaveLength(1);
      await programs.dispose();
      expect(await runtime.filesystem.lookup("/usr/bin/cat")).toBeUndefined();
      expect(await runtime.filesystem.lookup("/bin/sh")).toBeUndefined();
      await expect(programs.ready()).rejects.toThrow("closed");
    } finally { root.descriptors.dispose(); }
  });
}, 20_000);

test("conflicting caller programs fail instead of pretending base is installed", async () => {
  await withPrograms(async (runtime, programs) => {
    await runtime.filesystem.mkdirp("/usr/bin");
    await runtime.filesystem.writeFile("/usr/bin/cat", "caller owned");
    await expect(programs.ready()).rejects.toThrow("another entry already exists");
    expect(new TextDecoder().decode(await runtime.filesystem.readFile("/usr/bin/cat"))).toBe("caller owned");
    expect(await runtime.filesystem.lookup("/usr/bin/env")).toBeUndefined();
    expect(await runtime.filesystem.lookup("/bin/sh")).toBeUndefined();
  });
});
