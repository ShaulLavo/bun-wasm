import { test, expect } from "bun:test";
import { IphoneBus } from "./iphone-bus";
import { createIphoneTransport, nativeButtonRef, validateIphoneControl } from "./iphone-transport";
import { checkClick } from "./playground";
import { withPlayground } from "./test-fixture";
import { frameworks } from "./catalog";
import { closeIphoneTab } from "./iphone-cleanup";
import { ownedCommand } from "./lifetime";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "./execute";
import { object } from "./evidence";
import type { Transport } from "./transport";

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
    expect(await checkClick(transport, framework, 90000)).toEqual({ before: "0", after: "1", trusted: true });
    expect(native).toBe(1);
    delete transport.nativeClick;
    expect(await checkClick(transport, framework, 90000)).toEqual({ before: "count 0", after: "count 1" });
  });
});

test("bus rejects wrong documents, stale replies and expired commands", async () => {
  const bus = new IphoneBus("/test");
  bus.configure("host", "http://127.0.0.1:1234/");
  const state = bus.state("host")!;
  const key = { nonce: state.nonce, url: state.url, timeOrigin: 1, visible: true };
  expect(() => bus.poll("host", { ...key, nonce: "wrong" }, "http://127.0.0.1:1234")).toThrow();
  bus.poll("host", key, "http://127.0.0.1:1234");
  const pending = bus.execute("host", "1", 20);
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
  await writeFile(agent, `#!${process.execPath}\nimport {appendFile} from 'node:fs/promises';\nawait appendFile(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\\n');\nif(process.argv[2]==='press')await Bun.sleep(2000);\n`);
  await chmod(agent, 0o755);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return Response.json(new URL(request.url).pathname.endsWith("/configure") ? "http://127.0.0.1:1234/" : { nonce: "own-tab", timeOrigin: 1, visible: true, userAgent: "iPhone Safari" });
  } });
  const transport = await createIphoneTransport({ control: server.url.origin + path, agent, deviceUDID: "fixture", timeoutMs: 90000 });
  try {
    await transport.navigate("http://127.0.0.1:1234/");
    const started = Date.now();
    const closing = transport.close(true, 150);
    expect(transport.close(true, 150)).toBe(closing);
    await expect(closing).rejects.toThrow("T3 device command failed");
    expect(Date.now() - started).toBeLessThan(1000);
    const rows = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.args[0])).toEqual(["open", "press"]);
    expect(() => process.kill(rows[1].pid, 0)).toThrow();
    await Bun.sleep(200);
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally { await transport.close(true, 150).catch(() => {}); await server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("native cleanup rejects a successful input receipt when the owned tab is still visible", async () => {
  const snapshot = '@e1 [button] "owned tab"\n@e2 [button] "Close"';
  const commands: string[][] = [];
  await expect(closeIphoneTab(async args => {
    commands.push(args);
    return args[0] === "snapshot" ? snapshot : "Tapped";
  }, "owned tab", Date.now() + 1000)).rejects.toThrow("still present");
  expect(commands.filter(args => args[0] === "snapshot")).toHaveLength(2);
});

test("an outstanding install observation cannot block confirmed native tab cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-pending-cleanup-"));
  const agent = join(root, "agent-device");
  const closed = join(root, "closed");
  const log = join(root, "commands.jsonl");
  const snapshot = '@e1 [button] "Goals own-tab"\n@e2 [button] "Close"\n@e3 [button] "owner tab"';
  await writeFile(agent, `#!${process.execPath}\nimport{appendFile,writeFile}from'node:fs/promises';import{existsSync}from'node:fs';\nconst args=process.argv.slice(2);await appendFile(${JSON.stringify(log)},JSON.stringify(args)+'\\n');\nif(args[0]==='press'&&args[1]==='@e2')await writeFile(${JSON.stringify(closed)},'closed');\nif(args[0]==='snapshot')console.log(existsSync(${JSON.stringify(closed)})?'@e3 [button] "owner tab"':${JSON.stringify(snapshot)});\n`);
  await chmod(agent, 0o755);
  try { await pendingCleanupControl(agent, log, closed); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("successful native-owned cleanup preserves the final terminal log", async () => {
  const { result, closed, logs } = await nativeLifecycle("normal");
  expect(result.status).toBe("pass");
  expect(closed).toBe(true);
  expect(logs).toEqual([""]);
});

test("a stalled final terminal read saves the completed transcript and still closes the native page", async () => {
  const { result, closed, logs } = await nativeLifecycle("stalled-terminal");
  expect(result.status).toBe("pass");
  expect(closed).toBe(true);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("Final terminal observation unavailable");
  expect(logs[0]).toContain("saved build transcript");
});

test("a terminal log write failure cannot skip native resource teardown", async () => {
  const { result, closed } = await nativeLifecycle("write-failure");
  expect(result).toMatchObject({ status: "fail", phase: "cleanup", error: expect.stringContaining("log write failed") });
  expect(closed).toBe(true);
});

test("a failed final observation preserves the already captured failure diagnostic", async () => {
  const { result, closed, logs } = await nativeLifecycle("failed-install");
  expect(result).toMatchObject({ status: "fail", phase: "install" });
  expect(logs).toEqual(["Error: detailed install diagnostic"]);
  expect(closed).toBe(true);
});

test("a never-settling failure log write is bounded before native teardown", async () => {
  const { result, closed } = await nativeLifecycle("stalled-failure-log");
  expect(result).toMatchObject({ status: "fail", phase: "install" });
  expect(closed).toBe(true);
}, 8000);

type NativeScenario = "normal" | "stalled-terminal" | "write-failure" | "failed-install" | "stalled-failure-log";
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
  const failedInstall = scenario === "failed-install" || scenario === "stalled-failure-log";
  return <T>(source: string) => {
    if (failedInstall && source.includes("function shellState")) return evaluate<T>(JSON.stringify({ done: true, code: 17, error: null }));
    if (!source.includes("function transcript")) return evaluate<T>(source);
    reads++;
    if (scenario === "stalled-terminal" && reads === 3) return new Promise<T>(() => {});
    if (scenario === "failed-install" && reads === 2) return Promise.reject(new Error("final observation failed"));
    if (failedInstall) return evaluate<T>(JSON.stringify("Error: detailed install diagnostic"));
    return scenario === "stalled-terminal" ? evaluate<T>(JSON.stringify("saved build transcript")) : evaluate<T>(source);
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
    const state = { pending: false, scriptedCleanup: 0, released: release.promise, evaluate: fixture.evaluate };
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
      expect(commands.at(-1)).toEqual(["snapshot", "-i"]);
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
  return Response.json(await state.evaluate(row.source));
}
