import type { GuestLauncher, Runtime, RuntimeSupervisor } from "waffle";
import type { ProcessContext, ProcessExit } from "waffle/proc/types";
import { ProcessError } from "../node_modules/waffle/proc/types.ts";
import { startFailureErrno } from "../node_modules/waffle/proc/start-errno.js";
import { normalize } from "waffle/core/path";
import { ContinuationIO } from "./package-continuation-io.js";
import { FilesystemClient } from "../node_modules/waffle/fs/client.ts";
import type { FilesystemIdentity, FilesystemReservation } from "waffle/fs/protocol";
import { announcement, scriptDiagnostic, startupDiagnostic } from "./package-continuation-diagnostics.js";
import { PackageChildren } from "./package-continuation-children.js";
import { parsePackagePlan, type PackagePhase, type PackagePlan } from "./package-continuation-plan.js";

type Service = Parameters<GuestLauncher>[1];
type ChildResult = { readonly exit: ProcessExit; readonly diagnostic: string; readonly status: number };
class Revoked extends Error {}

class LocalWork {
  readonly abort = new AbortController();
  check(): void { if (this.abort.signal.aborted) throw new Revoked(); }
  revoke = (): void => { this.abort.abort(); };

  async wait<T>(pending: Promise<T>): Promise<T> {
    this.check();
    const cancelled = Promise.withResolvers<never>();
    const cancel = () => cancelled.reject(new Revoked());
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    try { return await Promise.race([pending, cancelled.promise]); }
    finally { this.abort.signal.removeEventListener("abort", cancel); }
  }
}

function shared(value: unknown): value is SharedArrayBuffer { return value instanceof SharedArrayBuffer && value.byteLength >= 4; }
function reservation(value: unknown): value is FilesystemReservation {
  return !!value && typeof value === "object" && "handle" in value && typeof value.handle === "number"
    && "source" in value && shared(value.source) && "sourceKey" in value && typeof value.sourceKey === "number"
    && "target" in value && shared(value.target) && "targetKey" in value && typeof value.targetKey === "number"
    && "targetOwner" in value && typeof value.targetOwner === "number" && "state" in value && shared(value.state);
}

function filesystemIdentity(value: unknown): value is FilesystemIdentity {
  if (!value || typeof value !== "object") return false;
  return "owner" in value && typeof value.owner === "number" && Number.isSafeInteger(value.owner) && value.owner > 0
    && "epoch" in value && shared(value.epoch) && "signal" in value && shared(value.signal)
    && "shared" in value && shared(value.shared) && "capabilities" in value && shared(value.capabilities)
    && "sections" in value && shared(value.sections) && "requestBudget" in value && shared(value.requestBudget)
    && "ownerStates" in value && shared(value.ownerStates) && value.ownerStates.byteLength >= (value.owner + 1) * 4
    && "revocations" in value && Array.isArray(value.revocations) && value.revocations.length > 0 && value.revocations.every(shared)
    && "segments" in value && Array.isArray(value.segments) && value.segments.every(shared)
    && "reservations" in value && Array.isArray(value.reservations) && value.reservations.every(reservation)
    && "maxBytes" in value && typeof value.maxBytes === "number" && Number.isFinite(value.maxBytes)
    && !("publication" in value) && !("residentPublication" in value);
}

export function admittedIdentity(context: ProcessContext, service: Service): FilesystemIdentity {
  const transport = service.transportFor(context.pid);
  if (!transport || transport.pid !== context.pid || transport.generation !== context.generation) throw new Error("Package continuation transport identity mismatch");
  const data = transport.data;
  if (!data || typeof data !== "object" || !("filesystem" in data) || !filesystemIdentity(data.filesystem)) throw new Error("Package continuation requires its admitted filesystem identity");
  return data.filesystem;
}

async function access(supervisor: RuntimeSupervisor, context: ProcessContext, owner: LocalWork, path: string, cwd: string): Promise<number> {
  owner.check();
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const id = supervisor.accessStart(context.pid, path, cwd, wake);
  if (id < 0) return id;
  const cancel = () => { Atomics.add(wake, 0, 1); Atomics.notify(wake, 0); };
  owner.abort.signal.addEventListener("abort", cancel, { once: true });
  try {
    await accessReady(supervisor, context.pid, id, owner, wake);
    owner.check();
    return supervisor.accessTake(context.pid, id);
  } finally {
    owner.abort.signal.removeEventListener("abort", cancel);
    cancelAccess(supervisor, context.pid, id);
  }
}

async function accessReady(supervisor: RuntimeSupervisor, pid: number, id: number, owner: LocalWork, wake: Int32Array): Promise<void> {
  while (!supervisor.accessReady(pid, id)) {
    const observed = Atomics.load(wake, 0);
    owner.check();
    if (!supervisor.accessReady(pid, id)) await owner.wait(Promise.resolve(Atomics.waitAsync(wake, 0, observed).value));
  }
}

function cancelAccess(supervisor: RuntimeSupervisor, pid: number, id: number): void {
  try { supervisor.accessCancel(pid, id); }
  catch (error) { if (!(error instanceof ProcessError) || error.errno !== 8 && error.errno !== 71) throw error; }
}

async function which(supervisor: RuntimeSupervisor, context: ProcessContext, owner: LocalWork, plan: PackagePlan, name: string): Promise<string | null> {
  for (const directory of (plan.env.PATH ?? "").split(":")) {
    const base = directory.startsWith("/") ? directory : directory ? `${plan.cwd}/${directory}` : plan.cwd;
    const candidate = `${base}/${name}`;
    const result = await access(supervisor, context, owner, candidate, plan.cwd);
    if (result === 0) return normalize(candidate, plan.cwd);
    if (result !== -2 && result !== -44 && result !== -54) return null;
  }
  return null;
}

async function findShell(supervisor: RuntimeSupervisor, context: ProcessContext, owner: LocalWork, plan: PackagePlan): Promise<string> {
  return await which(supervisor, context, owner, plan, "bash") ?? await which(supervisor, context, owner, plan, "sh") ?? "/bin/sh";
}

async function cwdError(context: ProcessContext, owner: LocalWork, children: PackageChildren, cwd: string): Promise<number> {
  const root = context.descriptors.rootPreopen();
  if (!root || root.resource.kind !== "directory") return 8;
  if (!(root.rightsBase & (1n << 18n))) return 76;
  try {
    const resolved: unknown = await owner.wait(children.filesystem.asyncCall("resolve", [root.resource.handle, cwd.slice(1) || ".", true]));
    owner.check();
    if (typeof resolved === "number") return resolved;
    if (!resolved || typeof resolved !== "object" || !("node" in resolved) || resolved.node === undefined) return 44;
    if (typeof resolved.node !== "number") throw new TypeError("Invalid cwd resolve result");
    const stat: unknown = await owner.wait(children.filesystem.asyncCall("stat", [resolved.node]));
    owner.check();
    if (!stat || typeof stat !== "object" || !("kind" in stat)) throw new TypeError("Invalid cwd stat result");
    return stat.kind === "directory" ? 0 : 54;
  } catch (error) {
    owner.check();
    if (error && typeof error === "object" && "errno" in error && typeof error.errno === "number") return error.errno;
    throw error;
  }
}

async function child(supervisor: RuntimeSupervisor, service: Service, context: ProcessContext, owner: LocalWork, children: PackageChildren, executable: string, phase: PackagePhase, plan: PackagePlan): Promise<ChildResult> {
  owner.check();
  const pid = children.reserve({ executable, argv: [executable, "-c", phase.command],
    env: { ...plan.env, npm_lifecycle_event: phase.name, npm_lifecycle_script: phase.original }, cwd: plan.cwd, job: context.job,
    fds: [0, 1, 2].map(fd => ({ parent: fd, child: fd })) });
  service.registerController(pid, { startFailed() {} });
  const completed = Promise.withResolvers<void>();
  const remove = supervisor.onChildExit(event => { if (event.pid === pid) completed.resolve(); });
  try {
    owner.check();
    await owner.wait(children.flush());
    await owner.wait(supervisor.start(pid));
    if (!supervisor.childExited(context.pid, pid)) await owner.wait(completed.promise);
    owner.check();
    const status = supervisor.startStatus(context.pid, pid);
    const diagnostic = supervisor.spawnDiagnostic(context.pid, pid) ?? "";
    const exit = children.wait(pid);
    await children.flush();
    if (!exit) throw new Error("Package child completion had no consuming result");
    return { exit, diagnostic, status };
  } finally { remove(); }
}

async function write(io: ContinuationIO, owner: LocalWork, text: string): Promise<void> {
  owner.check();
  if (text) await io.write(text);
  owner.check();
}

function admissionErrno(error: unknown): number | null {
  return error instanceof ProcessError ? error.errno : null;
}

async function phaseResult(supervisor: RuntimeSupervisor, service: Service, context: ProcessContext, owner: LocalWork, io: ContinuationIO, children: PackageChildren, plan: PackagePlan, phase: PackagePhase): Promise<ProcessExit> {
  await write(io, owner, announcement(plan, phase));
  const executable = await findShell(supervisor, context, owner, plan);
  const cwdErrno = await cwdError(context, owner, children, plan.cwd);
  if (cwdErrno) {
    await write(io, owner, startupDiagnostic(executable, cwdErrno, "", plan.footer));
    return { kind: "exited", code: 1, status: 1 };
  }
  let result: ChildResult;
  try { result = await child(supervisor, service, context, owner, children, executable, phase, plan); }
  catch (error) {
    const errno = admissionErrno(error);
    if (errno === null) throw error;
    await write(io, owner, startupDiagnostic(executable, errno, "", plan.footer));
    return { kind: "exited", code: 1, status: 1 };
  }
  owner.check();
  if (result.exit.kind === "start-failed") {
    await write(io, owner, startupDiagnostic(executable, startFailureErrno(result.exit.error), result.diagnostic, plan.footer));
    return { kind: "exited", code: 1, status: 1 };
  }
  await write(io, owner, scriptDiagnostic(plan, phase, result.exit));
  return result.exit;
}

async function run(supervisor: RuntimeSupervisor, service: Service, context: ProcessContext, owner: LocalWork, io: ContinuationIO, children: PackageChildren, plan: PackagePlan): Promise<ProcessExit> {
  for (const phase of [plan.pre, plan.main, plan.post]) {
    if (!phase) continue;
    owner.check();
    const result = await phaseResult(supervisor, service, context, owner, io, children, plan, phase);
    if (result.kind !== "exited" || result.code !== 0) return result;
  }
  return { kind: "exited", code: 0, status: 0 };
}

function publish(context: ProcessContext, result: ProcessExit): void {
  switch (result.kind) {
    case "exited": context.exit(result.code); return;
    case "signaled": context.defaultSignal(result.code); return;
    case "start-failed": throw new Error("Unrendered package startup failure");
    default: { const exhaustive: never = result; return exhaustive; }
  }
}

/** Host-only prototype. No registration, guest trigger, continuation Worker or Wasm allocation. */
export function packageContinuation(runtime: Pick<Runtime, "filesystem">): GuestLauncher {
  return (context, service) => launchContinuation(runtime, context, service);
}

function launchContinuation(runtime: Pick<Runtime, "filesystem">, context: Parameters<GuestLauncher>[0], service: Service) {
    const owner = new LocalWork();
    const unregister = context.registerRevocation(owner.revoke);
    let io: ContinuationIO | undefined;
    let children: PackageChildren | undefined;
    let settlement: Promise<void> | undefined;
    let reported: { readonly error: unknown } | undefined;
    const settle = () => settlement ??= io?.settle() ?? Promise.resolve();
    const work = Promise.resolve().then(async () => {
      const plan = parsePackagePlan(JSON.parse(context.request.argv[1] ?? "null"));
      const supervisor = await owner.wait(service.ready());
      owner.check();
      const identity = admittedIdentity(context, service);
      const connection = runtime.filesystem.connect(identity);
      const filesystem = new FilesystemClient(connection);
      for (const reservation of connection.reservations) filesystem.adopt(reservation);
      io = new ContinuationIO(context.descriptors, filesystem, owner.abort.signal);
      const transport = service.transportFor(context.pid);
      if (!transport) throw new Error("Continuation transport disappeared");
      children = new PackageChildren(filesystem, service, context, transport, identity);
      service.registerController(context.pid, { filesystem: identity });
      if (!context.started()) return;
      const result = await run(supervisor, service, context, owner, io, children, plan);
      await settle();
      owner.check();
      publish(context, result);
    });
    // Stop joins settlement, never the rejecting work promise that already selected fail.
    const fence = work.catch(error => {
      if (owner.abort.signal.aborted) return;
      reported = { error };
      context.fail(error);
    });
    return { async terminate() {
      owner.revoke();
      await fence;
      try { await settle(); }
      catch (error) { rethrowCleanup(error, reported); }
      finally { unregister(); }
    } };
}

function rethrowCleanup(error: unknown, reported: { readonly error: unknown } | undefined): void {
  if (!reported || error !== reported.error) throw error;
}
