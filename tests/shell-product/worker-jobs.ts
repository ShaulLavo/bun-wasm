import type { ProcessAdmissionEvent } from "waffle";
import type { ProcessRecord } from "waffle/proc";
import { workerProcessDirectoryId, workerProcessState } from "waffle/proc/worker-client";

type ProcessWorker = Pick<ReturnType<typeof workerProcessState>, "pid" | "parentPid" | "rootPid" | "job" | "jobOwner" | "jobLeaderPid"> & { directory: string; adapter: unknown };
type Scope<W> = { baseline: ReadonlySet<W>; root: ProcessWorker; after: number };
type Admission = Pick<ProcessAdmissionEvent, "pid" | "parentPid" | "job"> & { stage: ProcessAdmissionEvent["stage"]; sequence: number; request?: { job: number; rootPid: number | undefined } };

function processWorker(message: unknown): ProcessWorker | undefined {
  if (!message || typeof message !== "object" || !("runtimeProcess" in message) || message.runtimeProcess === undefined) return;
  const value = message.runtimeProcess;
  if (!value || typeof value !== "object" ||
    !("directory" in value) || !(value.directory instanceof SharedArrayBuffer) ||
    !("identity" in value) || !(value.identity instanceof SharedArrayBuffer) ||
    !("slot" in value) || typeof value.slot !== "number" ||
    !("pid" in value) || typeof value.pid !== "number") throw new Error("Invalid worker process transport");
  const transport = { directory: value.directory, identity: value.identity, slot: value.slot, pid: value.pid, bindings: [], resources: [] };
  const { pid, parentPid, rootPid, job, jobOwner, jobLeaderPid } = workerProcessState(transport);
  return { directory: workerProcessDirectoryId(transport), pid, parentPid, rootPid, job, jobOwner, jobLeaderPid, adapter: "adapter" in message ? message.adapter : undefined };
}

/** Cache request intent and startup scalars before shared rows can be collected. */
export class WorkerJobs<W extends object> {
  private readonly identities = new Map<W, ProcessWorker | Error>();
  private readonly admissions = new Map<number, Admission>();
  private sequence = 0;
  constructor(private readonly live: ReadonlySet<W>, private readonly isIdleWorker: (worker: W) => boolean) {}

  admission(event: ProcessAdmissionEvent, record?: Pick<ProcessRecord, "request" | "rootPid">) {
    let entry = this.admissions.get(event.pid);
    if (!entry) {
      entry = { pid: event.pid, parentPid: event.parentPid, job: event.job, stage: event.stage, sequence: ++this.sequence };
      this.admissions.set(event.pid, entry);
    }
    entry.stage = event.stage;
    if (!entry.request && record?.request) entry.request = { job: record.request.job, rootPid: record.rootPid };
  }

  observe(worker: W, message: unknown) {
    if (this.identities.has(worker)) return;
    try {
      const identity = processWorker(message);
      if (identity) this.identities.set(worker, identity);
    } catch (error) {
      this.identities.set(worker, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private idle(worker: W): boolean {
    if (!this.isIdleWorker(worker)) return false;
    if (this.identities.has(worker)) throw new Error("Idle worker already received a process request");
    return true;
  }

  private identity(worker: W) {
    const identity = this.identities.get(worker);
    if (identity instanceof Error) throw identity;
    if (!identity) throw new Error("Live worker has no captured process ownership");
    return identity;
  }

  private process(pid: number) {
    return Array.from(this.identities.values()).find(value => !(value instanceof Error) && value.pid === pid);
  }

  baseline(rootPid: number): Scope<W> {
    const root = this.process(rootPid);
    if (!root || root instanceof Error || root.rootPid !== rootPid || root.parentPid !== 0) throw new Error("Interactive root worker ownership missing");
    return { baseline: new Set(Array.from(this.live).filter(worker => !this.idle(worker))), root, after: this.sequence };
  }

  command(scope: Scope<W>): Scope<W> { return { ...scope, after: this.sequence }; }

  private member(worker: W, scope: Scope<W>) {
    const identity = this.identity(worker);
    if (identity.directory !== scope.root.directory || identity.rootPid !== scope.root.pid) throw new Error("Worker belongs to an unexpected runtime root");
    const entry = this.admissions.get(identity.pid);
    if (!entry || entry.parentPid !== identity.parentPid || entry.job !== identity.job) throw new Error("Worker has no matching admitted request");
    return entry;
  }

  private cohort(entry: Admission, scope: Scope<W>, seen = new Set<number>()): "foreground" | "independent" {
    if (seen.has(entry.pid)) throw new Error("Cyclic job ownership");
    seen.add(entry.pid);
    const request = entry.request;
    if (!request || request.rootPid !== scope.root.pid) throw new Error(`Unknown request ownership for PID ${entry.pid}`);
    if (request.job > 0) {
      if (request.job !== entry.job) throw new Error(`Requested job ${request.job} assigned ${entry.job} for PID ${entry.pid}`);
      const origin = Array.from(this.admissions.values()).find(value => value.job === request.job && value.request && value.request.job <= 0);
      if (!origin) throw new Error("Requested job has no observed origin");
      return this.cohort(origin, scope, seen);
    }
    const caller = this.process(entry.parentPid);
    if (!caller || caller instanceof Error || caller.directory !== scope.root.directory || caller.rootPid !== scope.root.pid) throw new Error("Unknown spawning caller");
    if (entry.job === caller.job || entry.job <= 0) throw new Error("New job request did not receive a fresh job");
    if (Array.from(this.admissions.values()).some(value => value.sequence < entry.sequence && value.job === entry.job && value.request && value.request.job <= 0)) throw new Error("New job reused an observed job identity");
    if (entry.parentPid === scope.root.pid && request.job === 0) return "foreground";
    if (entry.parentPid === scope.root.pid && request.job === -1) return "independent";
    if (caller.adapter !== "bun" || request.job !== 0) throw new Error("Independent job has no explicit Bun detach request");
    const parent = this.admissions.get(caller.pid);
    if (!parent) throw new Error("Independent job caller has no admitted ownership");
    this.cohort(parent, scope, seen);
    return "independent";
  }

  foreground(scope: Scope<W>) {
    const jobs = new Set<number>();
    for (const worker of this.live) {
      if (scope.baseline.has(worker) || this.idle(worker)) continue;
      const entry = this.member(worker, scope);
      if (entry.sequence > scope.after && this.cohort(entry, scope) === "foreground") jobs.add(entry.job);
    }
    if (!jobs.size) throw new Error("Live server has no captured foreground job workers");
    return jobs;
  }

  stopped(scope: Scope<W>, foreground: ReadonlySet<number>) {
    for (const worker of scope.baseline) {
      if (!this.live.has(worker)) throw new Error("Baseline worker physically stopped before prompt");
    }
    for (const entry of this.admissions.values()) {
      const caller = this.process(entry.parentPid);
      if (entry.request?.rootPid !== scope.root.pid && (!caller || caller instanceof Error || caller.directory !== scope.root.directory || caller.rootPid !== scope.root.pid)) continue;
      const cohort = this.cohort(entry, scope);
      if (cohort === "foreground" && !["launched", "rejected", "skipped"].includes(entry.stage)) throw new Error(`Unresolved foreground launch PID ${entry.pid}`);
    }
    for (const worker of this.live) {
      if (scope.baseline.has(worker) || this.idle(worker)) continue;
      const entry = this.member(worker, scope);
      const identity = this.identity(worker);
      if (this.cohort(entry, scope) === "foreground" || foreground.has(entry.job)) throw new Error(`Foreground worker PID ${entry.pid} job ${entry.job} not physically stopped before prompt`);
      if (identity.jobOwner !== entry.parentPid && identity.jobLeaderPid === entry.pid) throw new Error("Independent job has the wrong owner");
      const leader = this.process(identity.jobLeaderPid);
      if (!leader || leader instanceof Error || leader.directory !== identity.directory || leader.rootPid !== identity.rootPid || leader.job !== identity.job || leader.parentPid !== identity.jobOwner) throw new Error("Independent job has no matching startup leader");
    }
  }
}
