import { controlLoad } from "waffle/proc/control";
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
    expect(() => state.broker.register("/bin/tool", { module: importingModule("poll"), adapter: "preview1" } as never)).toThrow("explicit cooperative assertion");
    state.broker.register("/bin/bytes", { adapter: "preview1", bytes: wasm });
    state.broker.register("/bin/cooperative", { adapter: "preview1", module: importingModule("poll"), cooperative: true });
    state.broker.register("/bin/bun-module", { adapter: "bun", module: importingModule("poll"), engine: "jsc" });
  } finally { void state.dispose(); }
});

test("spawn requests keep their explicit executable without root-specific rewriting", async () => {
  const previousWorker = globalThis.Worker;
  const requests: RunRequest[] = [];
  globalThis.Worker = class { postMessage(value: RunRequest) { requests.push(value); } terminate() {} } as unknown as typeof Worker;
  const state = rootFixture();
  state.broker.register("/bin/bun", { adapter: "bun", module: importingModule("poll"), engine: "browser" });
  state.broker.register("/opt/bun/jsc/bin/bun", { adapter: "bun", module: importingModule("poll"), engine: "jsc" });
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    for (const executable of ["/bin/bun", "/opt/bun/jsc/bin/bun"]) {
      const pid = state.client.spawn(state.client.pid, { executable, argv: ["bun"], env: { PATH: "/opt/bun/quickjs/bin:/bin" }, cwd: "/", job: -1, fds: [] });
      await state.broker.runtimeMessage(state.messages.at(-1)!, state.client.pid);
      const supervisor = await state.broker.ready();
      expect(supervisor.get(pid)!.request!.executable).toBe(executable);
      for (let turn = 0; turn < 100 && requests.length < (executable === "/bin/bun" ? 1 : 2); turn++) await new Promise(resolve => setTimeout(resolve, 0));
      const request = requests.at(-1)!;
      expect(request).toMatchObject({ engine: executable === "/bin/bun" ? "browser" : "jsc", adapter: "bun", net: null,
        args: ["bun"], env: { PWD: "/", PATH: "/opt/bun/quickjs/bin:/bin", BUNWASM_EXEC_PATH: executable } });
      expect(workerProcessState(request.runtimeProcess!).pid).toBe(pid);
    }
  } finally { await state.dispose(); globalThis.Worker = previousWorker; }
});

test("disposing a run twice is harmless and closes it to a new root", async () => {
  const state = rootFixture();
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
    const before = controlLoad(shared.wake, 0);
    await (delivery === "kill" ? state.broker.kill(shared.pid, 2) : state.broker.killJob(shared.job, 2));
    expect(takeSignal(shared.signals.signalState)).toBe(2);
    expect(readOutcome(shared.signals.outcome)).toBeNull();
    expect(controlLoad(shared.wake, 0)).toBeGreaterThan(before);
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
    const shared = workerProcessState(state.root);
    const root = (await state.broker.ready()).get(shared.pid)!;
    await state.broker.rootExit(7);
    expect(root.result).toEqual({ kind: "exited", code: 7, status: 7 });
    expect(root.jobSafe).toBe(true);
    expect(() => controlLoad(shared.confirmed, 0)).toThrow("collected");
  } finally { await state.dispose(); }
});

test("each runtime gets one set of engine and preview1 adapters however many runs share it", async () => {
  const state = rootFixture();
  const second = new SubprocessBroker("http://localhost/other.js", state.runtime);
  try {
    // A second composition on the same runtime reuses the registered adapters: re-registering throws.
    expect(() => state.runtime.registerAdapter("bun:quickjs", async () => { throw new Error("unused"); })).toThrow("already registered");
    for (const adapter of ["bun:quickjs", "bun:jsc", "bun:browser", "preview1"]) {
      expect(() => state.runtime.registerProgram(`/bin/probe-${adapter}`, { adapter, module: importingModule("poll"), cooperative: true })).not.toThrow();
    }
  } finally { second.dispose(); await state.dispose(); }
});
