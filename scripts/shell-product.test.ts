import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { viteApps } from "./app-matrix/product-vite";
import { nextApps } from "./app-matrix/product-next";
import { fixtures, selectProductRun, stages, type Row } from "../tests/shell-product/fixtures";
import { projectFiles } from "../tests/shell-product/project";
// These unit fixtures do not launch the product browser or stage its packages.
import { existsSync, readFileSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guestProvenance } from "./app-matrix/product-provenance";
import { createProductCleanup, exitAfterDeadline, foregroundCycle, liveServer, requireLiveServer, settleResources, withProgress, type Pending } from "../tests/shell-product/lifecycle";
import { PreparationFlow } from "../tests/shell-product/prepare-flow";
import * as preparation from "../tests/shell-product/prepare-flow";
import { networkFiles, readWaffleSelection, waffleCommits, waffleSelectionFile, waffleSourcePlan, writeWaffleSelection } from "../tests/shell-product/waffle-stage";
import { WorkerJobs } from "../tests/shell-product/worker-jobs";
import { confirmWorkerProcessJob, createWorkerProcessTransport, WorkerProcessClient, workerProcessState, type WorkerProcessTransport } from "waffle/proc/worker-client";
import type { SpawnRequest } from "waffle/proc";
import { DescriptorTable } from "waffle/core/descriptors";

function workerJobFixture() {
  const live = new Set<object>();
  const idle = new Set<object>();
  const jobs = new WorkerJobs(live, worker => idle.has(worker));
  function worker(transport: WorkerProcessTransport, adapter: string | undefined = "bun") {
    const handle = { transport };
    live.add(handle);
    jobs.observe(handle, { runtimeProcess: transport, adapter });
    return handle;
  }
  const filesystem = {};
  live.add(filesystem);
  const root = worker(createWorkerProcessTransport({ pid: 23, job: 20 }));
  const baseline = jobs.baseline(23);
  function client(transport: WorkerProcessTransport, postMessage: ConstructorParameters<typeof WorkerProcessClient>[0]["postMessage"] = () => {}) {
    return new WorkerProcessClient({
      transport, descriptors: new DescriptorTable(), postMessage,
      codec: { export() { throw new Error("No descriptors in probe"); }, import() { throw new Error("No descriptors in probe"); }, discard() {} },
    });
  }
  function admit(transport: WorkerProcessTransport, request: SpawnRequest, stage: "reserved" | "launched" = "reserved") {
    const state = workerProcessState(transport);
    jobs.admission({ pid: state.pid, parentPid: state.parentPid, job: state.job, stage }, { request, rootPid: state.rootPid });
  }
  function reserve(parent: typeof root, job = 0) {
    let child: WorkerProcessTransport | undefined;
    let request: SpawnRequest | undefined;
    const parentClient = client(parent.transport, message => {
      if (message.operation !== "spawn") return;
      child = message.transport;
      request = message.request;
      admit(child, request);
    });
    parentClient.spawn(parentClient.pid, { executable: "/bin/bun", argv: ["bun"], env: {}, cwd: "/", job, fds: [] });
    if (!child || !request) throw new Error("Expected real shared-directory spawn");
    return { transport: child, request };
  }
  function launch(reservation: ReturnType<typeof reserve>, adapter = "bun") {
    const handle = worker(reservation.transport, adapter);
    admit(reservation.transport, reservation.request, "launched");
    return handle;
  }
  function spawn(parent: typeof root, job = 0) { return launch(reserve(parent, job)); }
  function collect(parent: typeof root, child: typeof root) {
    client(child.transport).exit(0);
    confirmWorkerProcessJob(child.transport);
    expect(client(parent.transport).wait(parent.transport.pid, child.transport.pid)?.status).toBe(0);
  }
  return { live, idle, jobs, root, filesystem, baseline, spawn, reserve, launch, admit, collect };
}

test("idle pool workers are excluded only while the actual ownership query remains positive", () => {
  const probe = workerJobFixture();
  const idle = {};
  probe.live.add(idle);
  probe.idle.add(idle);
  const baseline = probe.jobs.baseline(23);
  expect(baseline.baseline.has(idle)).toBe(false);
  const dev = probe.spawn(probe.root);
  const foreground = probe.jobs.foreground(baseline);
  probe.live.delete(dev);
  expect(() => probe.jobs.stopped(baseline, foreground)).not.toThrow();
  probe.idle.delete(idle);
  expect(() => probe.jobs.foreground(baseline)).toThrow("no captured process ownership");
  expect(() => probe.jobs.stopped(baseline, foreground)).toThrow("no captured process ownership");
});

test("a worker leased after baseline must have an admitted process and physically stop", () => {
  const probe = workerJobFixture();
  const worker = {};
  probe.live.add(worker);
  probe.idle.add(worker);
  const baseline = probe.jobs.baseline(23);
  const reservation = probe.reserve(probe.root);
  probe.idle.delete(worker);
  probe.jobs.observe(worker, { runtimeProcess: reservation.transport, adapter: "bun" });
  probe.admit(reservation.transport, reservation.request, "launched");
  const foreground = probe.jobs.foreground(baseline);
  expect(() => probe.jobs.stopped(baseline, foreground)).toThrow("not physically stopped");
  probe.live.delete(worker);
  expect(() => probe.jobs.stopped(baseline, foreground)).not.toThrow();
  probe.live.add(worker);
  expect(() => probe.jobs.stopped(baseline, foreground)).toThrow("not physically stopped");
  probe.idle.add(worker);
  expect(() => probe.jobs.stopped(baseline, foreground)).toThrow("already received a process request");
});

test("Ctrl-C physical worker proof allows a positively owned independent job created during interrupt", () => {
  const probe = workerJobFixture();
  const dev = probe.spawn(probe.root);
  const child = probe.spawn(dev, workerProcessState(dev.transport).job);
  const foreground = probe.jobs.foreground(probe.baseline);
  const detached = probe.spawn(dev);
  expect(workerProcessState(detached.transport).jobForeground).toBe(true);
  expect(workerProcessState(detached.transport).jobOwner).toBe(workerProcessState(dev.transport).pid);
  probe.live.delete(dev);
  probe.live.delete(child);
  expect(probe.live.size).toBe(3);
  expect(() => probe.jobs.stopped(probe.baseline, foreground)).not.toThrow();
});

test("Ctrl-C rejects every live foreground member even when a legitimate independent job also survives", () => {
  for (const survivor of ["dev", "child"] as const) {
    const probe = workerJobFixture();
    const dev = probe.spawn(probe.root);
    const child = probe.spawn(dev, workerProcessState(dev.transport).job);
    const foreground = probe.jobs.foreground(probe.baseline);
    probe.spawn(dev);
    probe.live.delete(survivor === "dev" ? child : dev);
    expect(() => probe.jobs.stopped(probe.baseline, foreground)).toThrow("not physically stopped");
  }
});

test("Ctrl-C keeps captured foreground ownership after shared process metadata is no longer readable", () => {
  const probe = workerJobFixture();
  const dev = probe.spawn(probe.root);
  const foreground = probe.jobs.foreground(probe.baseline);
  probe.collect(probe.root, dev);
  expect(() => workerProcessState(dev.transport)).toThrow();
  expect(() => probe.jobs.stopped(probe.baseline, foreground)).toThrow("not physically stopped");
});

test("Ctrl-C tracks positive requested ownership even when runtime assignment is wrong", () => {
  const probe = workerJobFixture();
  const dev = probe.spawn(probe.root);
  const foreground = probe.jobs.foreground(probe.baseline);
  const wrong = probe.reserve(dev);
  // Fault injection only at admission: an ordinary join must not be excused as detach.
  const requested = workerProcessState(dev.transport).job;
  const state = workerProcessState(wrong.transport);
  const live = new Set<object>([probe.root, probe.filesystem]);
  const broken = new WorkerJobs(live, () => false);
  broken.observe(probe.root, { runtimeProcess: probe.root.transport });
  const baseline = broken.baseline(23);
  broken.observe(dev, { runtimeProcess: dev.transport, adapter: "bun" });
  const devState = workerProcessState(dev.transport);
  broken.admission({ pid: devState.pid, parentPid: devState.parentPid, job: devState.job, stage: "launched" }, { rootPid: devState.rootPid, request: { ...wrong.request, job: 0 } });
  broken.admission({ pid: state.pid, parentPid: state.parentPid, job: state.job, stage: "reserved" }, { rootPid: state.rootPid, request: { ...wrong.request, job: requested } });
  const handle = probe.launch(wrong);
  live.add(handle);
  broken.observe(handle, { runtimeProcess: handle.transport, adapter: "bun" });
  expect(() => broken.stopped(baseline, foreground)).toThrow(`Requested job ${requested} assigned ${state.job} for PID ${state.pid}`);
});

test("Ctrl-C rejects foreground reservations and late launches that have no physical worker yet", () => {
  const probe = workerJobFixture();
  const dev = probe.spawn(probe.root);
  const foreground = probe.jobs.foreground(probe.baseline);
  probe.reserve(dev, workerProcessState(dev.transport).job);
  probe.live.delete(dev);
  expect(() => probe.jobs.stopped(probe.baseline, foreground)).toThrow("Unresolved foreground launch");
  const next = probe.jobs.command(probe.baseline);
  const restarted = probe.spawn(probe.root);
  const nextForeground = probe.jobs.foreground(next);
  probe.live.delete(restarted);
  expect(() => probe.jobs.stopped(next, nextForeground)).toThrow("Unresolved foreground launch");
});

test("Ctrl-C rejects unknown detach callers and an empty foreground cohort", () => {
  const probe = workerJobFixture();
  expect(() => probe.jobs.foreground(probe.baseline)).toThrow("no captured foreground");
  const dev = probe.launch(probe.reserve(probe.root), "unknown-adapter");
  const foreground = probe.jobs.foreground(probe.baseline);
  probe.spawn(dev);
  probe.live.delete(dev);
  expect(() => probe.jobs.stopped(probe.baseline, foreground)).toThrow("no explicit Bun detach request");
});

test("Ctrl-C detects baseline identity loss even when another worker replaces its count", () => {
  for (const missing of ["root", "filesystem"] as const) {
    const probe = workerJobFixture();
    const dev = probe.spawn(probe.root);
    const foreground = probe.jobs.foreground(probe.baseline);
    probe.spawn(dev);
    probe.live.delete(dev);
    probe.live.delete(probe[missing]);
    expect(probe.live.size).toBe(2);
    expect(() => probe.jobs.stopped(probe.baseline, foreground)).toThrow("Baseline worker");
  }
});

test("Ctrl-C rejects unclassified workers, invalid transports and foreign roots", () => {
  for (const extra of [undefined, { runtimeProcess: {} }, { runtimeProcess: createWorkerProcessTransport({ pid: 100, job: 100 }) }]) {
    const probe = workerJobFixture();
    const dev = probe.spawn(probe.root);
    const foreground = probe.jobs.foreground(probe.baseline);
    const unknown = {};
    probe.live.add(unknown);
    probe.jobs.observe(unknown, extra);
    probe.live.delete(dev);
    expect(() => probe.jobs.stopped(probe.baseline, foreground)).toThrow();
  }
});

test("Ctrl-C does not exempt a new shell-owned foreground job created after selection", () => {
  const probe = workerJobFixture();
  const dev = probe.spawn(probe.root);
  const foreground = probe.jobs.foreground(probe.baseline);
  probe.live.delete(dev);
  probe.spawn(probe.root);
  expect(() => probe.jobs.stopped(probe.baseline, foreground)).toThrow("not physically stopped");
});

async function terminalInterruptWithIndependentJob(keepListener: boolean) {
  const probe = workerJobFixture();
  const source = readFileSync(join(import.meta.dir, "../tests/shell-product/main.ts"), "utf8");
  const terminal = source.match(/^class Terminal \{[\s\S]*?^}/m)?.[0];
  if (!terminal) throw new Error("Missing actual Terminal class");
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(terminal);
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(state, 0, 2);
  const listeners = new Map([[3137, {}]]);
  let dev: ReturnType<typeof probe.spawn> | undefined;
  const shell = {
    process: { pid: 23 },
    terminal: { state, send: () => true, interrupt() {}, discardInput: () => true, resumeInput() {} },
    interrupt() {
      if (!dev) throw new Error("Expected live dev worker");
      probe.spawn(dev);
      probe.live.delete(dev);
      if (!keepListener) listeners.clear();
      Atomics.store(state, 0, 1);
    },
  };
  const result: Promise<unknown> = runInNewContext(`${code}\n(async () => {
    const subject = new Terminal("next-15-app", shell);
    subject.beginServer("bun run dev", 3137);
    start();
    subject.pending.entered = true;
    subject.finish = async () => ({ code: 0, output: "INTERRUPT_STATUS:130" });
    return subject.interrupt();
  })()`, {
    shell, listeners, workerJobs: probe.jobs, control: { phase: 0 },
    start: () => { dev = probe.spawn(probe.root); },
    setInterval: () => 0,
    check: (value: unknown, message: string) => assert.ok(value, message),
    until: async (predicate: () => boolean) => assert.ok(predicate(), "Expected immediate prompt"),
    requireLiveServer, liveServer, TextEncoder, Atomics,
  });
  return result;
}

test("actual Terminal interrupt accepts an independent job after status130 and foreground stop", async () => {
  expect(await terminalInterruptWithIndependentJob(false)).toEqual({ code: 130, output: "INTERRUPT_STATUS:130" });
});

test("actual Terminal interrupt still rejects a listener left by an otherwise stopped foreground job", async () => {
  await expect(terminalInterruptWithIndependentJob(true)).rejects.toThrow("Ctrl-C removes guest network listeners before prompt");
});

test("shell product reuses unchanged original Vite React and Next 15 source and dependencies", () => {
  expect(fixtures.map(fixture => fixture.id)).toEqual(["vite-react", "next-15-app"]);
  for (const fixture of fixtures) {
    const source = viteApps.concat(nextApps).find(app => app.id === fixture.id);
    expect(source).toBeDefined();
    if (!source) throw new Error(`Missing catalog fixture ${fixture.id}`);
    expect(fixture.files).toBe(source.files);
    expect(fixture.dependencies).toBe(source.dependencies);
    expect(fixture.buildOutputs.length).toBeGreaterThan(0);
  }
});

test("both real development commands accept the default and inline PORT override", () => {
  for (const fixture of fixtures) {
    expect(fixture.scripts.dev).toContain("--port ${PORT:-3137}");
    expect(fixture.dependencies[fixture.tool]).toBeDefined();
    expect(fixture.scripts.build).toBe(`${fixture.tool} build`);
  }
});

test("scoreboard includes every required stage and all three stop cycles", () => {
  expect(new Set(stages).size).toBe(stages.length);
  expect(stages.filter(name => /^ctrl-c-\d$/.test(name))).toEqual(["ctrl-c-1", "ctrl-c-2", "ctrl-c-3"]);
  expect(stages).toContain("install-and-dev-dom");
  expect(stages).toContain("build-tail");
  expect(stages).toContain("bun-x-grep");
  expect(stages).toContain("redirect");
  expect(stages).toContain("and-or-status");
  expect(stages).toContain("cwd");
  expect(stages).toContain("port-3001-dom");
});

test("Ctrl-C rejects an exited server, a prompt, a command, and a missing or wrong listener", () => {
  const server: Pending = { kind: "server", port: 3137, offset: 0, entered: true };
  const ports = new Map([[3137, {}]]);
  expect(liveServer(server, 2, ports)).toBe(true);
  expect(() => requireLiveServer(server, 2, ports)).not.toThrow();
  for (const phase of [0, 1, 2]) expect(liveServer(server, phase, ports)).toBe(phase !== 1);
  expect(() => requireLiveServer(server, 1, ports)).toThrow("live foreground");
  expect(() => requireLiveServer(server, 2, new Map())).toThrow("expected listener");
  expect(() => requireLiveServer(server, 2, new Map([[3001, {}]]))).toThrow("expected listener");
  expect(() => requireLiveServer({ ...server, entered: false }, 2, ports)).toThrow();
  expect(() => requireLiveServer({ kind: "command", offset: 0, token: "done" }, 2, ports)).toThrow();
  expect(() => requireLiveServer(undefined, 2, ports)).toThrow();
});

test("failed startup with a pending foreground command blocks Ctrl-C and dependent commands", () => {
  const diagnostics = {
    tailAvailable: true,
    transcripts: [{ app: "vite-react", text: "PRODUCT> bun install && bun run dev\r\nDone! Checked 63 packages (no changes) [14ms]\n" }],
    listeners: [],
    workers: 1,
    pending: { kind: "server", port: 3137, offset: 2179, entered: true } satisfies Pending,
    liveServer: false,
  };
  expect(foregroundCycle(diagnostics)).toEqual({
    blocked: "Foreground command has not completed; no live expected listener for Ctrl-C",
    available: false,
  });
});

test("observed server exit permits continuation without claiming a Ctrl-C pass", () => {
  expect(foregroundCycle({ pending: undefined, liveServer: false })).toEqual({
    blocked: "Server returned to prompt before Ctrl-C",
    available: true,
  });
});

test("live expected server requires a successful stop before dependent commands", () => {
  const diagnostics = {
    pending: { kind: "server", port: 3137, offset: 2179, entered: true } satisfies Pending,
    liveServer: true,
  };
  expect(foregroundCycle(diagnostics)).toEqual({ blocked: undefined, available: false });
  expect(foregroundCycle(diagnostics, false).available).toBe(false);
  expect(foregroundCycle(diagnostics, true).available).toBe(true);
});

async function installFailureFlow(pending: Pending) {
  const source = readFileSync(join(import.meta.dir, "../web/tests/browser-shell-product.ts"), "utf8");
  const functions = ["stage", "runCycle", "runApp"].map(name => {
    const match = source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}`, "m"));
    if (!match) throw new Error(`Missing driver function ${name}`);
    return match[0];
  });
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(functions.join("\n"));
  const rows: Row[] = [];
  const commands: string[] = [];
  const calls = { dev: 0, interrupt: 0 };
  let foreground: Pending;
  const shellProduct = {
    open: async () => {}, close: async () => {},
    diagnostics: () => ({ pending: foreground, liveServer: false, tailAvailable: true }),
    readFile: async () => "REDIRECT_REAL_BUN\n",
  };
  async function command(text: string) {
    commands.push(text);
    if (foreground) throw new Error("Previous foreground command must finish first");
    if (text === "bun install") {
      foreground = pending;
      throw new Error(pending ? "Timeout: PRODUCT_DONE_1" : "bun install exited with status 1");
    }
    return "EXIT:7\nOR_BRANCH\nAND_BRANCH\nREDIRECT_REAL_BUN";
  }
  const runApp: unknown = runInNewContext(`${code}\nrunApp`, {
    assert, shellProduct, foregroundCycle, command, withProgress, run: selectProductRun(),
    page: { evaluate: async (execute: (arg: unknown) => unknown, arg?: unknown) => structuredClone(await execute(arg)) },
    mirror: { base: "unused" },
    dev: async () => { calls.dev++; throw new Error("Development command must remain blocked"); },
    interrupt: async () => { calls.interrupt++; throw new Error("Interrupt must remain blocked"); },
    record: async (row: Row) => { rows.push(row); },
    capture: async () => {}, stopAfterFailure: async () => {},
    message: (error: unknown) => error instanceof Error ? error.message : String(error),
    console: { log() {}, error() {} },
  });
  if (typeof runApp !== "function") throw new Error("Driver runApp must be callable");
  await runApp(fixtures[0]);
  return { rows, commands, calls };
}

test("actual driver flow blocks independent commands after a pending install timeout", async () => {
  const result = await installFailureFlow({ kind: "command", token: "PRODUCT_DONE_1", offset: 0 });
  expect(result.rows[0]).toEqual({ app: "vite-react", stage: "install", status: "fail", detail: "Timeout: PRODUCT_DONE_1" });
  const independent = result.rows.filter(row => ["redirect", "and-or-status", "cwd"].includes(row.stage));
  expect(independent.map(row => row.status)).toEqual(["blocked", "blocked", "blocked"]);
  expect(independent.every(row => row.detail === "Foreground command completion or prompt recovery was not observed")).toBe(true);
  expect(result.rows.filter(row => row.status === "fail")).toHaveLength(1);
  expect(result.commands).toEqual(["bun install"]);
  expect(result.calls).toEqual({ dev: 0, interrupt: 0 });
});

test("actual driver flow allows independent commands after a completed nonzero install", async () => {
  const result = await installFailureFlow(undefined);
  expect(result.rows[0]).toEqual({ app: "vite-react", stage: "install", status: "fail", detail: "bun install exited with status 1" });
  const independent = result.rows.filter(row => ["redirect", "and-or-status", "cwd"].includes(row.stage));
  expect(independent.map(row => row.status)).toEqual(["pass", "pass", "pass"]);
  const installDependent = result.rows.filter(row => !["install", "redirect", "and-or-status", "cwd", "ctrl-c-port"].includes(row.stage));
  expect(installDependent).toHaveLength(9);
  expect(installDependent.every(row => row.status === "blocked" && row.detail === "Guest install failed")).toBe(true);
  expect(result.rows.filter(row => row.status === "fail")).toHaveLength(1);
  expect(result.commands).toHaveLength(4);
  expect(result.calls).toEqual({ dev: 0, interrupt: 0 });
});

test("product run defaults to the unchanged full matrix and validates explicit modes", () => {
  const full = selectProductRun();
  expect(full.mode).toBe("full");
  expect(full.fixtures).toBe(fixtures);
  expect(full.stages).toBe(stages);
  expect(selectProductRun("full")).toEqual(full);
  const focused = selectProductRun("next-install-only");
  expect(focused.mode).toBe("next-install-only");
  expect(focused.fixtures.map(fixture => fixture.id)).toEqual(["next-15-app"]);
  expect(focused.fixtures[0]).toBe(fixtures[1]);
  expect(focused.stages).toEqual(["install"]);
  for (const invalid of ["", "next", "FULL", "full "]) expect(() => selectProductRun(invalid)).toThrow("SHELL_PRODUCT_RUN");
});

test("focused dev modes select one original app and all mandatory first-cycle prerequisites", () => {
  for (const [mode, fixture] of [["vite-dev-ctrl-c", fixtures[0]], ["next-dev-ctrl-c", fixtures[1]]] as const) {
    if (!fixture) throw new Error("Missing original catalog fixture");
    const selected = selectProductRun(mode);
    expect(selected.mode).toBe(mode);
    expect(selected.fixtures).toEqual([fixture]);
    expect(selected.fixtures[0]).toBe(fixture);
    expect(selected.stages).toEqual(["install", "install-and-dev-dom", "ctrl-c-1"]);
  }
  for (const invalid of ["nuxt-dev-ctrl-c", "vite-install-only", "next-dev", "next-build", "next-dev-ctrl-c:ctrl-c-1", "vite-dev-ctrl-c "]) {
    expect(() => selectProductRun(invalid)).toThrow("SHELL_PRODUCT_RUN");
  }
});

test("bun-shell mode selects the shell command stages without app installs", () => {
  const selected = selectProductRun("bun-shell");
  expect(selected.mode).toBe("bun-shell");
  expect(selected.fixtures.map(fixture => fixture.id)).toEqual(["bun-shell"]);
  expect(selected.stages).toEqual(["bun-exec", "bun-shell-api", "bun-init", "bun-create", "bun-repl"]);
  expect(selected.stages.some(stage => (stages as readonly string[]).includes(stage))).toBe(false);
});

test("unknown product run mode fails at driver initialization before report or resource creation", async () => {
  const source = readFileSync(join(import.meta.dir, "../web/tests/browser-shell-product.ts"), "utf8");
  const prefix = source.slice(source.indexOf("const root ="), source.indexOf("async function save()"));
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(prefix.replaceAll("import.meta.dir", JSON.stringify(import.meta.dir)));
  for (const mode of ["next-install-typo", "nuxt-dev-ctrl-c", "next-build", "vite-dev-ctrl-c:ctrl-c-1"]) {
    let created = false;
    const initialize = async () => runInNewContext(`(async () => { ${script} })()`, {
      assert, selectProductRun, resolve: (...parts: string[]) => parts.join("/"),
      process: { env: { SHELL_PRODUCT_RUN: mode } },
      mkdir: async () => { created = true; },
    });
    await expect(initialize()).rejects.toThrow("SHELL_PRODUCT_RUN");
    expect(created).toBe(false);
  }
});

test("driver persists selected scope before staging for full and focused reports", async () => {
  const source = readFileSync(join(import.meta.dir, "../web/tests/browser-shell-product.ts"), "utf8");
  const prefix = source.slice(source.indexOf("const root ="), source.indexOf("async function save()"));
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(prefix.replaceAll("import.meta.dir", JSON.stringify(import.meta.dir)));
  for (const mode of [undefined, "full", "next-install-only", "vite-dev-ctrl-c", "next-dev-ctrl-c"]) {
    const writes: { path: string; value: unknown }[] = [];
    await runInNewContext(`(async () => { ${script} })()`, {
      assert, selectProductRun, resolve: (...parts: string[]) => parts.join("/"), join,
      process: { env: { SHELL_PRODUCT_RUN: mode, SHELL_PRODUCT_REPORTS: "/unused-reports" } },
      mkdir: async () => {},
      Bun: { write: async (path: string, text: string) => { writes.push({ path, value: JSON.parse(text) }); } },
    });
    const selected = selectProductRun(mode);
    expect(writes).toEqual([{ path: "/unused-reports/run.json", value: {
      mode: selected.mode, apps: selected.fixtures.map(fixture => fixture.id), stages: selected.stages,
    } }]);
  }
});

type FocusedDevOptions = { mode: "vite-dev-ctrl-c" | "next-dev-ctrl-c"; installTimeout?: boolean; pageFailure?: boolean; startup?: "pending" | "exited"; interruptFailure?: boolean };

type SelectedDriverOptions = { code?: number; openFailure?: boolean; networkErrors?: string[]; released?: { workers: number; listeners: number }; focused?: FocusedDevOptions };

async function selectedDriverFlow({ code = 0, openFailure = false, networkErrors = [], released = { workers: 0, listeners: 0 }, focused }: SelectedDriverOptions = {}) {
  const source = readFileSync(join(import.meta.dir, "../web/tests/browser-shell-product.ts"), "utf8");
  const functions = ["command", "stage", "missingStages", "runFixture", "runCycle", "runApp"].map(name => {
    const match = source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}`, "m"));
    if (!match) throw new Error(`Missing driver function ${name}`);
    return match[0];
  });
  const caller = source.slice(source.indexOf("  await page.evaluate(() => globalThis.shellProduct.setup());"), source.indexOf('} catch (error) {\n  await record'));
  if (!caller.includes("await runFixture(fixture)")) throw new Error("Missing driver fixture caller");
  const accounting = source.match(/^    const tasks:.*? = .+?\.map\(fixture => \(\) => missingStages\(fixture\)\);$/m)?.[0];
  const exit = source.match(/^process.exitCode = .+;$/m)?.[0];
  if (!accounting || !exit) throw new Error("Missing driver selection callers");
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(functions.concat([
    `async function execute() { ${caller}\n${accounting}\nawait settleResources(tasks); ${exit} }\nexecute()`,
  ]).join("\n"));
  const rows: Row[] = [];
  const commands: string[] = [];
  const opened: string[] = [];
  const development: { app: string; command: string }[] = [];
  let interrupts = 0;
  let pending: Pending;
  let liveServer = false;
  let closed = 0;
  const process: { exitCode?: number } = {};
  const shellProduct = {
    setup: async () => {}, cleanup: async () => released,
    open: async (fixture: { id: string }) => {
      opened.push(fixture.id);
      if (openFailure) throw new Error("Fixture open failed");
    },
    close: async () => { closed++; },
    command: async (text: string) => {
      commands.push(text);
      if (focused?.installTimeout) {
        pending = { kind: "command", token: "PRODUCT_DONE_1", offset: 0 };
        throw new Error("Timeout: PRODUCT_DONE_1");
      }
      return { code, output: "guest install output" };
    },
    diagnostics: () => ({ pending, liveServer, tailAvailable: true }),
  };
  async function dev(fixture: { id: string }, _stage: string, command: string) {
    if (!focused) throw new Error("Unselected dev stage executed");
    development.push({ app: fixture.id, command });
    pending = { kind: "server", port: 3137, offset: 0, entered: true };
    if (focused.startup === "exited") pending = undefined;
    if (focused.startup) throw new Error("Server failed before its expected listener");
    liveServer = true;
    if (focused.pageFailure) throw new Error("service-worker HTTP 500 !== 200");
    return "service-worker HTTP 200; original fixture DOM loaded";
  }
  async function interrupt() {
    if (!focused) throw new Error("Unselected interrupt executed");
    interrupts++;
    if (!liveServer) throw new Error("No live foreground server");
    if (focused.interruptFailure) throw new Error("Foreground worker still running");
    pending = undefined; liveServer = false;
    return "Ctrl-C status 130; guest listener removed; PROMPT_USABLE";
  }
  await runInNewContext(script, {
    assert: { ...assert, deepEqual: (actual: unknown, expected: unknown) => assert.deepEqual(structuredClone(actual), structuredClone(expected)) },
    shellProduct, foregroundCycle, withProgress, settleResources,
    run: selectProductRun(focused?.mode ?? "next-install-only"),
    fixtures, stages, rows, timeout: 1234,
    page: { evaluate: async (execute: (arg: unknown) => unknown, arg?: unknown) => structuredClone(await execute(arg)) },
    external: networkErrors, process,
    mirror: { base: "unused", misses: [], errors: [], snapshot: () => ({}) },
    Bun: { write: async () => {} }, join, reports: "unused",
    dev, interrupt,
    record: async (row: Row) => { rows.push(row); },
    capture: async () => {}, stopAfterFailure: async () => {},
    message: (error: unknown) => error instanceof Error ? error.message : String(error),
    console: { log() {}, error() {} },
  });
  return { rows, commands, opened, closed, development, interrupts, exitCode: process.exitCode };
}

test("focused driver executes only Next guest install and accounts for only its selected stage", async () => {
  const result = await selectedDriverFlow();
  expect(result.opened).toEqual(["next-15-app"]);
  expect(result.commands).toEqual(["bun install"]);
  expect(result.rows.map(row => [row.app, row.stage, row.status])).toEqual([
    ["all", "setup", "pass"], ["next-15-app", "install", "pass"], ["all", "cleanup", "pass"], ["all", "network", "pass"],
  ]);
  expect(result.rows[1]?.detail).toBe("bun install\nguest install output");
  expect(result.closed).toBe(1);
  expect(result.exitCode).toBe(0);
});

test("focused driver requires actual guest install exit zero without adding full-workflow blocked rows", async () => {
  const result = await selectedDriverFlow({ code: 1 });
  expect(result.opened).toEqual(["next-15-app"]);
  expect(result.commands).toEqual(["bun install"]);
  expect(result.rows.map(row => [row.app, row.stage, row.status])).toEqual([
    ["all", "setup", "pass"], ["next-15-app", "install", "fail"], ["all", "cleanup", "pass"], ["all", "network", "pass"],
  ]);
  expect(result.rows[1]?.detail).toContain("guest install output");
  expect(result.closed).toBe(1);
  expect(result.exitCode).toBe(1);
});

test("focused fixture setup failure records the missing install but no unselected stages", async () => {
  const result = await selectedDriverFlow({ openFailure: true });
  expect(result.commands).toEqual([]);
  expect(result.rows.map(row => [row.app, row.stage, row.status])).toEqual([
    ["all", "setup", "pass"], ["next-15-app", "session", "fail"], ["next-15-app", "install", "blocked"],
    ["all", "cleanup", "pass"], ["all", "network", "pass"],
  ]);
  expect(result.closed).toBe(1);
  expect(result.exitCode).toBe(1);
});

test("focused driver still fails replay and guest cleanup guards", async () => {
  const result = await selectedDriverFlow({ networkErrors: ["Unexpected external request"] });
  expect(result.rows.find(row => row.stage === "network")?.status).toBe("fail");
  expect(result.exitCode).toBe(1);
  await expect(selectedDriverFlow({ released: { workers: 1, listeners: 0 } })).rejects.toThrow();
  await expect(selectedDriverFlow({ released: { workers: 0, listeners: 1 } })).rejects.toThrow();
});

for (const [mode, app] of [["vite-dev-ctrl-c", "vite-react"], ["next-dev-ctrl-c", "next-15-app"]] as const) {
  test(`${mode} dispatches install, one first cycle and exactly its six selected rows`, async () => {
    const result = await selectedDriverFlow({ focused: { mode } });
    expect(result.opened).toEqual([app]);
    expect(result.commands).toEqual(["bun install"]);
    expect(result.development).toEqual([{ app, command: "bun run dev" }]);
    expect(result.interrupts).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.rows.map(row => [row.app, row.stage, row.status])).toEqual([
      ["all", "setup", "pass"], [app, "install", "pass"], [app, "install-and-dev-dom", "pass"],
      [app, "ctrl-c-1", "pass"], ["all", "cleanup", "pass"], ["all", "network", "pass"],
    ]);
    expect(result.exitCode).toBe(0);
  });

  test(`${mode} retains HTTP500 failure while a live server permits the original Ctrl-C`, async () => {
    const result = await selectedDriverFlow({ focused: { mode, pageFailure: true } });
    expect(result.rows.find(row => row.stage === "install-and-dev-dom")).toMatchObject({ app, status: "fail", detail: "service-worker HTTP 500 !== 200" });
    expect(result.rows.find(row => row.stage === "ctrl-c-1")?.status).toBe("pass");
    expect(result.rows).toHaveLength(6);
    expect(result.interrupts).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  test(`${mode} cannot skip a failed install to claim dev or Ctrl-C success`, async () => {
    const result = await selectedDriverFlow({ code: 1, focused: { mode } });
    expect(result.commands).toEqual(["bun install"]);
    expect(result.development).toEqual([]);
    expect(result.interrupts).toBe(0);
    expect(result.rows.filter(row => row.app === app).map(row => [row.stage, row.status])).toEqual([
      ["install", "fail"], ["install-and-dev-dom", "blocked"], ["ctrl-c-1", "blocked"],
    ]);
    expect(result.exitCode).toBe(1);
  });

  test(`${mode} leaves dev and Ctrl-C blocked while an install command is pending`, async () => {
    const result = await selectedDriverFlow({ focused: { mode, installTimeout: true } });
    expect(result.rows.find(row => row.stage === "install")).toMatchObject({ status: "fail", detail: "Timeout: PRODUCT_DONE_1" });
    expect(result.rows.filter(row => row.status === "blocked").map(row => row.stage)).toEqual(["install-and-dev-dom", "ctrl-c-1"]);
    expect(result.development).toEqual([]);
    expect(result.interrupts).toBe(0);
    expect(result.exitCode).toBe(1);
  });

  test(`${mode} blocks interruption for a pending startup or an exited server`, async () => {
    for (const startup of ["pending", "exited"] as const) {
      const result = await selectedDriverFlow({ focused: { mode, startup } });
      expect(result.development).toEqual([{ app, command: "bun run dev" }]);
      expect(result.interrupts).toBe(0);
      expect(result.rows.find(row => row.stage === "install-and-dev-dom")?.status).toBe("fail");
      expect(result.rows.find(row => row.stage === "ctrl-c-1")?.status).toBe("blocked");
      expect(result.exitCode).toBe(1);
    }
  });

  test(`${mode} keeps an interrupt failure without a restart or retry`, async () => {
    const result = await selectedDriverFlow({ focused: { mode, interruptFailure: true } });
    expect(result.rows.find(row => row.stage === "ctrl-c-1")).toMatchObject({ status: "fail", detail: "Foreground worker still running" });
    expect(result.interrupts).toBe(1);
    expect(result.development).toHaveLength(1);
    expect(result.rows).toHaveLength(6);
    expect(result.exitCode).toBe(1);
  });

  test(`${mode} accounts for all selected prerequisites after fixture setup failure`, async () => {
    const result = await selectedDriverFlow({ openFailure: true, focused: { mode } });
    expect(result.commands).toEqual([]);
    expect(result.development).toEqual([]);
    expect(result.interrupts).toBe(0);
    expect(result.rows.filter(row => row.status === "blocked").map(row => row.stage)).toEqual(["install", "install-and-dev-dom", "ctrl-c-1"]);
    expect(result.rows.find(row => row.stage === "session")?.status).toBe("fail");
    expect(result.closed).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  test(`${mode} retains mandatory replay and global worker/listener cleanup guards`, async () => {
    const result = await selectedDriverFlow({ networkErrors: ["Unexpected external request"], focused: { mode } });
    expect(result.rows.find(row => row.stage === "network")?.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    await expect(selectedDriverFlow({ released: { workers: 1, listeners: 0 }, focused: { mode } })).rejects.toThrow();
    await expect(selectedDriverFlow({ released: { workers: 0, listeners: 1 }, focused: { mode } })).rejects.toThrow();
  });
}

test("actual preparation caller restores Bun from the packed archive without editing shared hardlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-sp-restore-"));
  const flow = new PreparationFlow();
  try {
    const temporary = join(directory, "packed");
    const destination = join(directory, "consumer");
    const source = join(directory, "source/package");
    const installed = join(destination, "node_modules/bun-wasm");
    const cached = join(directory, "borrowed-cache");
    await Promise.all([temporary, source, installed, cached].map(path => mkdir(path, { recursive: true })));
    const waffle = "git+https://github.com/ShaulLavo/waffle.git#" + "a".repeat(40);
    const metadata = JSON.stringify({ name: "bun-wasm", peerDependencies: { waffle } });
    await writeFile(join(source, "package.json"), metadata);
    await writeFile(join(source, "launcher.ts"), 'export const clean = "packed archive";\n');
    const archive = "bun-wasm-test.tgz";
    await flow.execute(["tar", "-czf", join(temporary, archive), "-C", join(directory, "source"), "package"], directory);
    await cp(join(temporary, archive), join(destination, archive));
    await writeFile(join(cached, "launcher.ts"), 'import "./missing-diagnostic.js";\n');
    await link(join(cached, "launcher.ts"), join(installed, "launcher.ts"));
    await writeFile(join(installed, "package.json"), metadata);
    await writeFile(join(installed, "stale-only.ts"), "not in the archive");
    const shell = join(destination, "node_modules/bash-web");
    await mkdir(shell);
    await writeFile(join(shell, "package.json"), JSON.stringify({ peerDependencies: { waffle } }));
    const driver = readFileSync(join(import.meta.dir, "../web/tests/browser-shell-product-prepare.ts"), "utf8");
    const peer = driver.match(/^async function peer\([\s\S]*?^}/m)?.[0];
    if (!peer) throw new Error("Missing preparation peer check");
    const caller = driver.slice(driver.indexOf("  const installedWaffle ="), driver.indexOf("  await detachPackage(shell);"));
    const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`${peer}\n(async () => { ${caller} })()`);
    await runInNewContext(script, { ...preparation, assert, Bun, join, destination, temporary, archive, waffle, flow });
    expect(await readFile(join(installed, "launcher.ts"), "utf8")).toBe(await readFile(join(source, "launcher.ts"), "utf8"));
    expect(await readFile(join(installed, "package.json"), "utf8")).toBe(metadata);
    expect(existsSync(join(installed, "stale-only.ts"))).toBe(false);
    expect((await stat(join(installed, "launcher.ts"))).ino).not.toBe((await stat(join(cached, "launcher.ts"))).ino);
    await writeFile(join(installed, "launcher.ts"), "private caller edit");
    expect(await readFile(join(cached, "launcher.ts"), "utf8")).toBe('import "./missing-diagnostic.js";\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
  expect(existsSync(directory)).toBe(false);
});

test("cancelled Bun archive restoration leaves the installed package untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-sp-restore-cancel-"));
  const flow = new PreparationFlow();
  try {
    await writeFile(join(directory, "retained.txt"), "untouched");
    flow.cancel(new Error("cancel restoration"));
    await expect(preparation.restorePackedBun(flow, { archive: join(directory, "absent.tgz"), destination: directory })).rejects.toThrow("cancel restoration");
    expect(await readFile(join(directory, "retained.txt"), "utf8")).toBe("untouched");
  } finally { await rm(directory, { recursive: true, force: true }); }
  expect(existsSync(directory)).toBe(false);
});

test("preparation cancellation during filesystem work waits for main before deleting and forbids late spawning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-sp-flow-"));
  const flow = new PreparationFlow();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const running = flow.run(async () => {
    entered.resolve();
    await release.promise;
    await Bun.write(join(directory, "late-write"), "an already pending filesystem continuation");
    events.push("main continued");
    await flow.execute([process.execPath, "-e", 'throw new Error("must not spawn")'], directory);
  }, async () => { events.push("cleanup"); await rm(directory, { recursive: true, force: true }); });
  const outcome = running.then(() => undefined, (error: unknown) => error);
  try {
    await entered.promise;
    flow.cancel(new Error("cancel during I/O"));
    expect(existsSync(directory)).toBe(true);
    release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(events).toEqual(["main continued", "cleanup"]);
    expect(existsSync(directory)).toBe(false);
    expect(() => flow.execute([process.execPath, "-e", "0"], directory)).toThrow("cancel during I/O");
  } finally { release.resolve(); await running.catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

test("preparation cancellation stops an actual owned detached child before cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-sp-child-"));
  const flow = new PreparationFlow();
  const ready = join(directory, "pid");
  const running = flow.run(() => flow.execute([process.execPath, "-e", `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`], directory), () => rm(directory, { recursive: true, force: true }));
  const outcome = running.then(() => undefined, (error: unknown) => error);
  try {
    for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const pid = Number(await Bun.file(ready).text());
    flow.cancel(new Error("stop owned child"));
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(directory)).toBe(false);
  } finally { flow.cancel(new Error("stop owned child")); await running.catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

test("all teardown continues after capture and independent close failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-sp-close-"));
  const events: string[] = [];
  const hostCleanup = () => settleResources([
    () => { events.push("server"); throw new Error("server close failed"); },
    () => { events.push("mirror"); },
    async () => { events.push("scratch"); await rm(directory, { recursive: true, force: true }); },
  ]);
  try {
    await expect(settleResources([
      () => Bun.write(directory, "capture fails because this is a directory"),
      () => { events.push("browser"); throw new Error("browser close failed"); },
      hostCleanup,
    ])).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(["browser", "server", "mirror", "scratch"]);
    expect(existsSync(directory)).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function controlledProductCleanup(events: string[], pending?: string) {
  const task = (name: string) => async () => {
    events.push(name);
    if (name === pending) await new Promise(() => {});
  };
  return createProductCleanup({
    capture: task("capture"),
    captureTimeout: 10,
    closeBrowser: task("browser close"),
    stopServer: task("server stop"),
    closeMirror: task("mirror close"),
    removeScratch: task("scratch removal"),
  });
}

test("production cleanup verifies every resource after healthy close", async () => {
  const events: string[] = [];
  const resources = controlledProductCleanup(events);
  await resources.cleanup();
  expect(new Set(events)).toEqual(new Set(["capture", "browser close", "server stop", "mirror close", "scratch removal"]));
  expect(events.at(-1)).toBe("scratch removal");
  expect(resources.unverified()).toEqual([]);
});

test("deadline cleanup attempts independent resources without removing scratch behind a pending browser", async () => {
  const events: string[] = [];
  const reported: unknown[] = [];
  const resources = controlledProductCleanup(events, "browser close");
  const primary = new Error("Shell product overall deadline");
  let exits = 0;
  await exitAfterDeadline({
    primary,
    cleanup: resources.cleanup,
    unverified: resources.unverified,
    timeout: 30,
    report: error => reported.push(error),
    exit: () => { exits++; },
  });
  expect(new Set(events)).toEqual(new Set(["capture", "browser close", "server stop", "mirror close"]));
  expect(events).not.toContain("scratch removal");
  expect(reported[0]).toBe(primary);
  expect(String(reported.at(-1))).toContain("browser close");
  expect(String(reported.at(-1))).toContain("scratch removal");
  expect(exits).toBe(1);
});

test("already-active production cleanup shares attempts and still closes independent resources", async () => {
  const events: string[] = [];
  const reported: unknown[] = [];
  const resources = controlledProductCleanup(events, "browser close");
  void resources.cleanup();
  let exits = 0;
  await exitAfterDeadline({
    primary: new Error("Shell product overall deadline"),
    cleanup: resources.cleanup,
    unverified: resources.unverified,
    timeout: 30,
    report: error => reported.push(error),
    exit: () => { exits++; },
  });
  expect(events.filter(event => event === "browser close")).toHaveLength(1);
  expect(events).toContain("server stop");
  expect(events).toContain("mirror close");
  expect(events).not.toContain("scratch removal");
  expect(exits).toBe(1);
});

test("stalled capture cannot consume the cleanup grace before resource attempts", async () => {
  const events: string[] = [];
  const reported: unknown[] = [];
  const resources = controlledProductCleanup(events, "capture");
  let exits = 0;
  await exitAfterDeadline({
    primary: new Error("Shell product overall deadline"),
    cleanup: resources.cleanup,
    unverified: resources.unverified,
    timeout: 30,
    report: error => reported.push(error),
    exit: () => { exits++; },
  });
  expect(new Set(events)).toEqual(new Set(["capture", "browser close", "server stop", "mirror close", "scratch removal"]));
  expect(events.at(-1)).toBe("scratch removal");
  expect(resources.unverified()).toEqual([]);
  expect(exits).toBe(1);
});

test("overall deadline reporting preserves primary and teardown failures", async () => {
  const primary = new Error("Shell product overall deadline");
  const close = new Error("browser close failed");
  const reported: unknown[] = [];
  let exits = 0;
  await exitAfterDeadline({
    primary,
    cleanup: () => { throw close; },
    timeout: 100,
    report: error => reported.push(error),
    exit: () => { exits++; },
  });
  expect(reported).toEqual([primary, close]);
  expect(exits).toBe(1);
});

test("throwing primary reporter cannot bypass cleanup and exit", async () => {
  const primary = new Error("Shell product overall deadline");
  const reported: unknown[] = [];
  let cleanupCalls = 0;
  let exits = 0;
  await exitAfterDeadline({
    primary,
    cleanup: () => { cleanupCalls++; },
    timeout: 100,
    report: error => {
      reported.push(error);
      throw new Error("log sink failed");
    },
    exit: () => { exits++; },
  });
  expect(reported[0]).toBe(primary);
  expect(cleanupCalls).toBe(1);
  expect(exits).toBe(1);
});

test("throwing teardown reporter preserves errors and still exits", async () => {
  const primary = new Error("Shell product overall deadline");
  const close = new Error("browser close failed");
  const reported: unknown[] = [];
  let exits = 0;
  await exitAfterDeadline({
    primary,
    cleanup: () => { throw close; },
    timeout: 100,
    report: error => {
      reported.push(error);
      if (reported.length === 2) throw new Error("log sink failed");
    },
    exit: () => { exits++; },
  });
  expect(reported).toEqual([primary, close]);
  expect(exits).toBe(1);
});

test("progress names the stage and pending operation before awaiting", async () => {
  const pending = Promise.withResolvers<string>();
  const messages: string[] = [];
  const result = withProgress(
    { app: "vite-react", stage: "install-and-dev-dom", operation: "shellProduct.start" },
    () => pending.promise,
    message => messages.push(message),
  );
  expect(messages).toEqual([JSON.stringify({
    app: "vite-react",
    stage: "install-and-dev-dom",
    status: "progress",
    operation: "shellProduct.start",
  })]);
  pending.resolve("ready");
  expect(await result).toBe("ready");
});

test("Waffle staging names selected Git source and verifies borrowed network before fresh JS with rebuild forbidden", () => {
  const commit = "c1cb67c300439af24335d0b2ec481bfb52f79a01";
  const env = { WAFFLE_NETWORK_PREBUILT: "0", CARGO_TARGET_DIR: "/owned/cargo" };
  const plan = waffleSourcePlan("/read-only/repository", commit, "/owned/source.tar", "/owned/waffle", env);
  expect(plan.map(step => step.command)).toEqual([
    ["git", "-C", "/read-only/repository", "archive", "--format=tar", "--output", "/owned/source.tar", commit],
    ["tar", "-xf", "/owned/source.tar", "-C", "/owned/waffle"],
    [process.execPath, "tooling/build-network.ts", "--verify"],
    [process.execPath, "prepare.ts"],
  ]);
  expect(plan.slice(2).map(step => step.cwd)).toEqual(["/owned/waffle", "/owned/waffle"]);
  for (const step of plan) expect(step.env.WAFFLE_NETWORK_PREBUILT).toBe("1");
  expect(env.WAFFLE_NETWORK_PREBUILT).toBe("0");
  expect(networkFiles).toEqual(["network.wasm", "network.sha256", "network.input-hash"]);
  expect(() => waffleSourcePlan("/repo", "not-a-commit", "/archive", "/destination", {})).toThrow();
});

test("Waffle host source defaults to the explicit package peer and requires full commits", () => {
  const shellCommit = "a".repeat(40);
  const wafflePeerCommit = "c1cb67c300439af24335d0b2ec481bfb52f79a01";
  const waffleHostCommit = "e177e356cb9c32cac0a7baf3a85ec33849b5c409";
  const environment = { SHELL_PRODUCT_SHELL_COMMIT: shellCommit, SHELL_PRODUCT_WAFFLE_COMMIT: wafflePeerCommit };
  expect(waffleCommits(environment)).toEqual({ shellCommit, wafflePeerCommit, waffleHostCommit: wafflePeerCommit });
  expect(waffleCommits({ ...environment, SHELL_PRODUCT_WAFFLE_HOST_COMMIT: waffleHostCommit })).toEqual({ shellCommit, wafflePeerCommit, waffleHostCommit });
  for (const name of ["SHELL_PRODUCT_SHELL_COMMIT", "SHELL_PRODUCT_WAFFLE_COMMIT", "SHELL_PRODUCT_WAFFLE_HOST_COMMIT"] as const) {
    expect(() => waffleCommits({ ...environment, [name]: "main" })).toThrow(`Set full ${name}`);
  }
});

test("Retained Waffle selection checks Shell, peer, host, and network provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bw-sp-selection-"));
  const commits = {
    shellCommit: "a".repeat(40),
    wafflePeerCommit: "c1cb67c300439af24335d0b2ec481bfb52f79a01",
    waffleHostCommit: "e177e356cb9c32cac0a7baf3a85ec33849b5c409",
  };
  const networkInputHash = "b".repeat(64);
  const networkPath = join(directory, "node_modules/waffle/browser/net/network.input-hash");
  const selectionPath = join(directory, waffleSelectionFile);
  try {
    await mkdir(join(directory, "node_modules/waffle/browser/net"), { recursive: true });
    await Bun.write(networkPath, networkInputHash);
    await expect(readWaffleSelection(directory, commits)).rejects.toThrow();
    const expected = await writeWaffleSelection(directory, commits);
    expect(expected).toEqual({ ...commits, networkInputHash });
    expect(await readWaffleSelection(directory, commits)).toEqual(expected);
    expect(await Bun.file(selectionPath).json()).toEqual(expected);
    await expect(readWaffleSelection(directory, { ...commits, shellCommit: "c".repeat(40) })).rejects.toThrow("Retained Waffle selection");
    await expect(readWaffleSelection(directory, { ...commits, wafflePeerCommit: "d".repeat(40) })).rejects.toThrow("Retained Waffle selection");
    await expect(readWaffleSelection(directory, { ...commits, waffleHostCommit: "e".repeat(40) })).rejects.toThrow("Retained Waffle selection");
    await Bun.write(networkPath, "f".repeat(64));
    await expect(readWaffleSelection(directory, commits)).rejects.toThrow("Retained Waffle selection");
    await Bun.write(networkPath, networkInputHash);
    await Bun.write(selectionPath, JSON.stringify({ ...expected, waffleHostCommit: "main" }));
    await expect(readWaffleSelection(directory, commits)).rejects.toThrow("Set full retained waffleHostCommit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("strict independent guest provenance rejects duplicate, commented digest, wrong bytes and invalid source", () => {
  const sha256 = "a".repeat(64);
  const receipt = `source_commit=${"b".repeat(40)}\nsource_tree=${"c".repeat(40)}\nguest_sha256=${sha256}\nguest_bytes=8\ndate=fixture\nfeatures=browser\ntarget=wasm32-wasip1\n`;
  expect(guestProvenance(receipt, { sha256, bytes: 8 }).source_commit).toBe("b".repeat(40));
  expect(() => guestProvenance(`${receipt}guest_sha256=${sha256}\n`, { sha256, bytes: 8 })).toThrow("Duplicate");
  expect(() => guestProvenance(receipt.replace(sha256, "d".repeat(64)) + `#guest_sha256=${sha256}\n`, { sha256, bytes: 8 })).toThrow("does not match");
  expect(() => guestProvenance(receipt, { sha256, bytes: 9 })).toThrow("does not match");
  expect(() => guestProvenance(receipt.replace("b".repeat(40), "invalid"), { sha256, bytes: 8 })).toThrow("Invalid guest source");
});


test("guest projects configure the replay in bunfig.toml as the real installer consumes it", () => {
  const registry = "http://127.0.0.1:43831";
  for (const fixture of fixtures) {
    const files = projectFiles(fixture, registry);
    expect(Bun.TOML.parse(files["bunfig.toml"])).toEqual({ install: { registry } });
    expect(JSON.parse(files["package.json"])).toMatchObject({ dependencies: fixture.dependencies, scripts: fixture.scripts });
    expect(Object.hasOwn(files, ".npmrc")).toBe(false);
    for (const [path, source] of Object.entries(fixture.files)) expect(files[path]).toBe(source);
  }
});
