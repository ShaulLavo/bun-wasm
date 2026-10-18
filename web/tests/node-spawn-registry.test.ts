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
