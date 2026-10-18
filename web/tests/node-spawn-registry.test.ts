import { expect, test } from "bun:test";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { createNodeExecutableRegistry, nodeExecutables, nodeModule, NodeProcessBroker } from "../scripts/node-spawn.ts";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
for (const executable of nodeExecutables) test(`Node host registry explicitly resolves ${executable}`, async () => {
  const broker = new NodeProcessBroker({ module, launch() { throw new Error("unexpected launch"); } });
  try {
    const registry = createNodeExecutableRegistry(module, broker.preopens);
    expect(await registry.resolve(executable)).toEqual({ module, adapter: "bun", interruptible: false });
  } finally { await broker.dispose(); }
});

test("Node host does not silently execute Bun for a missing registry entry", async () => {
  let launched = 0;
  const broker = new NodeProcessBroker({ module, launch() { throw new Error("unexpected launch"); } });
  const supervisor = new ProcessSupervisor({ registry: createNodeExecutableRegistry(module, broker.preopens), launch() { launched++; return { terminate() {} }; } });
  try {
    const parent = supervisor.createRoot();
    const exited = new Promise<void>(resolve => supervisor.onChildExit(() => resolve()));
    const pid = supervisor.spawn(parent, { executable: "/bin/sh", argv: ["/bin/sh", "-c", "true"], env: {}, cwd: "/", job: 0, fds: [] });
    await exited;
    expect(launched).toBe(0);
    expect(supervisor.wait(parent, pid)).toEqual({ kind: "start-failed", code: 2, error: "ENOENT", status: null });
  } finally { supervisor.dispose(); await broker.dispose(); }
});


test("Node commands only require the tools file for lint and fmt", async () => {
  const baseModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const wasmPath = "/missing-bun-wasm-tools-fixture/engine.wasm";
  for (const args of [["run", "lint"], ["-e", "fmt"], ["build", "fmt"]]) {
    expect(await nodeModule({ args, baseModule, wasmPath })).toBe(baseModule);
  }
  for (const args of [["lint"], ["--cwd", "project", "fmt"]]) {
    await expect(nodeModule({ args, baseModule, wasmPath })).rejects.toMatchObject({ code: "ENOENT" });
  }
});

for (const cancel of [false, true]) test(`Node startup diagnostic is asynchronous, exactly once and cancellable (${cancel})`, async () => {
  const errors: unknown[] = [], chunks: Uint8Array[] = [];
  const broker = new NodeProcessBroker({ module, launch() { throw new Error("unexpected launch"); }, onError(error) { errors.push(error); } });
  let blocked = true, writes = 0, released = false;
  try {
    const record = broker.supervisor.get(1)!;
    record.descriptors.openAt(2, {
      kind: "pipe", read: () => -6, write() { throw new Error("blocking write must not run"); },
      tryWrite(bytes) {
        writes++;
        if (blocked) return -6;
        const chunk = bytes[0]!.subarray(0, 7).slice(); chunks.push(chunk); return chunk.length;
      },
      readiness: () => ({ readable: false, writable: !blocked, hangup: false }),
      close() { released = true; },
    }, 64n, 0n);
    const error = Object.assign(new Error("startup once"), { code: "ENOEXEC" });
    broker.supervisor.failStart(1, error);
    broker.supervisor.failStart(1, error);
    broker.supervisor.exit(1, 1);
    expect(record.result).toBeNull();
    expect(released).toBe(false);
    expect(writes).toBe(1);
    if (cancel) {
      await broker.dispose();
      const count = writes;
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(writes).toBe(count);
      expect(chunks).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain("cancelled");
    } else {
      const completed = new Promise<void>(resolve => broker.supervisor.onChildExit(() => resolve()));
      blocked = false;
      await completed;
      expect(Buffer.concat(chunks).toString()).toBe("bun-wasm: startup once\n");
      expect(record.result).toMatchObject({ kind: "start-failed", error: "ENOEXEC" });
      expect(errors).toEqual([]);
    }
    expect(released).toBe(true);
  } finally { await broker.dispose(); }
});
