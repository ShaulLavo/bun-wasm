import { Scope, type Admission } from "./scope";
import { withScoped } from "./scope-fixture";
import { test, expect, spyOn, setDefaultTimeout } from "bun:test";
import { IphoneBus } from "./iphone-bus";
import { createIphoneTransport, nativeButtonRef, validateIphoneControl } from "./iphone-transport";
import { checkClick } from "./playground";
import { withPlayground } from "./test-fixture";
import { frameworks } from "./catalog";
import { closeIphoneTab } from "./iphone-cleanup";
import { cleanupGroups, tabAgentScript } from "./iphone-tab-fixture";
import { ownedCommand } from "./lifetime";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "./execute";
import { object } from "./evidence";
import type { Transport } from "./transport";

// Some tests here take seconds on a busy machine. The limit only catches a hang.
setDefaultTimeout(120_000);

test("visible iPhone options reject SafariDriver-shaped or non-loopback controls", () => {
  validateIphoneControl("http://127.0.0.1:1234/__goals_iphone/" + "a".repeat(64), "/bound/agent-device");
  expect(() => validateIphoneControl("http://remote:1234/session", "/bound/agent-device")).toThrow();
  expect(() => validateIphoneControl("http://127.0.0.1:1234/__goals_iphone/" + "a".repeat(64), "agent-device")).toThrow();
  expect(nativeButtonRef('@e1 [button] "Count 0"\n@e2 [button] "Other"', "Count 0")).toBe("@e1");
  expect(() => nativeButtonRef('@e1 [button] "Count 0"\n@e2 [button] "Count 0"', "Count 0")).toThrow("found 2");
});

test("native click hook bypasses the script click without changing other transports", async () => {
  const framework = frameworks[0]!;
  await withPlayground(framework, 0, async transport => {
    let native = 0;
    transport.nativeClick = async () => { native++; return { before: "0", after: "1", trusted: true }; };
    expect(await withScoped(transport, page => checkClick(page, framework, 90000))).toEqual({ before: "0", after: "1", trusted: true });
    expect(native).toBe(1);
    delete transport.nativeClick;
    expect(await withScoped(transport, page => checkClick(page, framework, 90000))).toEqual({ before: "count 0", after: "count 1" });
  });
});

test("bus rejects wrong documents, stale replies and expired commands", async () => {
  const bus = new IphoneBus("/test");
  bus.configure("host", "http://127.0.0.1:1234/");
  const state = bus.state("host")!;
  const key = { nonce: state.nonce, url: state.url, timeOrigin: 1, visible: true };
  expect(() => bus.poll("host", { ...key, nonce: "wrong" }, "http://127.0.0.1:1234")).toThrow();
  bus.poll("host", key, "http://127.0.0.1:1234");
  const pending = bus.execute("host", "1", 20, false, Date.now() + 20);
  const rejected = expect(pending).rejects.toThrow("expired");
  await rejected;
  expect(() => bus.reply("host", { ...key, id: 1, ok: true, value: 1 }, "http://127.0.0.1:1234")).toThrow("Late");
  expect(() => bus.poll("host", { ...key, timeOrigin: 2 }, "http://127.0.0.1:1234")).toThrow("replaced");
  bus.close();
});

test("native cleanup shares one deadline, cancels its child and never dispatches a later input", async () => {
  const started: { args: string[]; at: number; timeoutMs: number }[] = [];
  let active = 0;
  const deadline = Date.now() + 200;
  await expect(closeIphoneTab(async (args, timeoutMs, signal) => {
    expect(active).toBe(0);
    active++;
    started.push({ args, at: Date.now(), timeoutMs });
    try {
      const delay = started.length === 1 ? 10 : 500;
      return await ownedCommand([process.execPath, "-e", `await Bun.sleep(${delay}); console.log('done')`], signal, timeoutMs);
    } finally { active--; }
  }, "owned tab", deadline)).rejects.toThrow();
  const count = started.length;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(2);
  expect(active).toBe(0);
  expect(started.every(item => item.at < deadline && item.timeoutMs <= deadline - item.at + 1)).toBe(true);
  await Bun.sleep(250);
  expect(started.length).toBe(count);
});

test("transport close is cached and reaps its timed-out native command before any further input", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-close-"));
  const path = "/__goals_iphone/" + "c".repeat(64);
  const log = join(root, "commands.jsonl");
  const agent = join(root, "agent-device");
  await writeFile(agent, tabAgentScript({ closed: join(root, "closed"), title: "Goals own-tab", unrelated: "owner tab", log, hangOnCleanup: true }));
  await chmod(agent, 0o755);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return Response.json(new URL(request.url).pathname.endsWith("/configure") ? "http://127.0.0.1:1234/" : { nonce: "own-tab", timeOrigin: 1, visible: true, userAgent: "iPhone Safari" });
  } });
  const transport = await createIphoneTransport({ control: server.url.origin + path, agent, deviceUDID: "fixture", timeoutMs: 90000 });
  try {
    await withScoped(transport, page => page.navigate("http://127.0.0.1:1234/"));
    const closing = transport.close(true, 150);
    expect(transport.close(true, 150)).toBe(closing);
    await expect(closing).rejects.toThrow("T3 device command failed");
    const rows = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.args[0])).toEqual(["open", "batch", "batch", "open", "open"]);
    expect(() => process.kill(rows[4].pid, 0)).toThrow();
    await Bun.sleep(200);
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(5);
  } finally { await transport.close(true, 150).catch(() => {}); await server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("native cleanup rejects a successful input receipt when the owned tab is still visible", async () => {
  const control = cleanupGroups("ordinary", { ignoreClose: true });
  await expect(closeIphoneTab(control.command, "Goals owned", Date.now() + 1000)).rejects.toThrow("unproved");
  expect(control.cards.ordinary).toContain("Goals owned");
  expect(control.selected()).toBe("ordinary");
  expect(control.inOverview()).toBe(false);
});

test("native tab cleanup settles transitions before using and verifying snapshot refs", async () => {
  const control = cleanupGroups("ordinary");
  let presses = 0;
  await closeIphoneTab(async args => {
    if (args[0] !== "batch") return control.command(args);
    const steps: unknown = JSON.parse(args[2]!);
    if (!Array.isArray(steps)) throw new Error("Expected cleanup batch");
    for (const row of steps.map(object)) {
      if (row.command !== "press") continue;
      expect(object(row.input).settle).toBe(true);
      presses++;
    }
    return control.command(args);
  }, "Goals owned", Date.now() + 10_000);
  expect(presses).toBeGreaterThan(0);
  expect(control.closed).toEqual(["Goals owned"]);
  expect(control.selected()).toBe("ordinary");
  expect(control.inOverview()).toBe(false);
});

test.each(["configure-failed", "cancelled", "missing-identity"])("%s navigation still owns bounded ordinary finalization", async scenario => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-iphone-finalize-"));
  const agent = join(root, "agent-device"), log = join(root, "commands.jsonl"), closed = join(root, "closed");
  const scope = Scope.open(10_000);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/configure")) return Response.json({ timeOrigin: 1, visible: true, userAgent: "iPhone Safari" });
    if (scenario === "cancelled") scope.close(new Error("Navigation cancelled after setup"));
    return Response.json(scenario === "missing-identity" ? "http://fixture/task" : {}, { status: scenario === "configure-failed" ? 500 : 200 });
  } });
  let transport: Transport | undefined;
  try {
    await writeFile(agent, tabAgentScript({ closed, title: "Goals owned", unrelated: "Unrelated ordinary", log }));
    await chmod(agent, 0o700);
    transport = await createIphoneTransport({ control: server.url.origin + "/__goals_iphone/" + "a".repeat(64), agent, deviceUDID: "fixture", timeoutMs: 1000 });
    await expect(transport.navigate("http://fixture/task", scope)).rejects.toThrow();
    const before = (await readFile(log, "utf8")).trim().split("\n").length;
    if (scenario === "missing-identity") await expect(transport.close(false, 5000)).rejects.toThrow("Missing task Safari tab identity");
    else await transport.close(false, 5000);
    const final = (await readFile(log, "utf8")).trim().split("\n").slice(before).map(line => JSON.parse(line).args);
    expect(final[0]).toEqual(["open", "com.apple.mobilesafari"]);
    expect(final.at(-1)[2]).toContain('"ref":"@e100"');
    expect(JSON.stringify(final)).not.toContain('"ref":"@e2"');
    await expect(readFile(closed)).rejects.toThrow();
  } finally {
    scope.close();
    await transport?.close(false, 5000).catch(() => {});
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("an outstanding install observation cannot block confirmed native tab cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-pending-cleanup-"));
  const agent = join(root, "agent-device");
  const closed = join(root, "closed");
  const log = join(root, "commands.jsonl");
  await writeFile(agent, tabAgentScript({ closed, title: "Goals own-tab", unrelated: "owner tab", log }));
  await chmod(agent, 0o755);
  try { await pendingCleanupControl(agent, log, closed); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("successful native-owned cleanup preserves the final terminal log", async () => {
  const { result, closed, logs } = await nativeLifecycle("normal");
  expect(result.status).toBe("pass");
  expect(closed).toBe(true);
  expect(logs).toEqual(["\n\nBrowser core trap memory snapshots unavailable: diagnostic hook is unavailable.\n"]);
});

test("owned cleanup uses the remaining campaign admission after handoff and logging", async () => {
  const { result, budgets, settled } = await cleanupDeadlineControl("elapsed");
  expect(budgets).toEqual([58_500]);
  expect(settled).toBe(true);
  expect(result.status).toBe("pass");
  expect(result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass", timeoutMs: 60_000,
    evidence: { browserClosed: true, foregroundStopped: true, previewClosed: true } });
});

test.each(["expired", "cancelled"] as const)("%s cleanup admission dispatches no owned close", async scenario => {
  const { result, budgets } = await cleanupDeadlineControl(scenario);
  expect(budgets).toEqual([]);
  expect(result).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining(scenario === "expired" ? "Phase timed out after 60000 ms" : "cleanup cancelled") });
});

test.each(["late-success", "late-error"] as const)("owned cleanup consumes %s but never passes after expiry", async scenario => {
  const { result, budgets, settled } = await cleanupDeadlineControl(scenario);
  expect(budgets).toEqual([58_500]);
  expect(settled).toBe(true);
  expect(result).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining("Phase timed out after 60000 ms") });
});

async function cleanupDeadlineControl(scenario: "elapsed" | "expired" | "cancelled" | "late-success" | "late-error") {
  const framework = frameworks[0]!;
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const open = Scope.open;
  let cleanupScope: Scope | undefined;
  const scopes = spyOn(Scope, "open").mockImplementation((timeoutMs, parent) => {
    const scope = open(timeoutMs, parent);
    if (timeoutMs === 60_000 && !parent) cleanupScope = scope;
    return scope;
  });
  const budgets: number[] = [];
  let settled = false;
  function runCleanup(transport: Transport) {
    Object.assign(transport.capabilities, { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": "fixture" });
    transport.beginCleanup = () => { now += 1200; };
    transport.cleanup = async timeoutMs => {
      budgets.push(timeoutMs);
      now += scenario.startsWith("late-") ? 58_501 : 13_196;
      settled = true;
      if (scenario === "late-error") throw new Error("late close rejection is consumed");
      if (timeoutMs < 13_196) throw new Error("owned close budget exhausted");
      return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    };
    return execute({ box: { framework: framework.id, browser: "iphone-safari", engine: "browser" }, framework,
      url: "http://fixture/?engine=browser", timeoutMs: 1000, createTransport: async () => transport,
      saveLog: async () => {
        now += 300;
        if (scenario === "expired" && cleanupScope) now = cleanupScope.deadline;
        if (scenario === "cancelled") cleanupScope?.close(new Error("cleanup cancelled"));
      },
    });
  }
  try {
    const result = await withPlayground(framework, 0, runCleanup);
    return { result, budgets, settled };
  } finally { scopes.mockRestore(); clock.mockRestore(); }
}

test("a stalled final terminal read saves the completed transcript and still closes the native page", async () => {
  const { result, closed, logs } = await nativeLifecycle("stalled-terminal");
  expect(result.status).toBe("pass");
  expect(closed).toBe(true);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("Final terminal observation unavailable");
  expect(logs[0]).toContain("saved build transcript");
});

test("an optional terminal log write failure cannot fail successful native resource teardown", async () => {
  const { result, closed } = await nativeLifecycle("write-failure");
  expect(result.status).toBe("pass");
  expect(closed).toBe(true);
});

test("a failed final observation preserves the already captured failure diagnostic", async () => {
  const { result, closed, logs } = await nativeLifecycle("failed-install");
  expect(result).toMatchObject({ status: "fail", phase: "install", error: expect.stringContaining("bun install exited 17: Error: detailed install diagnostic") });
  expect(logs).toEqual(["--- Failure-time terminal observation ---\nError: detailed install diagnostic\n\nBrowser core trap memory snapshots unavailable: diagnostic hook is unavailable.\n\n--- End failure-time terminal observation ---\n"]);
  expect(closed).toBe(true);
});

test("a never-settling failure log write is bounded before native teardown", async () => {
  const { result, closed } = await nativeLifecycle("stalled-failure-log");
  expect(result).toMatchObject({ status: "fail", phase: "install", error: expect.stringContaining("bun install exited 17: Error: detailed install diagnostic") });
  expect(closed).toBe(true);
}, 8000);

test("empty successful failure capture stays observed when optional Browser facts expire", async () => {
  const { result, closed, logs } = await nativeLifecycle("empty-capture");
  expect(result).toMatchObject({ status: "fail", phase: "install", error: "Error: bun install exited 17: " });
  expect(closed).toBe(true);
  const diagnostic = "\n\nBrowser core trap memory snapshots unavailable within the failure observation budget.\n";
  const failure = `--- Failure-time terminal observation ---\n${diagnostic}\n--- End failure-time terminal observation ---\n`;
  expect(logs).toEqual([failure, `${failure}\n--- Cleanup-time terminal observation (before owned transport cleanup) ---\n${diagnostic}\n--- End cleanup-time terminal observation ---\n`]);
}, 8000);

test("empty final terminal stays observed when optional Browser facts expire", async () => {
  const { result, closed, logs } = await nativeLifecycle("empty-final");
  expect(result.status).toBe("pass");
  expect(closed).toBe(true);
  expect(logs).toEqual(["\n\nBrowser core trap memory snapshots unavailable within the final observation budget.\n"]);
}, 8000);

type NativeScenario = "normal" | "stalled-terminal" | "write-failure" | "failed-install" | "stalled-failure-log" | "empty-capture" | "empty-final";
async function nativeLifecycle(scenario: NativeScenario) {
  const framework = frameworks[0]!;
  return withPlayground(framework, 0, async transport => {
    Object.assign(transport.capabilities, { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": "fixture" });
    transport.evaluate = lifecycleObservation(transport.evaluate, scenario);
    const logs: string[] = [];
    let closed = false;
    transport.cleanup = async () => { closed = true; return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
    const result = await execute({ box: { framework: framework.id, browser: "iphone-safari", engine: "browser" }, framework,
      url: "http://fixture/?engine=browser", timeoutMs: 1000, createTransport: async () => transport, saveLog: lifecycleLog(logs, scenario),
    });
    return { result, closed, logs };
  });
}

function lifecycleObservation(evaluate: Transport["evaluate"], scenario: NativeScenario): Transport["evaluate"] {
  let reads = 0;
  const failedInstall = scenario === "failed-install" || scenario === "stalled-failure-log" || scenario === "empty-capture";
  return <T>(source: string, admission: Admission, options?: Parameters<Transport["evaluate"]>[2]) => {
    if ((scenario === "empty-capture" || scenario === "empty-final") && source.includes("function browserTrapFacts")) return new Promise<T>(() => {});
    if (failedInstall && source.includes("function shellState")) return evaluate<T>(`(${JSON.stringify({ done: true, code: 17, error: null })})`, admission, options);
    if (!source.includes("function transcript")) return evaluate<T>(source, admission, options);
    reads++;
    if (scenario === "empty-capture" || scenario === "empty-final") return evaluate<T>('""', admission, options);
    if (scenario === "stalled-terminal" && reads === 3) return new Promise<T>(() => {});
    if (scenario === "failed-install" && reads === 3) return Promise.reject(new Error("final observation failed"));
    if (failedInstall) return evaluate<T>(JSON.stringify("Error: detailed install diagnostic"), admission, options);
    return scenario === "stalled-terminal" ? evaluate<T>(JSON.stringify("saved build transcript"), admission, options) : evaluate<T>(source, admission, options);
  };
}

function lifecycleLog(logs: string[], scenario: NativeScenario): ExecutionLog {
  return async text => {
    if (scenario === "write-failure") throw new Error("log write failed");
    if (scenario === "stalled-failure-log") return new Promise<void>(() => {});
    logs.push(text);
  };
}
type ExecutionLog = Parameters<typeof execute>[0]["saveLog"];

async function pendingCleanupControl(agent: string, log: string, closed: string): Promise<void> {
  const framework = frameworks[0]!;
  await withPlayground(framework, 0, async fixture => {
    const release = Promise.withResolvers<void>();
    const state = { pending: false, scriptedCleanup: 0, released: release.promise, evaluate: (source: string) => withScoped(fixture, page => page.evaluate(source)) };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: request => pendingObserver(request, state) });
    const transport = await createIphoneTransport({ control: server.url.origin + "/__goals_iphone/" + "d".repeat(64), agent, deviceUDID: "fixture", timeoutMs: 1000 });
    const logs: string[] = [];
    try {
      const result = await execute({ box: { framework: framework.id, browser: "iphone-safari", engine: "browser" }, framework,
        url: "http://fixture/?engine=browser", timeoutMs: 1000, installTimeoutMs: 80,
        createTransport: async () => transport, saveLog: async text => { logs.push(text); },
      });
      expect(result).toMatchObject({ status: "fail", phase: "install" });
      expect(result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass", evidence: { browserClosed: true, foregroundStopped: true, previewClosed: true } });
      expect(state.pending).toBe(true);
      expect(state.scriptedCleanup).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Final terminal observation unavailable");
      expect(await readFile(closed, "utf8")).toBe("closed");
      const commands = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(commands.map(row => row.args[0])).toEqual(["open", "batch", "batch", "open", "open", "batch", "batch", "batch", "batch", "batch"]);
    } finally { release.resolve(); await transport.close(true).catch(() => {}); await server.stop(true); }
  });
}

async function pendingObserver(request: Request, state: { pending: boolean; scriptedCleanup: number; released: Promise<void>; evaluate(source: string): Promise<unknown> }): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/configure")) return Response.json("http://127.0.0.1:1234/");
  if (path.endsWith("/state")) return Response.json({ nonce: "own-tab", timeOrigin: 1, visible: true, userAgent: "iPhone Safari" });
  const row = object(await request.json());
  if (typeof row.source !== "string") throw new Error("Missing test expression");
  if (row.source.includes("presentIphonePreview")) state.scriptedCleanup++;
  if (state.pending) return Response.json({ error: "iPhone observer command already pending" }, { status: 400 });
  if (row.source.includes("function shellState")) { state.pending = true; await state.released; }
  return Response.json({ settled: true, ok: true, value: await state.evaluate(row.source) });
}
