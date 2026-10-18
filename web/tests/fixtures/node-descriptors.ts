import { controlStore } from "waffle/proc/control";
// Exercise the actual Node WASI fd table, not a stub that happens to choose different numbers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { Worker } from "node:worker_threads";
import { OpenDescription } from "waffle/core/descriptors";
import { createWorkerProcessTransport, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import type { SpawnRequest } from "waffle/proc/types";
import { WorkerPipeBroker } from "waffle/proc/worker-pipes";
import { createNodeProcess, type NodeWasiImports } from "../../scripts/node-process.ts";

// Original minimal guest with exported memory and an empty _start. Starting Node WASI binds
// its memory so the fixture can then call the exact imports a compiled guest would call.
const guest = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0, 5,3,1,0,1,
  7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0, 10,4,1,2,0,11,
]));
const encoder = new TextEncoder(), decoder = new TextDecoder();
const all = (1n << 29n) - 1n;
const owned: ReturnType<typeof createNodeProcess>[] = [];
const pipeBroker = new WorkerPipeBroker();
const scratch = process.argv[2] ?? mkdtempSync("/work/tmp/bun-wasm-node-fds-");
function setup(preopenCount = 0, transport = createWorkerProcessTransport(), env: Record<string, string> = {}) {
  const messages: WorkerProcessMessage[] = [];
  const host = createNodeProcess({ transport, preopenCount, env,
    postMessage(message) {
      messages.push(message);
      if (message.operation === "pipe") pipeBroker.attach(message.handle as Parameters<WorkerPipeBroker["attach"]>[0]);
    }, finish(code): never { throw new Error(`unexpected exit ${code}`); },
  });
  owned.push(host);
  const preopens = Object.fromEntries(Array.from({ length: preopenCount }, (_, i) => [`/mount-${i}`, scratch]));
  const wasi = new WASI({ version: "preview1", preopens, env: host.env, args: [], returnOnExit: true });
  const imports = wasi.getImportObject() as NodeWasiImports;
  let instance: WebAssembly.Instance;
  const { proc } = host.install(imports, () => instance);
  instance = new WebAssembly.Instance(guest, imports);
  wasi.start(instance as Parameters<typeof wasi.start>[0]);
  const memory = instance.exports.memory as WebAssembly.Memory;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const call = (name: string, ...args: (number | bigint)[]) => imports.wasi_snapshot_preview1[name]!(...args as number[]);
  const open = (path = "data", directory = 3, flags = 0) => {
    const name = encoder.encode(path); bytes().set(name, 256);
    const rights = 2n | 4n | 32n | 64n | (1n << 21n) | (1n << 27n);
    assert.equal(call("path_open", directory, 0, 256, name.length, flags, rights, 0n, 0, 128), 0);
    return view().getUint32(128, true);
  };
  const pipe = () => {
    assert.equal(proc.pipe!(0), 0);
    return [view().getUint32(0, true), view().getUint32(4, true)] as const;
  };
  const spawn = (request: SpawnRequest) => {
    const text = encoder.encode(JSON.stringify(request)); bytes().set(text, 4096);
    return proc.spawn!(4096, text.length);
  };
  const read = (fd: number) => {
    let result = proc.read!(fd, 512, 1);
    if (result === -6) { pipeBroker.pump(); result = proc.read!(fd, 512, 1); }
    return result;
  };
  const poll = (subscriptions: { type: number; fd?: number; timeout?: bigint; userdata?: bigint }[]) => {
    bytes().fill(0, 1024, 3076);
    subscriptions.forEach((item, index) => {
      const ptr = 1024 + index * 48;
      view().setBigUint64(ptr, item.userdata ?? BigInt(index), true);
      view().setUint8(ptr + 8, item.type); view().setUint32(ptr + 16, item.fd ?? 1, true);
      if (item.type === 0) view().setBigUint64(ptr + 24, item.timeout ?? 0n, true);
    });
    const status = call("poll_oneoff", 1024, 2048, subscriptions.length, 3072);
    const events = status ? [] : Array.from({ length: view().getUint32(3072, true) }, (_, index) => {
      const ptr = 2048 + index * 32;
      return { userdata: view().getBigUint64(ptr, true), error: view().getUint16(ptr + 8, true),
        type: view().getUint8(ptr + 10), nbytes: view().getBigUint64(ptr + 16, true) };
    });
    return { status, events };
  };
  const value = { host, proc, messages, memory, view, bytes, call, open, pipe, spawn, read, poll };
  return value;
}
const request = (fds: SpawnRequest["fds"] = [], env = {}): SpawnRequest => ({ executable: "bun", argv: ["bun"], cwd: "/", env, job: 0, fds });
const latestSpawn = (f: ReturnType<typeof setup>) => {
  const message = f.messages.findLast(message => message.operation === "spawn");
  assert.ok(message?.operation === "spawn");
  return message;
};
function fileContents(f: ReturnType<typeof setup>, fd: number) {
  assert.equal(f.call("fd_seek", fd, 0n, 0, 160), 0);
  f.view().setUint32(192, 512, true); f.view().setUint32(196, 32, true);
  assert.equal(f.call("fd_read", fd, 192, 1, 200), 0);
  return decoder.decode(f.bytes().subarray(512, 512 + f.view().getUint32(200, true)));
}
try {
  writeFileSync(`${scratch}/data`, "file-data");
  for (const count of [1, 4, 9]) {
    const parent = setup(count), [input, inputWriter] = parent.pipe(), [outputReader, output] = parent.pipe();
    assert.ok(input >= count + 3 && input < 65535);
    const env = { BUNWASM_WORKER_CONTROL: JSON.stringify({ input, output }) };
    assert.ok(parent.spawn(request([{ child: input, parent: input }, { child: output, parent: output }], env)) > 1);
    const message = latestSpawn(parent);
    // Child may have a different number of preopens than its parent.
    const child = setup(count + 2, message.transport, message.request.env);
    const controls = JSON.parse(child.host.env.BUNWASM_WORKER_CONTROL!) as { input: number; output: number };
    assert.equal(controls.input, count + 5);
    assert.equal(controls.output, count + 6);
    assert.deepEqual(message.request.env, env); // relocation does not mutate the parent's snapshot
    for (let fd = 3; fd < count + 5; fd++) assert.equal(child.call("fd_prestat_get", fd, 128), 0);
    assert.equal(child.call("fd_prestat_get", controls.input, 128), 8);
    parent.bytes()[512] = 41;
    assert.equal(parent.proc.write!(inputWriter, 512, 1), 1);
    pipeBroker.pump();
    assert.equal(child.read(controls.input), 1);
    assert.equal(child.proc.write!(controls.output, 512, 1), 1);
    pipeBroker.pump();
    assert.equal(parent.read(outputReader), 1);
    assert.equal(child.bytes()[512], 41);

    // A native path_open initially returns a private number that equals a control fd. Its
    // translated guest result, metadata, reads, closes and renumbers must never hit that pipe.
    const opened = child.open();
    assert.ok(opened > controls.output);
    assert.equal(fileContents(child, opened), "file-data");
    assert.equal(child.call("fd_fdstat_get", controls.input, 128), 0);
    assert.equal(child.view().getUint8(128), 6);
    assert.equal(child.call("fd_filestat_get", opened, 128), 0);
    assert.equal(child.view().getUint8(144), 4);
    assert.equal(child.call("fd_seek", opened, 0n, 0, 160), 0);
    const polled = child.poll([{ type: 1, fd: opened }]);
    // Node's libuv poll may return PERM for regular files; preserve that native result.
    assert.ok([0, 63].includes(polled.status));
    assert.equal(child.view().getUint32(1040, true), opened, "native poll restores the guest subscription");
    const mixed = child.poll([{ type: 1, fd: opened }, { type: 2, fd: controls.output }]);
    assert.equal(mixed.status, polled.status);
    if (mixed.status === 0) {
      assert.deepEqual(mixed.events.map(event => event.error), [polled.events[0]!.error, 0]);
      assert.equal(mixed.events[0]!.nbytes, polled.events[0]!.nbytes);
    }
    assert.equal(child.view().getUint32(1040, true), opened);
    // A stale interrupt hint must not manufacture EINTR; authoritative handled state must,
    // even when a racing consumer has already cleared the hint.
    controlStore(child.host.client.signals.interrupt, 0, 15);
    assert.equal(child.poll([{ type: 2, fd: controls.output }]).status, 0);
    controlStore(child.host.client.signals.signalState, 15, 6);
    controlStore(child.host.client.signals.interrupt, 0, 0);
    assert.equal(child.poll([{ type: 2, fd: controls.output }]).status, 27);
    controlStore(child.host.client.signals.signalState, 15, 0);
    const publisher = new Worker(new URL("./node-descriptor-signal.ts", import.meta.url), {
      workerData: child.host.client.signals.signalState,
    });
    try {
      await new Promise<void>((resolve, reject) => { publisher.once("message", () => resolve()); publisher.once("error", reject); });
      assert.equal(child.poll([{ type: 0, timeout: 2000000000n }, { type: 1, fd: controls.input }]).status, 27);
    } finally { await publisher.terminate(); controlStore(child.host.client.signals.signalState, 15, 0); }
    assert.deepEqual(child.poll([{ type: 0 }, { type: 0, timeout: 60000000000n }, { type: 1, fd: controls.input }]).events
      .map(event => event.userdata), [0n]);
    for (let index = 0; index < 50; index++) {
      const fd = child.open();
      assert.equal(fileContents(child, fd), "file-data");
      assert.equal(child.call("fd_close", fd), 0);
      assert.equal(child.call("fd_close", fd), 8);
      assert.equal(child.call("fd_prestat_get", controls.output, 128), 8);
      assert.ok(child.host.descriptors.get(controls.input));
      assert.ok(child.host.descriptors.get(controls.output));
    }
    const [target, targetWriter] = child.pipe();
    const inputDescription = child.host.descriptors.get(controls.input)!.description;
    assert.equal(child.call("fd_renumber", controls.input, target), 0);
    assert.equal(child.call("fd_fdstat_get", controls.input, 128), 8);
    assert.equal(child.call("fd_renumber", controls.input, controls.input), 8);
    assert.equal(child.call("fd_renumber", target, 2147483647), 8);
    assert.equal(child.call("fd_renumber", target, target), 0);
    assert.equal(child.host.descriptors.get(target)!.description, inputDescription);
    const fileDescription = child.host.descriptors.get(opened)!.description;
    assert.equal(child.call("fd_renumber", opened, target), 0);
    assert.equal(child.host.descriptors.get(target)!.description, fileDescription);
    assert.equal(inputDescription.references, 0);
    assert.equal(child.call("fd_fdstat_get", opened, 128), 8);
    assert.equal(fileContents(child, target), "file-data");
    assert.equal(child.call("fd_renumber", target, controls.output), 0);
    assert.equal(fileContents(child, controls.output), "file-data");
    assert.equal(child.call("fd_close", controls.output), 0);
    assert.equal(child.call("fd_close", targetWriter), 0);
    const replacement = child.open();
    assert.equal(fileContents(child, replacement), "file-data");
    assert.equal(child.call("fd_fdstat_get", controls.output, 128), 8);

    // Neither the parent's controls nor its metadata are implicitly copied to grandchildren.
    assert.ok(child.spawn(request()) > 1);
    const grandchildMessage = latestSpawn(child);
    assert.deepEqual(grandchildMessage.transport.bindings, []);
    const grandchild = setup(count + 2, grandchildMessage.transport, grandchildMessage.request.env);
    assert.equal(grandchild.host.env.BUNWASM_WORKER_CONTROL, undefined);
    assert.equal(grandchild.call("fd_fdstat_get", controls.input, 128), 8);
    assert.equal(grandchild.call("fd_fdstat_get", controls.output, 128), 8);
  }

  // Explicit inherited bindings are not silently shadowed by the native preopen namespace.
  const parent = setup(3), [read] = parent.pipe(), [input] = parent.pipe(), [, output] = parent.pipe();
  assert.ok(parent.spawn(request([{ child: 3, parent: read }, { child: input, parent: input }, { child: output, parent: output }],
    { BUNWASM_WORKER_CONTROL: JSON.stringify({ input, output }) })) > 1);
  const childMessage = latestSpawn(parent), child = setup(3, childMessage.transport, childMessage.request.env);
  assert.deepEqual(JSON.parse(child.host.env.BUNWASM_WORKER_CONTROL!), { input: 7, output: 8 });
  assert.equal(child.call("fd_prestat_get", 3, 128), 8);
  assert.equal(child.call("fd_fdstat_get", 3, 128), 0);
  assert.equal(child.view().getUint8(128), 6);
  for (const fd of [4, 5, 6]) assert.equal(child.call("fd_prestat_get", fd, 128), 0);
  const paths = (from: string, to: string) => {
    const first = encoder.encode(from), second = encoder.encode(to);
    child.bytes().set(first, 256); child.bytes().set(second, 320);
    return [first.length, second.length];
  };
  let [fromLength, toLength] = paths("data", "linked");
  assert.equal(child.call("path_link", 4, 0, 256, fromLength!, 5, 320, toLength!), 0);
  [fromLength, toLength] = paths("linked", "moved");
  assert.equal(child.call("path_rename", 5, 256, fromLength!, 6, 320, toLength!), 0);
  [fromLength, toLength] = paths("moved", "symbolic");
  assert.equal(child.call("path_symlink", 256, fromLength!, 4, 320, toLength!), 0);
  assert.equal(readFileSync(`${scratch}/symbolic`, "utf8"), "file-data");
  assert.equal(child.call("path_unlink_file", 4, 320, toLength!), 0);
  assert.equal(child.call("path_unlink_file", 5, 256, fromLength!), 0);
  assert.equal(child.call("path_filestat_get", 3, 0, 256, fromLength!, 128), 8);

  // A real native filesystem binding reaches the Node transfer codec and returns ProcessError
  // BADF through ProcessABI, exactly like the native Rust service's shared request fixture.
  const fixtures = JSON.parse(readFileSync(new URL("../../../tests/fixtures/runtime-proc-spawn-requests.json", import.meta.url), "utf8")) as { name: string; request: SpawnRequest }[];
  const fixture = fixtures.find(item => item.name === "untransferable parent descriptor");
  assert.ok(fixture, "shared fixture must contain 'untransferable parent descriptor'");
  assert.deepEqual(fixture.request.fds, [{ parent: 91, child: 9 }]);
  const native = parent.open();
  const source = parent.host.descriptors.get(native)!;
  parent.host.descriptors.inherit(91, source);
  assert.equal(parent.spawn(fixture.request), -8);
  const unsupported = new OpenDescription({ kind: "terminal", read: () => 0, write: () => 0, readiness: () => ({ readable: true, writable: true, hangup: false }) });
  parent.host.descriptors.inherit(91, { description: unsupported, resource: unsupported.resource, rightsBase: all, rightsInheriting: 0n });
  assert.equal(parent.spawn(fixture.request), -8);
  assert.equal(parent.messages.filter(message => message.operation === "spawn").length, 1);
  console.log("Node descriptor translation, dynamic controls, churn, renumber, isolation and shared BADF checks passed");
} finally {
  try { for (const host of owned.toReversed()) host.dispose(); }
  finally { pipeBroker.dispose(); rmSync(scratch, { recursive: true, force: true }); }
}
