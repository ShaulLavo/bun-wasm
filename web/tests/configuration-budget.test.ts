import { expect, test } from "bun:test";
import { DescriptorTable, type Stream } from "waffle/core/descriptors";
import { MemFS } from "waffle/fs/memory";
import { ProcessABI } from "waffle/proc/abi";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import type { ProcessContext } from "waffle/proc/types";

// The tool's actual five-second/eight-MiB enforcement and all error-path cleanup are
// exercised in crates/bunwasm-tools/src/configuration_process.rs. These tests cover
// its ordinary process/descriptor contract, without a configuration-only host.
const executables = ["/bin/bun", "/opt/bun/quickjs/bin/bun", "/opt/bun/jsc/bin/bun"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readable(operation: () => number): Promise<number> {
  // The generic pipe relay publishes EOF/data asynchronously after a reader asks.
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = operation();
    if (result !== -6) return result;
    await Bun.sleep(1);
  }
  throw new Error("configuration pipe stayed unreadable");
}

function fixture() {
  const registry = new ExecutableRegistry();
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  for (const path of executables) registry.register(path, { module, adapter: "preview1" });
  const contexts = new Map<number, ProcessContext>();
  const terminated: number[] = [];
  const supervisor = new ProcessSupervisor({ registry, launch(context) {
    contexts.set(context.pid, context);
    return { terminate() { terminated.push(context.pid); } };
  } });
  const descriptors = new DescriptorTable();
  const pid = supervisor.createRoot({ descriptors });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const abi = new ProcessABI({ memory, descriptors, fs: new MemFS(), pid, service: supervisor,
    signals: supervisor.get(pid)!, wait() { throw new Error("nonblocking operation slept"); } });
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const pipe = () => {
    expect(abi.imports.pipe!(32)).toBe(0);
    return [view.getUint32(32, true), view.getUint32(36, true)] as const;
  };
  const spawn = (executable = "/bin/bun") => {
    const stdin = pipe(), stdout = pipe(), stderr = pipe();
    const request = { purpose: "configuration", executable,
      argv: [executable, "--no-install", "-e", "export default { rules: {} }"],
      cwd: "/project/sub", env: { PATH: executable.slice(0, -4), VALUE: "child only" },
      job: abi.imports.job_of!(0),
      fds: [{ child: 0, parent: stdin[0] }, { child: 1, parent: stdout[1] }, { child: 2, parent: stderr[1] }] };
    const encoded = encoder.encode(JSON.stringify(request));
    bytes.set(encoded, 2048);
    const child = abi.imports.spawn!(2048, encoded.length);
    for (const fd of [stdin[0], stdin[1], stdout[1], stderr[1]]) expect(descriptors.close(fd)).toBe(true);
    expect(child).toBeGreaterThan(0);
    return { child, request, readers: [stdout[0], stderr[0]] as const };
  };
  const read = async (fd: number) => {
    const length = await readable(() => abi.imports.read!(fd, 4096, 1024));
    expect(length).toBeGreaterThanOrEqual(0);
    return decoder.decode(bytes.subarray(4096, 4096 + length));
  };
  const close = (readers: readonly number[]) => {
    for (const fd of readers) expect(descriptors.close(fd)).toBe(true);
  };
  return { supervisor, descriptors, pid, abi, view, spawn, contexts, terminated, read, close,
    dispose() { supervisor.dispose(); descriptors.dispose(); } };
}

for (const executable of executables) test(`configuration helper uses ordinary pipes and owner job at ${executable}`, async () => {
  const f = fixture();
  try {
    const { child, request, readers } = f.spawn(executable);
    await f.supervisor.start(child);
    const context = f.contexts.get(child)!;
    expect(context.request.executable).toBe(executable);
    expect(context.request.argv).toEqual(request.argv);
    expect(context.request.cwd).toBe(request.cwd);
    expect(context.request.env).toEqual(request.env);
    expect(context.job).toBe(f.supervisor.jobOf(f.pid));
    const stdin = context.descriptors.get(0)!.resource as Stream;
    expect(await readable(() => stdin.tryRead!([new Uint8Array(1)]))).toBe(0);
    for (const [fd, text] of [[1, "configuration result"], [2, "diagnostic"]] as const) {
      const stream = context.descriptors.get(fd)!.resource as Stream;
      expect(stream.tryWrite!([encoder.encode(text)])).toBe(text.length);
    }
    context.exit(0);
    expect(f.abi.imports.wait!(child, 64)).toBe(0);
    expect(f.view.getUint32(64, true)).toBe(0);
    expect(f.view.getInt32(68, true)).toBe(0);
    expect(await f.read(readers[0])).toBe("configuration result");
    expect(await f.read(readers[1])).toBe("diagnostic");
    expect(await f.read(readers[0])).toBe("");
    expect(await f.read(readers[1])).toBe("");
    f.close(readers);
    expect(f.terminated).toContain(child);
  } finally { f.dispose(); }
});

test("parallel and repeated configuration children need no reserved slots or four-child cap", async () => {
  const f = fixture();
  try {
    // Three tool owners plus their helpers can exceed the deleted host's four slots.
    const children = Array.from({ length: 6 }, (_, index) => f.spawn(executables[index % executables.length]!));
    await Promise.all(children.map(({ child }) => f.supervisor.start(child)));
    for (const { child, readers } of children) {
      f.contexts.get(child)!.exit(0);
      expect(f.abi.imports.wait!(child, 64)).toBe(0);
      f.close(readers);
    }
    for (let index = 0; index < 8; index++) {
      const { child, readers } = f.spawn();
      await f.supervisor.start(child);
      f.contexts.get(child)!.exit(0);
      expect(f.abi.imports.wait!(child, 64)).toBe(0);
      f.close(readers);
    }
    expect(f.terminated.length).toBe(14);
  } finally { f.dispose(); }
});

test("owner-job cancellation reaches configuration helpers and subsequent helpers still run", async () => {
  const f = fixture();
  try {
    const { child, readers } = f.spawn();
    await f.supervisor.start(child);
    f.supervisor.killJob(f.supervisor.jobOf(f.pid), 9);
    expect(f.abi.imports.wait!(child, 64)).toBe(0);
    expect(f.view.getUint32(64, true)).toBe(1);
    expect(f.view.getInt32(68, true)).toBe(9);
    expect(f.terminated).toContain(child);
    // Cancelling the owner revokes its descriptors as well as the helper.
    for (const fd of readers) expect(f.descriptors.get(fd)).toBeUndefined();
  } finally { f.dispose(); }
  const healthy = fixture();
  try {
    const { child, readers } = healthy.spawn();
    await healthy.supervisor.start(child);
    healthy.contexts.get(child)!.exit(0);
    expect(healthy.abi.imports.wait!(child, 64)).toBe(0);
    healthy.close(readers);
  } finally { healthy.dispose(); }
});
