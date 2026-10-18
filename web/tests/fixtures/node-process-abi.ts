// Native Node integration without a built Bun guest: exercise the actual ABI in fresh workers.
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { NodeProcessBroker } from "../../scripts/node-spawn.ts";
import { createNodeProcess, type NodeWasiImports } from "../../scripts/node-process.ts";
import { workerProcessState, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { createNodeSignalController } from "../../scripts/node-signals.ts";
import type { SpawnRequest } from "waffle/proc/types";
import type { PipePublicationRegistryHandle } from "waffle/proc/pipes";
import { markStarted } from "waffle/proc/outcome";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
if (isMainThread) {
  const broker = new NodeProcessBroker({ module, launch(context, transport) {
    return new Worker(new URL(import.meta.url), { workerData: { transport, request: context.request } });
  } });
  broker.pipeStdin();
  const root = new Worker(new URL(import.meta.url), { workerData: { transport: broker.root } });
  broker.attach(root, broker.root);
  let timer: ReturnType<typeof setTimeout>;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Node ABI fixture timed out")), 15000);
      root.on("message", message => { if (message?.result) console.log(JSON.stringify(message.result)); });
      root.on("exit", resolve); root.on("error", reject);
    });
    assert.equal(status, 0);
  } finally { clearTimeout(timer!); await broker.dispose(); await root.terminate(); }
} else {
  const transport = workerData.transport as WorkerProcessTransport;
  const request = workerData.request as SpawnRequest | undefined;
  const signals = createNodeSignalController(workerProcessState(transport).signals);
  const host = createNodeProcess({ transport,
    registry: (transport.data as { registry?: PipePublicationRegistryHandle })?.registry,
    postMessage: message => parentPort!.postMessage(message),
    finish(code, signal): never { const selected = signals.finish(code, signal); process.exit(selected.status); },
  });
  const memory = new WebAssembly.Memory({ initial: 8 });
  const wasi = { sock_send: () => 52, fd_read: () => 8, fd_write: () => 8, fd_close: () => 8 };
  const { proc } = host.install({ wasi_snapshot_preview1: wasi } as NodeWasiImports, () => ({ exports: { memory } }) as unknown as WebAssembly.Instance);
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const finish = (code: number) => { host.client.exit(code); host.dispose(); process.exit(code); };
  const pipe = () => {
    assert.equal(proc.pipe!(0), 0);
    return [view().getUint32(0, true), view().getUint32(4, true)] as const;
  };
  const spawn = (executable: string, fds: SpawnRequest["fds"], action: string) => {
    const json = new TextEncoder().encode(JSON.stringify({ executable, argv: [executable], cwd: "/", env: { action }, job: 0, fds }));
    bytes().set(json, 64);
    const pid = proc.spawn!(64, json.length);
    assert.ok(pid > 1, `spawn returned ${pid}`);
    return pid;
  };
  const wait = (pid: number) => {
    for (;;) {
      const result = proc.wait!(pid, 8);
      if (result === 0) return [view().getUint32(8, true), view().getInt32(12, true)];
      assert.equal(result, -6);
      proc.poll!(0, 0, 1, 0);
    }
  };
  const pollFd = (fd: number, writing: boolean) => {
    view().setUint32(16, writing ? 1 : 0, true); view().setUint32(20, fd, true); view().setBigUint64(24, 42n, true);
    assert.ok(proc.poll!(16, 1, 1000, 32) >= 0);
  };
  if (request?.env.action === "throw-before-entry") throw new Error("node-before-entry");
  if (!markStarted(host.client.signals.outcome)) finish(0);
  if (request?.env.action === "throw-after-entry") throw new Error("node-after-entry");
  try {
    if (request?.env.action === "spin") for (;;) {}
    if (request?.env.action === "omitted") {
      assert.equal(proc.read!(9, 1024, 1), -8);
      assert.equal(proc.write!(12, 1024, 1), -8);
      assert.equal(wasi.fd_read(0, 0, 0, 0), 8);
      assert.equal(wasi.fd_write(1, 0, 0, 0), 8);
      finish(0);
    }
    if (request?.env.action === "echo") {
      const grandchild = spawn("/bin/bun", [], "omitted");
      assert.deepEqual(wait(grandchild), [0, 0]);
      for (;;) {
        const count = proc.read!(9, 1024, 4096);
        if (count === 0) break;
        if (count === -6) { pollFd(9, false); continue; }
        assert.ok(count > 0);
        let offset = 0;
        while (offset < count) {
          const written = proc.write!(12, 1024 + offset, count - offset);
          if (written === -6) { pollFd(12, true); continue; }
          assert.ok(written > 0); offset += written;
        }
      }
      finish(7);
    }
    let stdinBytes = 0;
    for (;;) {
      const count = proc.read!(0, 1024, 4096);
      if (count === 0) break;
      if (count === -6) { pollFd(0, false); continue; }
      assert.ok(count > 0); stdinBytes += count;
      assert.ok(bytes().subarray(1024, 1024 + count).every(value => value === 115));
    }
    const [input, write] = pipe(), [read, output] = pipe();
    const duplicate = proc.dup!(write); assert.ok(duplicate > write); assert.equal(proc.close!(duplicate), 0);
    const pid = spawn("/bin/bun", [{ child: 9, parent: input }, { child: 12, parent: output }], "echo");
    const job = proc.job_of!(pid); assert.ok(job > 1);
    assert.equal(proc.close!(input), 0); assert.equal(proc.close!(output), 0);
    const length = 200000;
    bytes().fill(42, 4096, 4096 + length);
    let sent = 0, received = 0, closed = false;
    while (received < length) {
      if (sent < length) {
        const count = proc.write!(write, 4096 + sent, length - sent);
        if (count > 0) sent += count; else assert.equal(count, -6);
      } else if (!closed) { assert.equal(proc.close!(write), 0); closed = true; }
      const count = proc.read!(read, 300000, Math.min(65536, length - received));
      if (count > 0) {
        assert.ok(bytes().subarray(300000, 300000 + count).every(value => value === 42)); received += count;
      } else { assert.equal(count, -6); proc.poll!(0, 0, 1, 0); }
    }
    if (!closed) assert.equal(proc.close!(write), 0);
    assert.deepEqual(wait(pid), [0, 7]);
    assert.equal(proc.wait_job!(job, 0, 0), 0); assert.deepEqual([view().getInt32(0, true), view().getInt32(4, true)], [0, 7]);
    assert.equal(proc.read!(read, 1024, 1), 0); assert.equal(proc.close!(read), 0);
    assert.deepEqual(wait(spawn("missing", [], "")), [2, 44]);
    const [diagnosticRead, diagnosticWrite] = pipe();
    const failed = spawn("/bin/bun", [{ child: 2, parent: diagnosticWrite }], "throw-before-entry");
    assert.equal(proc.close!(diagnosticWrite), 0);
    assert.deepEqual(wait(failed), [2, 29]);
    const diagnosticLength = proc.read!(diagnosticRead, 1024, 4096);
    assert.ok(diagnosticLength > 0);
    assert.match(new TextDecoder().decode(bytes().subarray(1024, 1024 + diagnosticLength)), /node-before-entry/);
    assert.equal(proc.read!(diagnosticRead, 1024, 1), 0);
    assert.equal(proc.close!(diagnosticRead), 0);
    // No stderr binding: an entered worker crash must not write to the controller's stderr.
    assert.deepEqual(wait(spawn("/bin/bun", [], "throw-after-entry")), [0, 126]);
    const killed = spawn("/bin/bun", [], "spin");
    view().setUint32(16, 6, true); view().setInt32(20, killed, true); view().setBigUint64(24, 43n, true);
    assert.equal(proc.poll!(16, 1, 5000, 32), 1);
    assert.equal(view().getUint32(32, true), 43); assert.equal(view().getUint32(40, true), 6);
    assert.equal(proc.start_status!(killed), 0);
    assert.equal(proc.kill!(killed, 9), 0);
    assert.equal(proc.start_status!(killed), 0);
    assert.deepEqual(wait(killed), [1, 9]);
    assert.equal(proc.start_status!(killed), -12);
    const group = spawn("/bin/node", [], "spin"), groupJob = proc.job_of!(group);
    assert.equal(proc.kill_job!(groupJob, 15), 0); assert.deepEqual(wait(group), [1, 15]);
    assert.equal(proc.wait_job!(groupJob, 0, 0), 0); assert.deepEqual([view().getInt32(0, true), view().getInt32(4, true)], [1, 15]);
    parentPort!.postMessage({ result: { bytes: received, stdinBytes, exit: 7, missing: 127, signal: 9, groupSignal: 15, omitted: true } });
    finish(0);
  } catch (error) { console.error(error); finish(1); }
}
