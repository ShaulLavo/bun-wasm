import { expect, test } from "bun:test";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { createNodeExecutableRegistry, nodeExecutables } from "../scripts/node-spawn.ts";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
for (const executable of nodeExecutables) test(`Node host registry explicitly resolves ${executable}`, async () => {
  const registry = createNodeExecutableRegistry(module);
  expect(await registry.resolve(executable)).toEqual({ module, adapter: "bun", interruptible: false });
});

test("Node host does not silently execute Bun for a missing registry entry", async () => {
  let launched = 0;
  const supervisor = new ProcessSupervisor({ registry: createNodeExecutableRegistry(module), launch() { launched++; return { terminate() {} }; } });
  try {
    const parent = supervisor.createRoot();
    const exited = new Promise<void>(resolve => supervisor.onChildExit(() => resolve()));
    const pid = supervisor.spawn(parent, { executable: "/bin/sh", argv: ["/bin/sh", "-c", "true"], env: {}, cwd: "/", job: 0, fds: [] });
    await exited;
    expect(launched).toBe(0);
    expect(supervisor.wait(parent, pid)).toEqual({ kind: "exited", code: 127, status: 127 });
  } finally { supervisor.dispose(); }
});
