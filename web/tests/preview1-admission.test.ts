import { expect, test } from "bun:test";
import { workerProcessState } from "waffle/proc/worker-client";
import type { RunRequest } from "../src/bun-executor";
import { SubprocessBroker } from "../src/subprocess-broker";
import { rootFixture } from "./process-root-fixture";

// A third-party preview1 program is admitted from source bytes and launched interruptible,
// whichever composition root registered it: this broker, another broker, or the runtime itself.
for (const admission of ["this-broker", "other-broker", "runtime"] as const) test(`Preview1 launch uses canonical source admission from ${admission}`, async () => {
  const previousWorker = globalThis.Worker;
  const requests: RunRequest[] = [];
  globalThis.Worker = class {
    postMessage(value: RunRequest) { requests.push(value); }
    terminate() {}
  } as unknown as typeof Worker;
  const state = rootFixture();
  const registering = admission === "other-broker" ? new SubprocessBroker("https://example.test/worker.js", state.runtime) : state.broker;
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  if (admission === "runtime") state.runtime.registerProgram("tool", { adapter: "preview1", source: bytes });
  else registering.register("tool", { adapter: "preview1", bytes });
  try {
    await state.broker.adoptRuntimeRoot(state.root);
    const pid = state.client.spawn(state.client.pid, { executable: "tool", argv: ["tool"], env: {}, cwd: "/", job: -1, fds: [] });
    await state.broker.runtimeMessage(state.messages[0]!, state.client.pid);
    for (let turn = 0; turn < 100 && !requests.length; turn++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(workerProcessState(requests[0]!.runtimeProcess!).pid).toBe(pid);
    expect(requests[0]!.interruptible).toBe(true);
  } finally {
    if (registering !== state.broker) registering.dispose();
    await state.dispose();
    globalThis.Worker = previousWorker;
  }
});
