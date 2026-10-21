import { expect, test } from "bun:test";
import type { RuntimeNetworkHelper } from "waffle";
import { createFilesystemIdentity, revokeFilesystem } from "waffle/fs";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { setSignalDisposition, takeSignal } from "waffle/proc/signals";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { startRun, type Run } from "../src/runner";
import type { RunRequest } from "../src/bun-executor";
import { processRuntimeFixture } from "./process-runtime-fixture";

async function until(check: () => boolean) {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error("root signal preparation did not reach its expected boundary");
}

function observedHelper(helper: RuntimeNetworkHelper, release: () => void): RuntimeNetworkHelper {
  return { ...helper, dispose() { release(); helper.dispose(); } };
}

function fixture(explicit = true, deferNetwork = false) {
  const previous = {
    Worker: globalThis.Worker,
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    isolation: Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated"),
  };
  const admission = Promise.withResolvers<void>();
  const admitting = Promise.withResolvers<void>();
  const activation = Promise.withResolvers<void>();
  const activating = Promise.withResolvers<void>();
  const fence = Promise.withResolvers<void>();
  const channel = new MessageChannel();
  const identity = createFilesystemIdentity();
  const posts: RunRequest[] = [];
  const events: string[] = [];
  let allocations = 0, releases = 0, stops = 0;
  let onAllocate = () => {};
  const releaseHelper = () => { releases++; events.push("network-release"); };
  class RootWorker {
    postMessage(request: RunRequest) { posts.push(request); }
    terminate() { stops++; events.push("physical-stop"); }
  }
  globalThis.Worker = RootWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = processRuntimeFixture({
    connect: value => ({ ...value, port: channel.port1 }),
    fork: () => ({ ...identity, port: channel.port1 }),
    revoke: revokeFilesystem,
    reap() {},
    async quiesce(value) { events.push("fence"); revokeFilesystem(value); await fence.promise; },
  }, { async activate() { admitting.resolve(); await admission.promise; return import("waffle/proc"); } });
  const transport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  transport.data = { filesystem: identity };
  const signals = workerProcessState(transport).signals;
  const network = runtime.network.bind(runtime);
  runtime.network = async () => {
    activating.resolve();
    if (deferNetwork) await activation.promise;
    const capability = await network();
    return { createHelper(options) {
      allocations++;
      const helper = capability.createHelper(options);
      onAllocate();
      return observedHelper(helper, releaseHelper);
    } };
  };
  const ready = runtime.processes().then(service => service.ready());
  void ready.catch(() => {});
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  return {
    runtime, signals, admission, admitting, activation, activating, fence, posts, events,
    allocations: () => allocations, releases: () => releases, stops: () => stops,
    onAllocate(callback: () => void) { onAllocate = callback; },
    start() {
      return startRun({ runtime, runtimeProcess: explicit ? transport : undefined, engine: "browser", module,
        args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} });
    },
    async cleanup(run: Run) {
      admission.resolve(); activation.resolve(); fence.resolve();
      try { run.kill(9); await run.done; await runtime.dispose(); await ready; }
      finally {
        channel.port1.close(); channel.port2.close(); globalThis.Worker = previous.Worker;
        if (previous.location) Object.defineProperty(globalThis, "location", previous.location); else Reflect.deleteProperty(globalThis, "location");
        if (previous.isolation) Object.defineProperty(globalThis, "crossOriginIsolated", previous.isolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
      }
    },
  };
}

for (const disposition of [1, 2]) test(`early explicit INT disposition ${disposition} continues startup and keeps its helper until physical stop`, async () => {
  const state = fixture();
  setSignalDisposition(state.signals.signalState, 2, disposition);
  const run = state.start();
  try {
    run.kill(2);
    await state.admitting.promise;
    state.admission.resolve();
    await until(() => state.posts.length === 1);
    expect(readOutcome(state.signals.outcome)).toBeNull();
    expect(takeSignal(state.signals.signalState)).toBe(disposition === 2 ? 2 : 0);
    expect(state.allocations()).toBe(1);
    run.kill(9);
    await until(() => state.events.includes("fence"));
    expect(state.releases()).toBe(0);
    expect(state.stops()).toBe(0);
    state.fence.resolve();
    expect(await run.done).toEqual({ code: 137 });
    expect(state.releases()).toBe(1);
    expect(state.stops()).toBe(1);
    expect(state.events.indexOf("physical-stop")).toBeLessThan(state.events.indexOf("network-release"));
  } finally { await state.cleanup(run); }
});

type Signal = Parameters<Run["kill"]>[0];
const sequences: { name: string; signals: Signal[]; firstDefault: number; handled: number }[] = [
  { name: "9 then 2", signals: [9, 2], firstDefault: 137, handled: 137 },
  { name: "2 then 9", signals: [2, 9], firstDefault: 130, handled: 137 },
  { name: "2 then 15 then 9", signals: [2, 15, 9], firstDefault: 130, handled: 143 },
  { name: "15 then 9 then 2", signals: [15, 9, 2], firstDefault: 143, handled: 143 },
  { name: "implicit then implicit", signals: [undefined, undefined], firstDefault: 130, handled: 137 },
  { name: "explicit 2 then implicit", signals: [2, undefined], firstDefault: 130, handled: 137 },
  { name: "implicit then explicit 2 then implicit", signals: [undefined, 2, undefined], firstDefault: 130, handled: 137 },
];
for (const disposition of [0, 1, 2]) {
  for (const sequence of sequences) test(`early ordered ${sequence.name}, INT disposition ${disposition}`, async () => {
    const state = fixture();
    setSignalDisposition(state.signals.signalState, 2, disposition);
    const run = state.start();
    try {
      for (const signal of sequence.signals) run.kill(signal);
      await state.admitting.promise;
      state.admission.resolve();
      await until(() => state.events.includes("fence"));
      expect(state.posts).toEqual([]);
      expect(state.allocations()).toBe(0);
      expect(state.stops()).toBe(0);
      state.fence.resolve();
      expect(await run.done).toEqual({ code: disposition === 0 ? sequence.firstDefault : sequence.handled });
      run.kill(9);
      expect(state.stops()).toBe(1);
      expect(state.releases()).toBe(0);
    } finally { await state.cleanup(run); }
  });
}

for (const boundary of ["admission", "network", "helper"] as const) test(`external terminal outcome during ${boundary} prevents a late root post`, async () => {
  const state = fixture(true, true);
  const run = state.start();
  try {
    if (boundary === "admission") {
      await state.admitting.promise;
      claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 });
    }
    if (boundary === "helper") state.onAllocate(() => { claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 }); });
    state.admission.resolve();
    if (boundary !== "admission") await state.activating.promise;
    if (boundary === "network") claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 });
    state.activation.resolve();
    await until(() => state.events.includes("fence"));
    expect(state.posts).toEqual([]);
    expect(state.allocations()).toBe(boundary === "helper" ? 1 : 0);
    expect(state.stops()).toBe(0);
    expect(state.releases()).toBe(0);
    state.fence.resolve();
    expect(await run.done).toEqual({ code: 137 });
    expect(state.stops()).toBe(1);
    expect(state.releases()).toBe(boundary === "helper" ? 1 : 0);
  } finally { await state.cleanup(run); }
});

for (const explicit of [false, true]) test(`kill during a network await stops ${explicit ? "explicit" : "implicit"} preparation without allocation`, async () => {
  const state = fixture(explicit, true);
  const run = state.start();
  try {
    state.admission.resolve();
    await state.activating.promise;
    run.kill(9); run.kill(2);
    state.activation.resolve();
    await until(() => state.events.includes("fence"));
    expect(state.posts).toEqual([]);
    expect(state.allocations()).toBe(0);
    expect(state.stops()).toBe(0);
    state.fence.resolve();
    expect(await run.done).toEqual({ code: 137 });
    expect(state.stops()).toBe(1);
  } finally { await state.cleanup(run); }
});
