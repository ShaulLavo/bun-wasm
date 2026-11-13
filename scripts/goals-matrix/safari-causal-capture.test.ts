import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameworks } from "./catalog";
import { execute } from "./execute";
import { nativeRunnerArgs, requireCaptureSettled } from "./fleet";
import { options } from "./run";
import { withAdmission, withScoped } from "./scope-fixture";
import { createSafariTransport } from "./safari-transport";
import type { SafariOwnershipSink } from "./safari-ownership";
import type { SafariProtocolFact } from "./safari-protocol";
import { settlementFile, withSafariCausalCapture, type SafariCausalCapture } from "./safari-causal-capture";
import { launchdPredicate, normalizeLaunchdLog, webContentService, type ControlReceipt, type NativePort, type NativeQuery, type ProcessClock } from "./safari-causal-native";
import type { Transport } from "./transport";
import { withPlayground } from "./test-fixture";

const servers: { stop(force: boolean): Promise<void> }[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function logs(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-causal-"));
  directories.push(directory);
  return directory;
}

// A WebDriver endpoint whose evaluation and session replies are chosen per test.
function driver(evaluate: (index: number) => Response, remove: () => Response = () => Response.json({ value: null })): string {
  let evaluations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/session") return Response.json({ value: { sessionId: "owned", capabilities: { browserName: "Safari", platformName: "macOS" } } });
    if (path === "/session/owned" && request.method === "DELETE") return remove();
    if (path === "/session/owned/window") return Response.json({ value: "host" });
    if (path.endsWith("/execute/async")) return evaluate(evaluations++);
    return Response.json({ value: null });
  } });
  servers.push(server);
  return server.url.href;
}
const invalidSession = () => Response.json({ value: { error: "invalid session id", message: "private detail" } }, { status: 404 });

async function observed(evaluate: (index: number) => Response, expressions: number, remove?: () => Response) {
  const facts: SafariProtocolFact[] = [];
  const transport = await createSafariTransport({ endpoint: driver(evaluate, remove), browser: "safari", timeoutMs: 1000, protocolSink: fact => { facts.push(fact); } });
  const errors: string[] = [];
  for (let index = 0; index < expressions; index++) {
    await withScoped(transport, page => page.evaluate("1")).catch(error => { errors.push(String(error)); });
  }
  const closed = await transport.close().then(() => "deleted", error => String(error));
  return { facts, errors, closed };
}

test("HTTP 200 with a null evaluation value and the following 404 are separate correlated facts with original errors", async () => {
  const { facts, errors, closed } = await observed(index => index === 0 ? Response.json({ value: null }) : invalidSession(), 2, invalidSession);
  expect(errors[0]).toContain("Invalid Safari WebDriver object");
  expect(errors[1]).toContain("(404)");
  expect(closed).toContain("invalid session id");
  expect(facts.map(fact => [fact.request, fact.lane, fact.command, fact.status, fact.value, fact.result])).toEqual([
    [1, "command", "session-create", 200, "object", { kind: "valid" }],
    [2, "command", "timeouts", 200, "null", { kind: "valid" }],
    [3, "command", "window-handle", 200, "string", { kind: "valid" }],
    [4, "command", "execute-async", 200, "null", { kind: "contract-failure" }],
    [5, "command", "execute-async", 404, "object", { kind: "http-error", error: "invalid session id" }],
    [6, "session", "session-delete", 404, "object", { kind: "http-error", error: "invalid session id" }],
  ]);
  expect(JSON.stringify(facts)).not.toContain("private detail");
  expect(facts[3]?.media).toBe("json");
});

test("a guest evaluation error is a valid reply, while undecodable and unknown-error replies are classified", async () => {
  const replies = [
    () => Response.json({ value: { ok: false, message: "guest threw" } }),
    () => new Response("not json"),
    () => Response.json({ value: { error: "brand new code", message: "x" } }),
    () => Response.json({ value: { ok: true } }),
  ];
  const { facts, errors } = await observed(index => replies[index]!(), replies.length);
  expect(errors[0]).toContain("Safari evaluation failed: guest threw");
  expect(errors[3]).toContain("returned no JSON value");
  expect(facts.filter(fact => fact.command === "execute-async").map(fact => fact.result)).toEqual([
    { kind: "valid" }, { kind: "json-decode-failure" }, { kind: "webdriver-error", error: "other" }, { kind: "contract-failure" },
  ]);
});

test("cleanup commands and session deletion are observed, and a throwing sink changes no outcome", async () => {
  const facts: SafariProtocolFact[] = [];
  const transport = await createSafariTransport({ endpoint: driver(() => Response.json({ value: { ok: true, json: "42" } })), browser: "safari", timeoutMs: 1000,
    protocolSink: fact => { facts.push(fact); throw new Error("sink failed"); } });
  expect(await withScoped(transport, page => page.evaluate<number>("42"))).toBe(42);
  await withAdmission(async admission => { await transport.beginCleanup?.(admission); });
  await transport.close();
  expect(facts.slice(-2).map(fact => [fact.lane, fact.command, fact.result.kind])).toEqual([["cleanup-command", "timeouts", "valid"], ["session", "session-delete", "valid"]]);
});

test("embedded evaluation JSON is decoded before its correlated fact is emitted", async () => {
  const { facts, errors } = await observed(() => Response.json({ value: { ok: true, json: "not JSON" } }), 1, invalidSession);
  expect(errors[0]).toContain("SyntaxError");
  expect(facts.find(fact => fact.command === "execute-async")?.result).toEqual({ kind: "contract-failure" });
});

test("malformed startup contracts are correlated and a created session is still deleted", async () => {
  for (const malformed of ["session", "capabilities", "host"]) {
    const facts: SafariProtocolFact[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/session") return Response.json({ value: malformed === "session" ? null : { sessionId: "owned", capabilities: malformed === "capabilities" ? null : { browserName: "Safari", platformName: "macOS" } } });
      return Response.json({ value: null });
    } });
    servers.push(server);
    await expect(createSafariTransport({ endpoint: server.url.href, browser: "safari", timeoutMs: 1000, protocolSink: fact => { facts.push(fact); } })).rejects.toThrow();
    expect(facts.find(fact => fact.command === (malformed === "host" ? "window-handle" : "session-create"))?.result.kind).toBe("contract-failure");
    expect(facts.some(fact => fact.command === "session-delete")).toBe(malformed !== "session");
  }
});

type FakeNative = NativePort & { births: Map<number, string>; cpu: Map<number, number>; reads: number[] };
function fakeNative(control: Partial<ControlReceipt>, query: () => Promise<NativeQuery> = async () => ({ events: [], ignored: 0 })): FakeNative {
  const births = new Map([[101, "7"], [202, "9"]]);
  const cpu = new Map([[101, 0], [202, 0]]);
  const reads: number[] = [];
  return { births, cpu, reads,
    read(pid): ProcessClock | null { reads.push(pid); const birth = births.get(pid); return birth ? { cpuMs: cpu.get(pid) ?? 0, birth, footprintBytes: 4096 } : null; },
    async candidates() { return [101, 202]; },
    async control() { return { passed: true, failure: null, label: "control", pid: 5, readErrno: null, cpuRatio: 1, birthStable: true, exitObserved: true, killerPid: 6, event: null,
      classes: ["signal-service"], jobRemoved: true, fileRemoved: true, startedAt: "", finishedAt: "", ...control }; },
    query: () => query(),
  };
}
// The page spin is real; the fake charges its duration to PID 101 only.
function busyPage(transport: Transport, native: FakeNative): Transport {
  const evaluate = transport.evaluate.bind(transport);
  transport.evaluate = async <T>(expression: string, admission: Parameters<Transport["evaluate"]>[1], ...rest: Parameters<Transport["evaluate"]>[2][]) => {
    const started = performance.now();
    const value = await evaluate<T>(expression, admission, ...rest);
    if (expression.includes("performance.now() +")) native.cpu.set(101, (native.cpu.get(101) ?? 0) + performance.now() - started);
    return value;
  };
  return transport;
}
const acknowledged = (capture: SafariCausalCapture) => {
  const sink: SafariOwnershipSink = capture.ownership(undefined);
  const base = { sequence: 1, event: 1, at: "", sessionId: null, hostHandle: null, admission: "active" as const };
  sink({ ...base, operation: { kind: "session-create" }, outcome: { state: "acknowledged", observation: { kind: "session", sessionId: "owned" } } });
  sink({ ...base, operation: { kind: "host-handle" }, outcome: { state: "acknowledged", observation: { kind: "host", handle: "host" } } });
};
const nuxt = frameworks.find(item => item.id === "nuxt")!;
async function capturedRun(native: FakeNative, directory: string, prepare: (capture: SafariCausalCapture) => void = acknowledged) {
  const identity = { run: "run", source: { commit: "c", dirty: false }, cell: "nuxt/safari/browser", attempt: 1 };
  return withPlayground(nuxt, 0, transport => withSafariCausalCapture({ logs: directory, identity, native, windowMs: 40, pollMs: 5 }, capture => {
    prepare(capture);
    // The fixture page reports Chrome capabilities; the capture itself does not depend on the box label.
    return execute({ framework: nuxt, box: { framework: "nuxt", browser: "chrome", engine: "browser" }, url: "http://fixture/?engine=browser", timeoutMs: 2000,
      observeStartup: capture.arm, async createTransport() { return busyPage(transport, native); }, async saveLog() {} });
  }));
}
async function settlement(directory: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(join(directory, settlementFile), "utf8")); }

test("a failed native control blocks install, keeps normal cleanup and settles the capture", async () => {
  const directory = await logs();
  const result = await capturedRun(fakeNative({ passed: false, failure: "no launchd record" }), directory);
  const phases = result.attempts[0]?.phases ?? [];
  expect(phases.map(phase => [phase.phase, phase.status])).toEqual([["startup", "fail"], ["cleanup", "pass"]]);
  expect(result).toMatchObject({ status: "fail", error: expect.stringContaining("not armed: native control failed: no launchd record") });
  expect(await settlement(directory)).toMatchObject({ state: "settled", childrenJoined: true, writersClosed: true, arm: { kind: "blocked" } });
});

test("a throwing control has unknown cleanup, while failed qualification with cleanup proof can settle", async () => {
  const native = fakeNative({});
  native.control = async () => { throw new Error("cleanup threw after creating the job"); };
  const directory = await logs();
  await capturedRun(native, directory);
  expect(await settlement(directory)).toMatchObject({ state: "unproved", childrenJoined: false, control: null });
  const proved = await logs();
  await capturedRun(fakeNative({ passed: false, failure: "query failed after cleanup", jobRemoved: true, fileRemoved: true }), proved);
  expect(await settlement(proved)).toMatchObject({ state: "settled", childrenJoined: true });
});

test("native events outside the confirmed identity interval cannot supply attribution", async () => {
  const native = fakeNative({});
  native.query = async (pid, service, start, end) => {
    const times = [new Date(start.getTime() - 1).toISOString(), end.toISOString(), new Date(end.getTime() + 1).toISOString(), "bad timestamp"];
    return { ignored: 0, events: times.map(eventUtc => ({ kind: "signal-service", eventTime: eventUtc, eventUtc, reporter: "launchd", reporterPid: 1,
      target: pid, service, parentPid: 99, signal: 9, exitCode: null, caller: { name: "Safari", pid: 99 }, received: { utc: end.toISOString(), monotonicMs: 0 } })) };
  };
  const directory = await logs();
  await capturedRun(native, directory, capture => {
    acknowledged(capture);
    const arm = capture.arm;
    Object.assign(capture, { arm: async (...args: Parameters<typeof arm>) => { await arm(...args); native.births.set(101, "8"); } });
  });
  expect(await settlement(directory)).toMatchObject({ identityLost: { reason: "birth-changed" }, native: { initiating: "unknown", events: 0, ignored: 4 } });
});

test.skipIf(process.env.SAFARI_CAUSAL_READER_CHILD !== "1")("causal reader child control", async () => {
  const native = fakeNative({});
  const original = native.read.bind(native);
  const directory = await logs();
  const result = await capturedRun(native, directory, capture => {
    acknowledged(capture);
    const arm = capture.arm;
    Object.assign(capture, { arm: async (...args: Parameters<typeof arm>) => {
      await arm(...args);
      native.read = () => { throw new Error("diagnostic read failed"); };
      await Bun.sleep(15);
    } });
  });
  native.read = original;
  expect(result.status).toBe("pass");
  expect(await settlement(directory)).toMatchObject({ state: "settled", identityLost: null, degraded: [expect.objectContaining({ file: "native-reader" })] });
});

test("post-arm reader exceptions never become uncaught timer errors", async () => {
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^causal reader child control$"], {
    env: { ...process.env, SAFARI_CAUSAL_READER_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, output, error }).toMatchObject({ code: 0 });
});

test("an unacknowledged session blocks arming before any page challenge", async () => {
  const directory = await logs();
  const native = fakeNative({});
  const result = await capturedRun(native, directory, () => {});
  expect(result).toMatchObject({ status: "fail", error: expect.stringContaining("session or host handle was not acknowledged") });
  expect(native.reads).toEqual([]);
});

test("an armed capture whose native query fails leaves the ordinary outcome unchanged", async () => {
  const directory = await logs();
  const ordinary = await withPlayground(nuxt, 0, transport => execute({ framework: nuxt, box: { framework: "nuxt", browser: "chrome", engine: "browser" },
    url: "http://fixture/?engine=browser", timeoutMs: 2000, async createTransport() { return transport; }, async saveLog() {} }));
  const native = fakeNative({}, async () => { throw new Error("log show failed"); });
  const captured = await capturedRun(native, directory);
  expect(captured.status).toBe(ordinary.status);
  expect(captured.attempts[0]?.phases.map(phase => [phase.phase, phase.status])).toEqual(ordinary.attempts[0]?.phases.map(phase => [phase.phase, phase.status]));
  const receipt = await settlement(directory);
  expect(receipt).toMatchObject({ state: "settled", arm: { kind: "armed", target: { pid: 101, birth: "7" } }, native: { query: "failed", initiating: "unknown" } });
  const names = await readdir(directory);
  expect(names.filter(name => name.endsWith(".native.jsonl"))).toHaveLength(1);
  const text = await readFile(join(directory, names.find(name => name.endsWith(".native.jsonl"))!), "utf8");
  expect(text).not.toContain("\"202\"");
  const facts: unknown[] = text.trim().split("\n").map(line => JSON.parse(line));
  const identities = facts.filter(fact => fact && typeof fact === "object" && "kind" in fact && fact.kind === "identity");
  expect(identities.length).toBeGreaterThan(0);
  for (const fact of identities) expect(fact).toMatchObject({ target: { pid: 101, birth: "7" }, reading: { cpuMs: expect.any(Number), birth: "7", footprintBytes: 4096 } });
});

test("a start-time change at a challenge boundary rejects association, and a change after arming ends attribution", async () => {
  const unstable = fakeNative({});
  const read = unstable.read.bind(unstable);
  unstable.read = pid => { const value = read(pid); if (pid === 101 && unstable.reads.filter(item => item === 101).length > 2) unstable.births.set(101, "8"); return value; };
  const rejected = await capturedRun(unstable, await logs());
  expect(rejected).toMatchObject({ status: "fail", error: expect.stringContaining("0 of 2 candidates matched") });

  const directory = await logs();
  const native = fakeNative({});
  let armed = false;
  const result = await capturedRun(native, directory, capture => {
    acknowledged(capture);
    const arm = capture.arm;
    Object.assign(capture, { arm: async (...args: Parameters<typeof arm>) => { await arm(...args); armed = true; native.births.set(101, "8"); } });
  });
  expect(armed).toBe(true);
  expect(result.status).toBe("pass");
  const receipt = await settlement(directory);
  expect(receipt).toMatchObject({ identityLost: { reason: "birth-changed" }, arm: { target: { birth: "7" } } });
  const names = await readdir(directory);
  const text = await readFile(join(directory, names.find(name => name.endsWith(".native.jsonl"))!), "utf8");
  expect(text).not.toContain('"kind":"identity"');
  const after = native.reads.slice(native.reads.lastIndexOf(202) + 1);
  expect(after.every(pid => pid === 101)).toBe(true);
});

const launchd = (subsystem: string, eventMessage: string, processID = 1) => ({ timestamp: "2026-11-12 17:34:11.745123-0800", processID, processImagePath: processID === 1 ? "/sbin/launchd" : "/usr/libexec/other", subsystem, eventMessage });
test("launchd caller ancestry preserves the immediate caller and rejects malformed chains", () => {
  const job = "gui/501/dev.bun-wasm.causal-control.native";
  const result = normalizeLaunchdLog(JSON.stringify([
    launchd(`${job} [93976]`, "signal service: caller = launchctl[93982]<-bun[93974]<-bash[93969]<-bun[93967]<-bun[93921]<-mesh[77235], value = 0x9"),
    launchd(`${job} [93976]`, "signal service: caller = bun[93974]<-launchctl[93982], value = 0x9"),
    launchd(`${job} [93976]`, "signal service: caller = launchctl[93982]<-bun[invalid], value = 0x9"),
    launchd(`${job} [93976]`, "signal service: caller = launchctl[93982]<-, value = 0x9"),
    launchd(`${job} [939760]`, "signal service: caller = launchctl[93982]<-bun[93974], value = 0x9"),
  ]), 93976, service => service === job ? "control" : undefined);
  expect(result.ignored).toBe(3);
  expect(result.events.map(event => [event.target, event.signal, event.caller])).toEqual([
    [93976, 9, { name: "launchctl", pid: 93982 }],
    [93976, 9, { name: "bun", pid: 93974 }],
  ]);
  expect(JSON.stringify(result)).not.toContain("mesh");
});

test("the launchd parser keeps only exact target tokens and normalized fields", () => {
  const service = "pid/13792/com.apple.WebKit.WebContent.9E124E17-28EA-452A-B77F-98EBD4296BD5";
  const text = JSON.stringify([
    launchd(`${service} [10005]`, "signal service: caller = Safari[13792], value = 0x9"),
    launchd(`${service} [100050]`, "signal service: caller = Safari[13792], value = 0x9"),
    launchd(`${service} [1000]`, "signal service: caller = Safari[13792], value = 0x9"),
    launchd("", `[${service} [10005]:] exited due to SIGKILL | sent by Safari[13792], ran for 10ms`),
    launchd(`${service} [10005]`, "signal service: caller = Safari[13792], value = 0x9", 77),
    launchd(`${service} [10005]`, "xpcproxy spawned with pid 10005"),
    launchd(`gui/501/other [10005]`, "signal service: caller = Safari[13792], value = 0x9"),
  ]);
  const result = normalizeLaunchdLog(text, 10005, webContentService);
  expect(result.ignored).toBe(5);
  expect(result.events.map(event => [event.kind, event.target, event.parentPid, event.signal, event.caller, event.eventUtc])).toEqual([
    ["signal-service", 10005, 13792, 9, { name: "Safari", pid: 13792 }, "2026-11-13T01:34:11.745Z"],
    ["exit", 10005, 13792, 9, { name: "Safari", pid: 13792 }, "2026-11-13T01:34:11.745Z"],
  ]);
  expect(JSON.stringify(result)).not.toContain("ran for");
  // Shape of the task-owned control job's own launchd records from the 2026-11-12 capture unit.
  const job = "gui/501/dev.bun-wasm.causal-control.f74593a5-4140-4341-baf7-2d6a82709ecf";
  const control = normalizeLaunchdLog(JSON.stringify([
    launchd(`${job} [49951]`, "xpcproxy spawned with pid 49951"),
    launchd(`${job} [49951]`, "signaled service: Terminated: 15"),
    launchd(`${job} [49951]`, "exited due to SIGTERM | sent by launchd[1], ran for 624ms"),
  ]), 49951, service => service === job ? "control" : undefined);
  expect(control.ignored).toBe(2);
  expect(control.events.map(event => [event.kind, event.service, event.signal, event.caller])).toEqual([["exit", "control", 15, { name: "launchd", pid: 1 }]]);
  expect(launchdPredicate(10005)).toBe('process == "launchd" AND (subsystem ENDSWITH " [10005]" OR eventMessage CONTAINS "[10005]:]")');
  expect(() => launchdPredicate(1)).toThrow();
});

test("settlement proof and flag forwarding; the option is narrow and ordinary runs carry no capture", () => {
  expect(() => requireCaptureSettled(null)).not.toThrow();
  expect(() => requireCaptureSettled({ state: "settled", childrenJoined: true, writersClosed: true })).not.toThrow();
  for (const receipt of [{ state: "open" }, { state: "unproved", childrenJoined: false, writersClosed: true }, { state: "settled", childrenJoined: true }]) {
    expect(() => requireCaptureSettled(receipt)).toThrow("unproved");
  }
  const base = ["--asset-source=unit", "--browsers=safari", "--engines=browser", "--frameworks=nuxt", "--mac-lane=lane", "--mac-thread=thread"];
  const capture = options(base.concat("--safari-causal-capture"));
  expect(capture).toMatchObject({ safariCausalCapture: true, safariOwnership: true });
  const forwarded = options(nativeRunnerArgs(capture, "/Users/fixture/tmp/goals"));
  expect(forwarded).toMatchObject({ safariCausalCapture: true, safariOwnership: true });
  expect(options(base)).toMatchObject({ safariCausalCapture: false, safariOwnership: false });
  expect(nativeRunnerArgs(options(base), "/Users/fixture/tmp/goals")).not.toContain("--safari-causal-capture");
  for (const extra of ["--engines=browser,quickjs", "--resume", "--retry-failures", "--safari-endpoint=http://127.0.0.1:1"]) {
    expect(() => options(base.filter(arg => !arg.startsWith(extra.split("=")[0]!)).concat(extra, "--safari-causal-capture"))).toThrow("one desktop Safari cell");
  }
});
