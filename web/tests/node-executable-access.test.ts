import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { attachPipePublicationRegistry, type PipePublicationRegistryHandle } from "waffle/proc/pipes";
import { createWorkerProcessTransport, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { NodeProcessBroker, type NodeEngineModules } from "../scripts/node-spawn.ts";
import { createNodeProcess, type NodeWasiImports } from "../scripts/node-process.ts";

function moduleWithStatus(code: number) {
  return new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,115,116,97,116,117,115,0,0,10,6,1,4,0,65,code,11]));
}
const module = moduleWithStatus(3), quickjs = moduleWithStatus(7), jsc = moduleWithStatus(11);
function fixture(engines: NodeEngineModules = {}) {
  const errors: unknown[] = [], messages: WorkerProcessMessage[] = [];
  const broker = new NodeProcessBroker({ module, engines, onError: error => errors.push(error), launch(context) {
    return new Worker(new URL("./fixtures/node-executable-worker.ts", import.meta.url), { workerData: { module: context.module } });
  } });
  const host = createNodeProcess({ transport: broker.root, registry: (broker.root.data as { registry: PipePublicationRegistryHandle }).registry,
    postMessage: message => messages.push(structuredClone(message)), finish(): never { throw new Error("unexpected guest exit"); } });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { proc } = host.install({ wasi_snapshot_preview1: { sock_send: () => 52 } } as NodeWasiImports,
    () => ({ exports: { memory } }) as unknown as WebAssembly.Instance);
  const put = (text: string, ptr: number) => { const bytes = new TextEncoder().encode(text); new Uint8Array(memory.buffer).set(bytes, ptr); return bytes.length; };
  const deliver = () => Promise.all(messages.splice(0).map(message => broker.broker.handle(message, host.client.pid)));
  return { broker, host, proc, memory, errors, messages, deliver,
    start(path: string, cwd = "/", mode = 1) { return proc.access_start!(1024, put(path, 1024), 2048, put(cwd, 2048), mode); },
    poll(id: number) { const view = new DataView(memory.buffer); view.setUint32(256, 5, true); view.setUint32(260, id, true); view.setBigUint64(264, 99n, true); return proc.poll!(256, 1, 0, 512); },
    async query(path: string, cwd = "/") { const id = this.start(path, cwd); expect(id).toBeGreaterThan(0); await deliver(); return proc.access_take!(id); },
    async spawn(path: string, cwd = "/") {
      const pid = host.client.spawn(host.client.pid, { executable: path, argv: [path], cwd, env: {}, fds: [], job: 0 });
      await deliver();
      return broker.supervisor.waitForExit(host.client.pid, pid);
    },
    async close() { host.dispose(); await broker.dispose(); },
  };
}

for (const engines of [{}, { quickjs }, { jsc }, { quickjs, jsc }]) test(`Node mounts only configured engine executables: ${Object.keys(engines).join(",") || "default"}`, async () => {
  const f = fixture(engines);
  try {
    expect(Object.keys(f.broker.preopens).slice(0, 3)).toEqual(["/", "/bin", "/opt/bun"]);
    for (const name of ["bun", "node"]) {
      expect(readFileSync(join(f.broker.preopens["/bin"]!, name))).toEqual(Buffer.alloc(0));
      expect(await f.query(`/bin/${name}`)).toBe(0);
      expect((await f.spawn(`/bin/${name}`)).status).toBe(3);
      for (const [engine, status] of [["quickjs", 7], ["jsc", 11]] as const) {
        const path = `/opt/bun/${engine}/bin/${name}`, native = join(f.broker.preopens["/opt/bun"]!, engine, "bin", name);
        expect(existsSync(native)).toBe(engine in engines);
        expect(await f.query(path)).toBe(engine in engines ? 0 : -44);
        const result = await f.spawn(path);
        if (engine in engines) expect(result.status).toBe(status);
        else expect(result).toMatchObject({ kind: "start-failed", error: "ENOENT" });
      }
    }
  } finally { await f.close(); }
});

for (const [path, expected, error] of [
  ["bun", -44, "ENOENT"], ["node", -44, "ENOENT"], ["/bun", -44, "ENOENT"], ["/node", -44, "ENOENT"],
  ["/usr/local/bin/bun", -44, "ENOENT"], ["/usr/local/bin/node", -44, "ENOENT"], ["/missing", -44, "ENOENT"],
  ["/bin", -2, "EACCES"], ["/bin/plain", -2, "EACCES"], ["/bin/bun/child", -54, "ENOTDIR"],
  ["/bin/bun/../bun", -54, "ENOTDIR"], ["/bin/bun/", -54, "ENOTDIR"], ["/absent/../bin/bun", -44, "ENOENT"],
] as const) test(`Node live admission ${path} gives ${error}`, async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.broker.preopens["/bin"]!, "plain"), "not executable");
    expect(await f.query(path)).toBe(expected);
    if (error !== "ENOTDIR") expect(await f.spawn(path)).toMatchObject({ kind: "start-failed", error });
  } finally { await f.close(); }
});

test("Node admission follows guest symlinks and rechecks live files and registrations", async () => {
  const f = fixture();
  try {
    const bin = f.broker.preopens["/bin"]!;
    symlinkSync("/bin/node", join(bin, "alias"));
    // Canonical-target admission does not register the link's distinct path.
    expect(await f.query("/bin/alias")).toBe(-2);
    expect(await f.spawn("/bin/alias")).toMatchObject({ error: "EACCES" });
    expect(await f.query("node", "/bin")).toBe(0);
    f.broker.registry.unregister("/bin/bun");
    expect(await f.query("/bin/bun")).toBe(-2);
    expect(await f.spawn("/bin/bun")).toMatchObject({ error: "EACCES" });
    rmSync(join(bin, "node"));
    expect(await f.query("/bin/node")).toBe(-44);
    expect(await f.spawn("/bin/node")).toMatchObject({ error: "ENOENT" });
    mkdirSync(join(bin, "node"));
    expect(await f.query("/bin/node")).toBe(-2);
    expect(await f.spawn("/bin/node")).toMatchObject({ error: "EACCES" });
  } finally { await f.close(); }
});

test("Node access imports preserve pending/poll, consuming take, cancellation, ownership, bounds and monotonic IDs", async () => {
  const f = fixture();
  const foreign = createNodeProcess({ transport: createWorkerProcessTransport({ pid: 99 }), postMessage() {}, finish(): never { throw new Error("unexpected exit"); } });
  try {
    const first = f.start("/bin/bun"); expect(first).toBeGreaterThan(0);
    expect(f.proc.access_take!(first)).toBe(-6); expect(f.poll(first)).toBe(0);
    expect(() => foreign.client.accessTake(99, first)).toThrow("unknown executable query");
    const sequence = Atomics.load(f.host.client.wake, 0);
    await f.deliver(); expect(Atomics.load(f.host.client.wake, 0)).toBeGreaterThan(sequence);
    expect(f.poll(first)).toBe(1); expect(f.proc.access_take!(first)).toBe(0);
    expect(f.proc.access_take!(first)).toBe(-8); expect(f.proc.access_cancel!(first)).toBe(-8); expect(f.poll(first)).toBe(-8);
    const cancelled = f.start("/bin/node"); expect(cancelled).toBeGreaterThan(first);
    expect(f.proc.access_cancel!(cancelled)).toBe(0); await f.deliver();
    expect(f.proc.access_take!(cancelled)).toBe(-8); expect(f.proc.access_cancel!(cancelled)).toBe(-8);
    expect(f.proc.access_take!(cancelled + 1000)).toBe(-8);
    const ids = Array.from({ length: 64 }, () => f.start("/bin/node")); expect(ids.every(id => id > cancelled)).toBe(true);
    expect(f.start("/bin/node")).toBe(-6); await f.deliver(); expect(f.start("/bin/node")).toBe(-6);
    expect(f.proc.access_take!(ids[0]!)).toBe(0);
    const next = f.start("/bin/bun"); expect(next).toBeGreaterThan(ids.at(-1)!);
    expect(f.proc.access_cancel!(next)).toBe(0); await f.deliver();
    for (const mode of [0, 2, -1]) expect(f.start("/bin/bun", "/", mode)).toBe(-28);
    for (const [path, cwd] of [["", "/"], ["a\0b", "/"], ["/bin/bun", "relative"]]) expect(f.start(path!, cwd!)).toBe(-28);
  } finally { foreign.dispose(); await f.close(); }
});

test("Node root is enrolled before stdin publication and private executable files are removed after disposal", async () => {
  const f = fixture({ quickjs, jsc });
  const nativeRoot = f.broker.preopens["/"]!;
  try {
    const registry = attachPipePublicationRegistry((f.broker.root.data as { registry: PipePublicationRegistryHandle }).registry);
    expect(registry.processCount).toBe(1); expect(registry.isRevoked(f.host.client.pid)).toBe(false);
    expect(f.host.descriptors.get(0)?.resource.kind).toBe("pipe");
    expect(existsSync(nativeRoot)).toBe(true);
  } finally { await f.close(); }
  expect(existsSync(nativeRoot)).toBe(false); await f.broker.dispose();
});

// Process records retain host errno 20; runtime_proc waits encode its positive WASI errno 54.
for (const path of ["/bin/bun/child", "/bin/bun/../bun", "/bin/bun/"]) {
  test(`Node spawn ${path} preserves ENOTDIR`, async () => {
    const f = fixture();
    try { expect(await f.spawn(path)).toMatchObject({ kind: "start-failed", code: 20, error: "ENOTDIR", status: null }); }
    finally { await f.close(); }
  });
}
