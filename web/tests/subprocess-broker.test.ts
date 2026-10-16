import { expect, test } from "bun:test";
import { SubprocessBroker } from "../src/subprocess-broker";
import { SubprocessHost, childTransport, type ChildTransport } from "../src/subprocess.ts";
import { createFilesystemIdentity, revokeFilesystem, type FilesystemIdentity } from "../../runtime/fs";
import type { SharedFilesystem } from "../src/shared-fs";
import type { SpawnRequest } from "../src/worker";

function fixture(activate?: () => Promise<typeof import("../../runtime/proc")>) {
  const revoked: number[] = [];
  const filesystem = { revoke(identity: { owner: number }) { revoked.push(identity.owner); }, reap() {} } as unknown as SharedFilesystem;
  const broker = new SubprocessBroker("http://localhost/worker.js", filesystem, { activate });
  let transport!: ChildTransport;
  const host = new SubprocessHost({ output() {}, launch(_meta, value) {
    transport = value;
    const request: SpawnRequest = { executable: "missing", argv: ["missing"], cwd: "/", env: {}, pid: value.pid, parentPid: value.parentPid, jobId: value.jobId, filesystem: createFilesystemIdentity(), child: value, trace: false, spawnBroker: true };
    broker.spawn(request);
    return { terminate() {} };
  } });
  const pid = host.spawn(JSON.stringify({ argv: ["missing"] }));
  return { broker, host, pid, transport, revoked, dispose() { host.dispose(); broker.dispose(); } };
}

test("first activation returns a pid immediately and does not block an unrelated task", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const state = fixture(async () => { await barrier; return import("../../runtime/proc"); });
  try {
    expect(state.pid).toBeGreaterThan(1);
    expect(state.host.wait(state.pid)).toBe(-2);
    let ran = false;
    await new Promise<void>(resolve => setTimeout(() => { ran = true; resolve(); }, 0));
    expect(ran).toBe(true);
    expect(state.host.wait(state.pid)).toBe(-2);
    release();
    expect((await state.broker.wait(state.pid)).status).toBe(127);
    expect(state.host.wait(state.pid)).toBe(127);
  } finally { release(); state.dispose(); }
});

test("missing executable is an asynchronous child exit, not a thrown spawn error", async () => {
  const state = fixture();
  try {
    expect((await state.broker.wait(state.pid)).status).toBe(127);
    expect(state.revoked).toHaveLength(1);
    expect(state.host.wait(state.pid)).toBe(127);
  } finally { state.dispose(); }
});

test("disposing during delayed activation revokes pending children without starting them", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const state = fixture(async () => { await barrier; return import("../../runtime/proc"); });
  try {
    state.broker.dispose();
    expect(state.revoked).toHaveLength(1);
    expect(state.host.wait(state.pid)).toBe(137);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Atomics.load(new Int32Array(state.transport.interrupt), 0)).toBe(9);
  } finally { release(); state.dispose(); }
});

const fixtureModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function liveFixture(options: { quiesce?: () => Promise<void>; postFailure?: boolean } = {}) {
  const originalWorker = globalThis.Worker;
  const workers = new Map<number, FakeWorker>();
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = 0;
    postMessage(request: { pid: number }) {
      workers.set(request.pid, this);
      if (options.postFailure) throw new Error("worker post failed");
    }
    terminate() { this.terminated++; }
    exit(code = 0) { this.onmessage?.({ data: { type: "exit", code, sleep: "atomics" } } as MessageEvent); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  let quiescences = 0;
  const filesystem = {
    connect(identity: object) { return { ...identity, port: { close() {} } }; },
    revoke(identity: FilesystemIdentity) { revokeFilesystem(identity); }, reap() {},
    async quiesce(identity: FilesystemIdentity) { quiescences++; revokeFilesystem(identity); await options.quiesce?.(); },
  } as unknown as SharedFilesystem;
  const broker = new SubprocessBroker("http://localhost/worker.js", filesystem);
  broker.register("fixture", { module: fixtureModule, adapter: "preview1" });
  const transports = new Map<number, ChildTransport>();
  const hosts: SubprocessHost[] = [];
  function hostFor(parent?: ChildTransport) {
    const host = new SubprocessHost({
      budget: parent?.budget, identity: parent?.identity, pid: parent?.pid, jobId: parent?.jobId,
      slot: parent?.slot, token: parent?.token, output() {},
      onChildClose: (pid: number) => broker.close(parent?.pid ?? 1, pid),
      launch(meta, value) {
        transports.set(value.pid, value);
        broker.spawn({
          executable: "fixture", argv: meta.argv, cwd: "/", env: meta.env ?? {},
          pid: value.pid, parentPid: value.parentPid, jobId: value.jobId, job: meta.job,
          filesystem: createFilesystemIdentity(), child: value, trace: false, spawnBroker: true,
        });
        return { terminate() {} };
      },
    });
    hosts.push(host);
    return host;
  }
  const host = hostFor();
  const pid = host.spawn(JSON.stringify({ argv: ["fixture"] }));
  return {
    broker, host, pid, transports, workers, hostFor, quiescences: () => quiescences,
    async started(pid: number) { const supervisor = await broker.ready(); await supervisor.start(pid); return supervisor; },
    dispose() {
      let failure: unknown;
      try {
        for (const host of hosts) {
          host.detach();
          try { host.dispose(); } catch (error) { failure ??= error; }
        }
      } finally { broker.dispose(); globalThis.Worker = originalWorker; }
      if (failure) throw failure;
    },
  };
}
const timerTurn = () => new Promise<void>(resolve => setTimeout(resolve, 12));

test("broker observes each guest signal without replaying an interrupt consumed before its watch", async () => {
  const state = liveFixture();
  try {
    await state.started(state.pid);
    const interrupt = new Int32Array(state.transports.get(state.pid)!.interrupt);
    for (let request = 0; request < 2; request++) {
      expect(state.host.kill(state.pid, 2)).toBe(0);
      expect(Atomics.exchange(interrupt, 0, 0)).toBe(2);
      await timerTurn();
      expect(Atomics.exchange(interrupt, 0, 0)).toBe(0);
      expect(state.host.wait(state.pid)).toBe(-2);
    }
    state.workers.get(state.pid)!.exit(0);
    expect((await state.broker.wait(state.pid)).status).toBe(0);
  } finally { state.dispose(); }
});

test("direct broker kill and job kill publish once without a later watcher replay", async () => {
  const state = liveFixture();
  try {
    await state.started(state.pid);
    const transport = state.transports.get(state.pid)!;
    const interrupt = new Int32Array(transport.interrupt);
    await state.broker.kill(state.pid, 2);
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(2);
    await timerTurn();
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(0);
    await state.broker.killJob(transport.jobId, 15);
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(15);
    await timerTurn();
    expect(Atomics.exchange(interrupt, 0, 0)).toBe(0);
  } finally { state.dispose(); }
});

test("guest handle close reaps completed metadata but preserves waits and one child notification until close", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    let exits = 0;
    supervisor.onChildExit(event => { if (event.pid === state.pid) exits++; });
    const waiting = state.broker.wait(state.pid);
    state.workers.get(state.pid)!.exit(7);
    expect((await waiting).status).toBe(7);
    expect((await state.broker.wait(state.pid)).status).toBe(7);
    expect(supervisor.get(state.pid)!.request!.argv).toEqual(["fixture"]);
    expect(exits).toBe(1);
    expect(state.host.close(state.pid)).toBe(0);
    state.broker.close(1, state.pid);
    await Promise.resolve();
    expect(supervisor.get(state.pid)).toBeUndefined();
    expect(exits).toBe(1);
    await expect(state.broker.wait(state.pid)).rejects.toThrow();
  } finally { state.dispose(); }
});

test("closing a running handle resolves an existing waiter before reaping", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const waiting = state.broker.wait(state.pid);
    state.host.close(state.pid);
    state.broker.close(1, state.pid);
    expect((await waiting).status).toBe(137);
    await Promise.resolve();
    expect(supervisor.get(state.pid)).toBeUndefined();
  } finally { state.dispose(); }
});

test("completed metadata stays bounded across repeated spawn wait close cycles", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    let pid = state.pid;
    for (let run = 0; run < 12; run++) {
      await state.started(pid);
      state.workers.get(pid)!.exit(0);
      expect((await state.broker.wait(pid)).status).toBe(0);
      state.host.close(pid);
      state.broker.close(1, pid);
      await Promise.resolve();
      expect(Array.from(supervisor.table.values())).toHaveLength(1);
      if (run !== 11) pid = state.host.spawn(JSON.stringify({ argv: ["fixture"], env: { PAYLOAD: "x".repeat(4096) } }));
    }
  } finally { state.dispose(); }
});

test("parent exit reaps unowned completed children without killing running background jobs", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const nested = state.hostFor(state.transports.get(state.pid));
    const completed = nested.spawn(JSON.stringify({ argv: ["fixture"] }));
    await state.started(completed);
    state.workers.get(completed)!.exit(0);
    expect(supervisor.get(completed)).toBeDefined();
    const background = nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(background);
    state.workers.get(state.pid)!.exit(0);
    expect(supervisor.get(completed)).toBeUndefined();
    expect(supervisor.get(background)!.result).toBeNull();
    state.host.close(state.pid);
    state.broker.close(1, state.pid);
    await Promise.resolve();
    state.workers.get(background)!.exit(0);
    expect(supervisor.get(background)).toBeUndefined();
  } finally { state.dispose(); }
});

function quiescenceBarrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("logical SIGKILL resolves before quiescence, but physical termination waits for it", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    await state.broker.kill(state.pid, 9);
    expect((await state.broker.wait(state.pid)).status).toBe(137);
    expect(worker.terminated).toBe(0);
    expect(state.quiescences()).toBe(1);
    barrier.release();
    await timerTurn();
    expect(worker.terminated).toBe(1);
  } finally { barrier.release(); state.dispose(); }
});

test("disposal cannot physically stop a worker inside an unfinished filesystem section", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    state.broker.dispose();
    expect(state.host.wait(state.pid)).toBe(137);
    expect(worker.terminated).toBe(0);
    expect(state.quiescences()).toBe(1);
    barrier.release();
    await timerTurn();
    expect(worker.terminated).toBe(1);
  } finally { barrier.release(); state.dispose(); }
});

test("postMessage failure also waits for quiescence before terminating its worker", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise, postFailure: true });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    expect((await state.broker.wait(state.pid)).status).toBe(126);
    expect(worker.terminated).toBe(0);
    barrier.release();
    await timerTurn();
    expect(worker.terminated).toBe(1);
  } finally { barrier.release(); state.dispose(); }
});

test("an acknowledged ordinary exit may stop immediately without a quiescence wait", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    await state.started(state.pid);
    const worker = state.workers.get(state.pid)!;
    worker.exit(0);
    expect((await state.broker.wait(state.pid)).status).toBe(0);
    expect(worker.terminated).toBe(1);
    expect(state.quiescences()).toBe(0);
  } finally { barrier.release(); state.dispose(); }
});

test("closing a handle before activation completes cannot retain a reserved process", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const state = fixture(async () => { await barrier; return import("../../runtime/proc"); });
  try {
    state.host.close(state.pid);
    state.broker.close(1, state.pid);
    release();
    const supervisor = await state.broker.ready();
    await Promise.resolve();
    expect(supervisor.get(state.pid)).toBeUndefined();
    expect(Array.from(supervisor.table.values())).toHaveLength(1);
  } finally { release(); state.dispose(); }
});

test("a revoked parent cannot close an independent background child's handle while awaiting quiescence", async () => {
  const barrier = quiescenceBarrier();
  const state = liveFixture({ quiesce: () => barrier.promise });
  try {
    const supervisor = await state.started(state.pid);
    const nested = state.hostFor(state.transports.get(state.pid));
    const background = nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    await state.started(background);
    const parentWorker = state.workers.get(state.pid)!;
    await state.broker.kill(state.pid, 9);
    expect(parentWorker.terminated).toBe(0);
    parentWorker.onmessage?.({ data: { type: "child-close", parentPid: state.pid, pid: background } } as MessageEvent);
    await Promise.resolve();
    expect(supervisor.get(background)!.result).toBeNull();
    expect(Atomics.load(new Int32Array(state.transports.get(background)!.requestedSignal), 0)).toBe(0);
  } finally { barrier.release(); state.dispose(); }
});

test("close after guest completion waits for the worker acknowledgement without replacing its exit", async () => {
  const state = liveFixture();
  try {
    const supervisor = await state.started(state.pid);
    const waiting = state.broker.wait(state.pid);
    const transport = state.transports.get(state.pid)!;
    childTransport(transport).finish(23);
    expect(state.host.wait(state.pid)).toBe(23);
    state.host.close(state.pid);
    await Promise.resolve();
    expect(supervisor.get(state.pid)!.result).toBeNull();
    expect(Atomics.load(new Int32Array(transport.requestedSignal), 0)).toBe(0);
    state.workers.get(state.pid)!.exit(23);
    expect(await waiting).toEqual({ kind: "exited", code: 23, status: 23 });
    expect(supervisor.get(state.pid)).toBeUndefined();
    expect(Atomics.load(new Int32Array(transport.control), 1)).toBe(23);
  } finally { state.dispose(); }
});
