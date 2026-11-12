import { bytes, pages, SharedMemoryAdmissionError, type ProcessService, type SharedMemorySnapshot } from "waffle";
import { launchFailureFact } from "../../web/src/launch-failure.ts";

export function launchFailureFixture(count = 1) {
  const cause = new RangeError("original native refusal");
  const error = new SharedMemoryAdmissionError({ kind: "platform", label: "memory-group", cause });
  Object.defineProperty(error, "cause", { value: new Error("different outer cause") });
  const groups: ReturnType<ProcessService["memoryGroups"]> = Array.from({ length: count }, (_, index) => ({
    id: `group-${index}`, members: 1, reserved: 1, retained: 0, pids: Array.from({ length: count }, (_, pid) => pid),
    regions: 0, pins: 0, published: 0, holds: 0, watches: 0, committedBytes: 65536, memberPages: 1, bypassed: false, freeBytes: 0,
  }));
  const workers: ReturnType<ProcessService["workerMemory"]> = Array.from({ length: count }, (_, index) => ({
    pid: index, parentPid: 11, rootPid: 10, job: 9, directory: `directory-${index}`, bytes: null,
  }));
  const ledger: SharedMemorySnapshot = { platform: { kind: "unbounded", source: "default" }, budgetBytes: null, reservedBytes: 65536,
    availableBytes: null, awaitingReleaseBytes: 0, debtBytes: 0, effectiveBudgetBytes: null, contradictions: [], sharedGuests: [],
    holders: Array.from({ length: count }, () => ({ label: "memory-group", scope: "worker", state: "live",
      shape: { kind: "growable", maximumPages: pages(32768) }, declaredBytes: bytes(65536), grownBytes: 65536 })),
  };
  const context = { pid: count - 1, parentPid: 11, job: 9,
    request: { executable: "/bin/bun", argv: ["bun", "run", "fixture.ts"], env: {}, cwd: "/fixture", job: 9, fds: [] } };
  const service = { memoryGroups: () => groups, workerMemory: () => workers };
  const runtime = { sharedMemory: { snapshot: () => ledger, check(): never { throw Error("not used"); } } };
  return { cause, error, groups, workers, ledger, context, service, runtime,
    capture: () => launchFailureFact(error, context, service, runtime, "new", 1) };
}
