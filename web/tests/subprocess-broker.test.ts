import { expect, test } from "bun:test";
import { readOutcome } from "waffle/proc/outcome";
import { setSignalDisposition, takeSignal } from "waffle/proc/signals";
import { workerProcessState } from "waffle/proc/worker-client";
import type { RunRequest } from "../src/bun-executor";
import { SubprocessBroker } from "../src/subprocess-broker";
import { importingModule, rootFixture } from "./process-root-fixture";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

test("third-party preview1 programs need source bytes or an explicit cooperative assertion", () => {
  const state = rootFixture();
  try {
    expect(() => state.broker.register("tool", { module: importingModule("poll"), adapter: "preview1" } as never)).toThrow("explicit cooperative assertion");
    state.broker.register("bytes", { adapter: "preview1", bytes: wasm });
    state.broker.register("cooperative", { adapter: "preview1", module: importingModule("poll"), cooperative: true });
    state.broker.register("bun-module", { adapter: "bun", module: importingModule("poll"), engine: "jsc" });
  } finally { void state.dispose(); }
});

const aliases = ["bun", "/bun", "node", "/node", "/usr/local/bin/bun", "/usr/local/bin/node"];
test("executable aliases resolve to the run's engine program and other names pass through", () => {
  const state = rootFixture({ engine: "jsc" });
  const named = new SubprocessBroker("http://localhost/worker.js", state.runtime, { engine: "quickjs", aliasExecutable: "preview1-root-9" });
  const plain = new SubprocessBroker("http://localhost/worker.js", state.runtime);
  try {
    for (const alias of aliases) {
      expect(state.broker.qualifyExecutable(alias)).toBe("bun-jsc");
      expect(named.qualifyExecutable(alias)).toBe("preview1-root-9");
      expect(plain.qualifyExecutable(alias)).toBe(alias);
    }
    for (const other of ["bunx", "/tools/custom", "bun-quickjs", "fixture.wasm"]) expect(state.broker.qualifyExecutable(other)).toBe(other);
  } finally { named.dispose(); plain.dispose(); void state.dispose(); }
});

test("only a spawn message has its executable rewritten before admission", async () => {
  const previousWorker = globalThis.Worker;
  const requests: RunRequest[] = [];
  globalThis.Worker = class { postMessage(value: RunRequest) { requests.push(value); } terminate() {} } as unknown as typeof Worker;
  const state = rootFixture({ engine: "browser" });
  state.broker.register("bun-browser", { adapter: "bun", module: importingModule("poll"), engine: "browser" });
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(state.client.pid, { executable: "/usr/local/bin/node", argv: ["node"], env: {}, cwd: "/", job: -1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, state.client.pid);
    const supervisor = await state.broker.ready();
    expect(supervisor.get(pid)!.request!.executable).toBe("bun-browser");
    for (let turn = 0; turn < 100 && !requests.length; turn++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ engine: "browser", adapter: "bun", net: null, args: ["node"], env: { PWD: "/" } });
    expect(workerProcessState(requests[0]!.runtimeProcess!).pid).toBe(pid);
  } finally { await state.dispose(); globalThis.Worker = previousWorker; }
});

test("disposing a run twice is harmless and closes it to a new root", async () => {
  const state = rootFixture({ engine: "browser" });
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    state.broker.dispose();
    state.broker.dispose();
    expect(state.broker.adoptRuntimeRoot(state.root)).rejects.toThrow("disposed");
  } finally { await state.dispose(); }
});

for (const delivery of ["kill", "killJob"] as const) test(`${delivery} selects the default outcome synchronously once the service is active`, async () => {
  const state = rootFixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const shared = workerProcessState(state.root);
    const sent = delivery === "kill" ? state.broker.kill(shared.pid, 15) : state.broker.killJob(shared.job, 15);
    // The outcome is published before the promise can be observed, so revocation callbacks never race it.
    expect(readOutcome(shared.signals.outcome)).toEqual({ kind: "signaled", code: 15, status: 143 });
    await sent;
  } finally { await state.dispose(); }
});

for (const delivery of ["kill", "killJob"] as const) test(`${delivery} only queues a handled signal and leaves the process alive`, async () => {
  const state = rootFixture();
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const shared = workerProcessState(state.root);
    setSignalDisposition(shared.signals.signalState, 2, 2);
    const before = Atomics.load(shared.wake, 0);
    await (delivery === "kill" ? state.broker.kill(shared.pid, 2) : state.broker.killJob(shared.job, 2));
    expect(takeSignal(shared.signals.signalState)).toBe(2);
    expect(readOutcome(shared.signals.outcome)).toBeNull();
    expect(Atomics.load(shared.wake, 0)).toBeGreaterThan(before);
  } finally { await state.dispose(); }
});

test("kill rejects signals outside the frozen set before touching a process", async () => {
  const state = rootFixture();
  try {
    expect(() => state.broker.kill(1, 64)).toThrow();
    expect(() => state.broker.killJob(1, 0)).toThrow();
  } finally { await state.dispose(); }
});

test("rootExit before a root is adopted is a no-op, and after adoption confirms the root", async () => {
  const state = rootFixture();
  try {
    expect(state.broker.rootExit(0)).toBeUndefined();
    await state.broker.adoptRuntimeRoot(state.root);
    await state.broker.rootExit(7);
    const shared = workerProcessState(state.root);
    expect(readOutcome(shared.signals.outcome)).toEqual({ kind: "exited", code: 7, status: 7 });
    expect(Atomics.load(shared.confirmed, 0)).toBe(1);
  } finally { await state.dispose(); }
});

test("each runtime gets one set of engine and preview1 adapters however many runs share it", async () => {
  const state = rootFixture();
  const second = new SubprocessBroker("http://localhost/other.js", state.runtime);
  try {
    // A second composition on the same runtime reuses the registered adapters: re-registering throws.
    expect(() => state.runtime.registerAdapter("bun:quickjs", async () => { throw new Error("unused"); })).toThrow("already registered");
    for (const adapter of ["bun:quickjs", "bun:jsc", "bun:browser", "preview1"]) {
      expect(() => state.runtime.registerProgram(`probe-${adapter}`, { adapter, module: importingModule("poll"), cooperative: true })).not.toThrow();
    }
  } finally { second.dispose(); await state.dispose(); }
});
