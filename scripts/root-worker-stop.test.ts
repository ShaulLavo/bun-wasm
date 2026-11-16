import { expect, spyOn, test } from "bun:test";
import { prepareLinkPlan } from "waffle/link";
import { engineLinkPlan } from "../src/quickjs-program.ts";
import { initializationPair } from "../tests/package/engine-initialization-fixture.ts";
import { physicalStop } from "../web/src/runner.ts";
import { rootFixture } from "../web/tests/process-root-fixture.ts";

for (const mode of ["void", "fulfilled", "rejected", "throw"] as const) test(`root stop signals an attempted native termination before its join: ${mode}`, async () => {
  const events: string[] = [];
  const joined = Promise.withResolvers<void>();
  const failure = new Error("native stop failed");
  const worker = { terminate() {
    expect(this).toBe(worker);
    events.push("native");
    if (mode === "throw") throw failure;
    if (mode === "void") return;
    return joined.promise;
  } };
  const result = physicalStop(worker, () => events.push("terminating"), () => events.push("returned"), () => events.push("stopped"));
  // Attach the rejection consumer before releasing the native join.
  const outcome = result.then(() => undefined, error => error);
  if (mode === "void") {
    expect(events).toEqual(["native", "terminating", "returned", "stopped"]);
    expect(await outcome).toBeUndefined();
    return;
  }
  expect(events).toEqual(["native", "terminating"]);
  if (mode === "rejected") joined.reject(failure);
  else joined.resolve();
  expect(await outcome).toBe(mode === "fulfilled" ? undefined : failure);
  expect(events).toEqual(mode === "fulfilled" ? ["native", "terminating", "returned", "stopped"] : ["native", "terminating"]);
});

test("an unattempted native stop does not signal termination", () => {
  const events: string[] = [];
  const failure = new Error("native stop lookup failed");
  const worker = { get terminate(): () => void { throw failure; } };
  expect(() => physicalStop(worker, () => events.push("terminating"), () => events.push("returned"), () => events.push("stopped"))).toThrow(failure);
  expect(events).toEqual([]);
});

test("root stop receipts retain the exact admitted group across same-PID replacement", async () => {
  const state = rootFixture();
  const events: string[] = [];
  try {
    await state.broker.adoptRuntimeRoot(state.root, "group");
    const service = await state.runtime.processes();
    const admit = service.admitRootMemoryGroup.bind(service);
    let incarnation = 0;
    // This is the documented new API's mock boundary, not qualification of the installed SDK.
    const admission = spyOn(service, "admitRootMemoryGroup").mockImplementation((pid, program) => {
      const admitted = admit(pid, program);
      const identity = ++incarnation;
      return { ...admitted, terminating: () => { events.push(`terminating ${identity}`); }, stopped: () => {
        events.push(`stopped ${identity}`);
        admitted.stopped();
      } };
    });
    try {
      const { plan } = await engineLinkPlan(initializationPair("quickjs", true), prepareLinkPlan);
      if (!plan.shared) throw new Error("Expected a shared fixture plan");
      const program = { module: plan.entryModule, linkPlan: plan.shared };
      const unadmitted = state.broker.captureRootStop();
      state.broker.admitRootGroup(program);
      const first = state.broker.captureRootStop();
      unadmitted.terminating();
      expect(events).toEqual([]);
      await physicalStop({ terminate() { events.push("helper native"); } }, () => {}, () => events.push("helper returned"), () => {});
      expect(events).toEqual(["helper native", "helper returned"]);
      events.length = 0;
      first.terminating();
      first.stopped();
      state.broker.admitRootGroup(program);
      // A retained old handle must not select the newer membership using its PID.
      first.terminating();
      first.stopped();
      const second = state.broker.captureRootStop();
      second.terminating();
      second.stopped();
      expect(events).toEqual(["terminating 1", "stopped 1", "terminating 1", "stopped 1", "terminating 2", "stopped 2"]);
      expect(admission.mock.calls.map(([pid]) => pid)).toEqual([state.root.pid, state.root.pid]);
    } finally { admission.mockRestore(); }
  } finally { await state.dispose(); }
});
