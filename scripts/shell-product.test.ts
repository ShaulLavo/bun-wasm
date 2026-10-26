import { expect, test } from "bun:test";
import { viteApps } from "./app-matrix/product-vite";
import { nextApps } from "./app-matrix/product-next";
import { fixtures, stages } from "../tests/shell-product/fixtures";
import { projectFiles } from "../tests/shell-product/project";
// These unit fixtures do not launch the product browser or stage its packages.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guestProvenance } from "./app-matrix/product-provenance";
import { createProductCleanup, exitAfterDeadline, foregroundCycle, liveServer, requireLiveServer, settleResources, withProgress, type Pending } from "../tests/shell-product/lifecycle";
import { PreparationFlow } from "../tests/shell-product/prepare-flow";
import { networkFiles, readWaffleSelection, waffleCommits, waffleSelectionFile, waffleSourcePlan, writeWaffleSelection } from "../tests/shell-product/waffle-stage";

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
