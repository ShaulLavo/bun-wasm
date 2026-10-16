import { expect, test } from "bun:test";
import { SubprocessBroker } from "../src/subprocess-broker";
import { SubprocessHost, childTransport, type ChildTransport } from "../src/subprocess.ts";
import { createFilesystemIdentity } from "../../runtime/fs";
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
