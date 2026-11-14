import { expect, test } from "bun:test";
import { createRuntime, type GuestLauncher, type ProgramDefinition, type RuntimeProcessContext } from "waffle";
import { DescriptorTable, type Stream } from "waffle/core/descriptors";
import { createProgramShell } from "./fixtures/program-shell.js";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { installBunAdapters } from "../../src/bun-adapter.js";
import { PACKAGE_ADAPTER, PACKAGE_CONTINUATION } from "../../src/package-continuation-binding.js";
import { guest } from "../../scripts/fixtures/shared-objects/executor-guest.js";
import type { Request } from "./fixtures/package-handoff-worker.js";

const module = guest(0, [
  { namespace: "bun_package_scripts", name: "handoff" },
].concat(["path_open", "fd_close", "fd_renumber", "fd_fdstat_set_rights", "fd_read"].map(name => ({ namespace: "wasi_snapshot_preview1", name })),
  ["dup", "signal", "exec"].map(name => ({ namespace: "runtime_proc", name }))));
const empty = guest(0);
const workerUrl = new URL("./fixtures/package-handoff-worker.ts", import.meta.url).href;
const notificationWorkerUrl = new URL("../../src/notification-worker-entry.ts", import.meta.url).href;

interface Successor {
  context: RuntimeProcessContext;
  aliases: boolean;
  offset: number;
  root: { fd: number; rights: bigint } | undefined;
}
interface Fixture {
  runtime: ReturnType<typeof createRuntime>;
  shell: Awaited<ReturnType<typeof createProgramShell>>;
  successors: Successor[];
  children: RuntimeProcessContext[];
  observations: unknown[];
  reports: unknown[];
  startupFailure: Error;
  admitting: Promise<void>;
  release(): void;
  uninstall(): void;
  reinstall(): Promise<void>;
  start(): ReturnType<Awaited<ReturnType<typeof createProgramShell>>["spawn"]>;
}

function successor(context: RuntimeProcessContext): Successor {
  const high = context.descriptors.get(1_000_003);
  const fds = context.request.fds;
  const alias = fds.find(fd => fd.child !== 1_000_003 && context.descriptors.get(fd.child)?.description === high?.description);
  const root = fds.find(fd => context.descriptors.get(fd.child)?.preopen === "/");
  return { context, aliases: !!alias, offset: high?.resource.kind === "file" ? high.resource.offset : -1,
    root: root ? { fd: root.child, rights: context.descriptors.get(root.child)!.rightsBase } : undefined };
}

async function using(mode: string, run: (f: Fixture) => Promise<void>, held = false) {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL(import.meta.resolve("waffle/browser/fs-worker")) } });
  const tables: DescriptorTable[] = [];
  const remove: Array<() => void> = [];
  const installations: Awaited<ReturnType<typeof installBunAdapters>>[] = [];
  const gate = Promise.withResolvers<void>();
  try {
    const f = await setup({ runtime, tables, remove, mode, held, gate, installations });
    await run(f);
  } finally {
    gate.resolve();
    for (const installed of installations.reverse()) installed.dispose();
    await cleanup(runtime, remove, tables);
  }
}

async function cleanup(runtime: ReturnType<typeof createRuntime>, remove: Array<() => void>, tables: DescriptorTable[]) {
  try { await runtime.dispose(); }
  finally { for (const unregister of remove.reverse()) unregister(); for (const table of tables) table.dispose(); }
}

const successful = ["live", "resizable", "file-stderr", "reserved-root", "failed-move"];
for (const mode of successful.concat(["moved-reduced", "closed", "closed-reused", "overwritten", "closed-root-alias"])) {
  test(`executor transfers live descriptions and original root: ${mode}`, async () => using(mode, async f => {
    const child = await f.start();
    const status = await child.exit;
    if (!f.successors.length) throw new Error(JSON.stringify({ status, observations: f.observations, output: f.shell.output }));
    expect(status?.kind).toBe("exited");
    expect(status?.code).toBe(successful.includes(mode) ? 0 : 1);
    expect(f.successors).toHaveLength(1);
    const successor = f.successors[0]!;
    expect(successor.context.generation).toBe(2);
    expect(successor.context.request.fds.some(fd => fd.child === 1_000_003)).toBe(true);
    expect(successor.aliases).toBe(true);
    expect(successor.offset).toBe(mode === "file-stderr" ? 30 : 2);
    if (mode === "moved-reduced") expect(successor.root).toEqual({ fd: 7, rights: 0n });
    if (["closed", "closed-reused", "overwritten", "closed-root-alias"].includes(mode)) expect(successor.root).toBeUndefined();
    if (successful.includes(mode)) expect(successor.root?.rights).toBeGreaterThan(0n);
    if (mode === "reserved-root") expect(successor.root?.fd).toBe(4);
    expect(f.observations.some(value => !!value && typeof value === "object" && "type" in value && value.type === "handoff-returned")).toBe(false);
    expect(f.children).toHaveLength(successful.includes(mode) ? 1 : 0);
  }), 30_000);
}

test("admission captures private dependencies across uninstall and reinstall", async () => using("live", async f => {
  const starting = f.start();
  await Promise.race([f.admitting, starting.then(child => child.exit).then(exit => { throw new Error(JSON.stringify({ exit, observations: f.observations, output: f.shell.output })); })]);
  f.uninstall();
  f.release();
  const child = await starting;
  expect((await child.exit).code).toBe(0);
  await f.reinstall();
  expect((await (await f.start()).exit).code).toBe(0);
  expect(f.successors).toHaveLength(2);
}, true), 30_000);

for (const mode of ["reexec-gap", "reexec-compact", "late-census"]) {
  test(`handoff preserves restored root and takes a fresh census: ${mode}`, async () => using(mode, async f => {
    const status = await (await f.start()).exit;
    expect(f.successors).toHaveLength(1);
    const next = f.successors[0]!;
    expect(next.context.generation).toBe(mode.startsWith("reexec") ? 3 : 2);
    expect(next.root?.fd).toBe(mode === "reexec-gap" ? 7 : mode === "late-census" ? 11 : 3);
    expect(next.root?.rights).toBeGreaterThan(0n);
    expect(status).toMatchObject({ kind: "exited", code: 0 });
    expect(f.children).toHaveLength(1);
    expect(next.context.request.fds.some(fd => fd.child === 1_000_003)).toBe(true);
    if (mode === "reexec-gap") expect(f.observations).toContainEqual({ type: "original-root-before-commit", generation: 2, fd: 7, preopen: "/" });
    if (mode === "late-census") {
      expect(next.context.request.fds.some(fd => fd.child === 1_000_005)).toBe(true);
      expect(next.context.request.fds.some(fd => fd.child === 4)).toBe(false);
    }
  }), 30_000);
}

test("caught signals return precommit without a successor or shell", async () => using("caught", async f => {
  expect((await (await f.start()).exit).code).toBe(42);
  expect(f.successors).toHaveLength(0);
  expect(f.children).toHaveLength(0);
}), 30_000);

test("missing private registration fails without returning to the caller loop", async () => using("live", async f => {
  f.uninstall();
  expect((await (await f.start()).exit).code).toBe(1);
  expect(f.successors).toHaveLength(0);
  expect(f.children).toHaveLength(0);
  expect(f.shell.output.join("")).toContain("Package continuation installation failed");
  expect(f.observations.some(value => !!value && typeof value === "object" && "type" in value && value.type === "handoff-returned")).toBe(false);
}), 30_000);

test("committed startup failure never returns to the old caller", async () => using("startup-failure", async f => {
  expect((await (await f.start()).exit).code).toBe(126);
  expect(f.successors).toHaveLength(1);
  expect(f.children).toHaveLength(0);
  expect(f.reports).toEqual([f.startupFailure]);
  expect(f.observations.some(value => !!value && typeof value === "object" && "type" in value && value.type === "handoff-returned")).toBe(false);
}), 30_000);

for (const mode of ["root", "group", "thread", "filesystem", "cancelled"]) {
  test(`private binding checks ${mode} before invalid pointers`, async () => using(mode, async f => {
    const result = await (await f.start()).exit;
    expect(result.kind).toBe(mode === "cancelled" ? "signaled" : "exited");
    expect(result.code).toBe(mode === "cancelled" ? 9 : 42);
    expect(f.successors).toHaveLength(0);
    expect(f.children).toHaveLength(0);
    expect(f.observations.filter(value => !!value && typeof value === "object" && "type" in value && value.type === "precommit")).toHaveLength(mode === "cancelled" ? 0 : 1);
  }), 30_000);
}

async function setup({ runtime, tables, remove, mode, held, gate, installations }: {
  runtime: ReturnType<typeof createRuntime>;
  tables: DescriptorTable[];
  remove: Array<() => void>;
  mode: string;
  held: boolean;
  gate: ReturnType<typeof Promise.withResolvers<void>>;
  installations: Awaited<ReturnType<typeof installBunAdapters>>[];
}) {
  let installed: Awaited<ReturnType<typeof installBunAdapters>>;

  const admitting = Promise.withResolvers<void>();
  const successors: Successor[] = [];
  const children: RuntimeProcessContext[] = [];
  const observations: unknown[] = [];
  const reports: unknown[] = [];
  const startupFailure = new Error("owned startup failure");
  const owner = { ...runtime,
    registerAdapter(name: string, launch: GuestLauncher) {
      return runtime.registerAdapter(name, observingLauncher(name, launch, { successors, reports, startupFailure, mode }));
    },
    registerProgram(name: string, definition: ProgramDefinition) {
      if (name !== PACKAGE_CONTINUATION || !held || !("module" in definition) || !definition.module) return runtime.registerProgram(name, definition);
      const module = definition.module;
      return runtime.registerProgram(name, { ...definition, module: async () => {
        admitting.resolve();
        await gate.promise;
        return typeof module === "function" ? module() : module;
      } });
    },
  };
  installed = await installBunAdapters(owner, { module: empty, workerUrl, notificationWorkerUrl });
  installations.push(installed);
  remove.push(runtime.registerAdapter("caller", (context, service) => service.launchWorker<Request>(context, {
    workerUrl, request: { module: context.module, engine: "quickjs", slots: "off", net: null, trace: false, mode, args: context.request.argv, env: context.request.env },
    onMessage(message) { observations.push(message); },
  })));
  remove.push(runtime.registerProgram("/caller", { module, adapter: "caller", cooperative: true }));
  remove.push(runtime.registerAdapter("shell", context => {
    children.push(context);
    expect(context.request.argv).toEqual(["/bin/bash", "-c", "prepared 'already quoted'"]);
    expect(context.request.env).toEqual({ PATH: "/bin", ACTUAL: "after resolve", EMPTY: "", npm_execpath: "/actual/bun", npm_lifecycle_event: "build", npm_lifecycle_script: "original $UNCHANGED" });
    expect(context.descriptors.inheritable()).toEqual([0, 1, 2]);
    const continuing = successors.at(-1);
    const high = continuing?.context.descriptors.get(1_000_003);
    if (continuing && high?.resource.kind === "file") continuing.offset = high.resource.offset;
    if (context.started()) context.exit(0);
    return { terminate() {} };
  }));
  remove.push(runtime.registerProgram("/bin/bash", { module: empty, adapter: "shell", cooperative: true }));
  await runtime.filesystem.writeFile("/caller", "caller");
  await runtime.filesystem.writeFile("/bin/bash", "shell");
  await runtime.filesystem.writeFile("/later", "abcdefgh");
  await runtime.filesystem.drain();
  const shell = await createProgramShell(runtime, tables);
  const input: Stream = { kind: "terminal", read: () => 0, tryRead: () => 0, write: () => 0, readiness: () => ({ readable: true, writable: true, hangup: false }) };
  tables[0]?.openAt(0, input, 2n | (1n << 27n), 0n);
  createRuntimeTerminalCodec({ descriptors: tables[0], fallback: createWorkerPipeCodec() });
  return { runtime, shell, successors, children, observations, reports, startupFailure, admitting: admitting.promise, release: gate.resolve,
    uninstall() { installed?.dispose(); },
    async reinstall() { installed = await installBunAdapters(owner, { module: empty, workerUrl, notificationWorkerUrl }); installations.push(installed); },
    async start() { return shell.spawn("/caller", ["caller"], { PATH: "/before" }, [0, 1, 2].map(fd => ({ parent: fd, child: fd })).concat(mode === "reserved-root" ? [{ parent: 0, child: 3 }] : [])); },
  };
}

function observingLauncher(name: string, launch: GuestLauncher, observation: Pick<Fixture, "successors" | "reports" | "startupFailure"> & { mode: string }): GuestLauncher {
  return (context, service) => {
    if (name === PACKAGE_ADAPTER) observation.successors.push(successor(context));
    const selected = name === PACKAGE_ADAPTER ? { ...context,
      startFailed(error: unknown) { observation.reports.push(error); context.startFailed(error); },
      fail(error: unknown) { observation.reports.push(error); context.fail(error); },
    } : context;
    const selectedService = observation.mode === "startup-failure" && name === PACKAGE_ADAPTER
      ? { ...service, async ready() { throw observation.startupFailure; } } : service;
    return launch(selected, selectedService);
  };
}
