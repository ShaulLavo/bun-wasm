import { expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { recordServed } from "../goals-matrix/iphone-server";
import { compareLiveOrigin } from "./live";
import { clickCounterSource, probeSandboxSource } from "./sandbox-root";
import { withPlayground, completeAttempt } from "../goals-matrix/test-fixture";
import { frameworks, boxId, type Box, type Framework } from "../goals-matrix/catalog";
import { execute, executeAttempt } from "../goals-matrix/execute";
import type { Transport } from "../goals-matrix/transport";
import type { Attempt, Phase, Report } from "../goals-matrix/model";
import { deviceUDID, smokeOptions, phaseTimeoutMs, installTimeoutMs } from "./options";
import { completedCase, unsafeToContinue } from "./model";
import { smokeCases, smokePhases } from "./cases";
import { queueTicket } from "./admission";
import { safariTabJournal } from "./tab-journal";
import { runSmoke } from "./run";
import { templateProfile, type PlaygroundProfile } from "../../web/src/playground/program-profile";
import { engineFiles, profileEngineFiles } from "../goals-matrix/engines";
import { comparedHeaders, decodedSha256, pick, proxyLiveRequest, type LiveServed } from "../goals-matrix/iphone-live-proxy";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const source: Report["source"] = { commit: "a".repeat(40), dirty: false, assets: { source: "local-test-build" } };
const capabilities = { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": deviceUDID, transport: "visible-safari-xctest" };
function argumentsFor(root: string): string[] {
  return [`--root=${root}/site`, `--output=${root}/report`, `--source-file=${root}/source.json`, `--device-udid=${deviceUDID}`,
    "--iphone-control-url=http://127.0.0.1:4321/__goals_iphone/" + "a".repeat(64), "--iphone-agent-command=/bound/agent-device", "--mac-thread=coordinator"];
}
async function scratch<T>(action: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-iphone-smoke-"));
  try { await Bun.write(join(root, "source.json"), JSON.stringify(source)); return await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function frameworkFor(box: Box): Framework {
  const framework = frameworks.find(value => value.id === box.framework);
  if (!framework) throw new Error("Missing fixture");
  return framework;
}
type Scenario = Phase | "device";
function nativeFixture(transport: Transport, box: Box, fail?: Scenario, afterCleanup?: () => Promise<void>, profile = templateProfile(box.engine, frameworkFor(box).template), onNavigate?: (url: string) => void): Transport {
  const evaluate: Transport["evaluate"] = async (expression, admission, options) => {
    if (expression.includes("function readyState")) return transport.evaluate(`(${JSON.stringify({ ready: true, status: box.engine === "browser" ? "Browser (native) ready" : "QuickJS ready", engine: box.engine, observedEngine: box.engine, profile, agent: "iPhone Safari" })})`, admission, options);
    if (fail === "install" && expression.includes("function shellState")) throw new Error("install fixture failed");
    if (fail === "dev" && expression.includes("function listener")) throw new Error("dev fixture failed");
    if (fail === "render" && expression.includes("function rendered")) throw new Error("render fixture failed");
    return transport.evaluate(expression, admission, options);
  };
  return { ...transport, capabilities, evaluate,
    navigate: async (url, admission) => { if (fail === "startup") throw new Error("startup fixture failed"); onNavigate?.(url); await transport.navigate(url, admission); },
    nativeClick: async () => { if (fail === "device") throw new Error("T3 device command failed: fixture"); if (fail === "click") throw new Error("click fixture failed"); return { before: "count 0", after: "count 1", trusted: true, inputMethod: "fixture native tap" }; },
    cleanup: async () => { await transport.close(); await afterCleanup?.(); if (fail === "cleanup") throw new Error("cleanup fixture failed"); return { browserClosed: true, foregroundStopped: true, previewClosed: true }; },
  };
}
function attempt(): Attempt {
  return { ...completeAttempt(), browser: capabilities, phases: completeAttempt().phases.filter(value => smokePhases.some(phase => phase === value.phase)).map(value => value.phase === "click" && value.status === "pass" ? { ...value, evidence: { before: "count 0", after: "count 1", trusted: true } } : value) };
}

test("smoke selections and hang caps stay bounded and ordered", () => {
  expect(smokeCases.map(boxId)).toEqual(["vite-react/iphone-safari/browser", "hono/iphone-safari/browser", "vite-react/iphone-safari/quickjs"]);
  const config = smokeOptions(argumentsFor("/prepared"));
  expect(config.matrix.timeoutMs).toBe(300_000);
  expect(config.matrix.installTimeouts).toEqual({ "vite-react": 600_000, hono: 600_000 });
  expect(phaseTimeoutMs).toBe(300_000);
  expect(installTimeoutMs).toBe(600_000);
});
test.each(["device-udid=BF99", "device-udid=C4D2", "iphone-agent-command=/usr/bin/ssh", "iphone-control-url=https://remote.invalid", "mac-thread=bad\nthread"])("rejects unsafe controller option %s", option => {
  const key = option.split("=")[0];
  const args = argumentsFor("/prepared").filter(value => !value.startsWith(`--${key}=`)).concat([`--${option}`]);
  expect(() => smokeOptions(args)).toThrow();
});
test("requires every input and rejects unknown, repeated and noncanonical flags", () => {
  expect(() => smokeOptions([])).toThrow("device-udid");
  expect(() => smokeOptions(argumentsFor("/prepared").concat(["--build=true"]))).toThrow("unique");
  expect(() => smokeOptions(argumentsFor("/prepared").concat(["--root=/other"]))).toThrow("unique");
  expect(() => smokeOptions(["--root", "/prepared"])).toThrow("--name=value");
});
test("Mac queue admission requires the same supervised holder throughout", () => {
  const status = queueStatus();
  expect(queueTicket(status, "coordinator")).toBe("ticket-1");
  expect(() => queueTicket({ ownerBusy: false, lock: { kind: "free" }, holder: null }, "coordinator")).toThrow("no queue holder");
  expect(() => queueTicket(status, "other")).toThrow("does not hold");
  expect(() => queueTicket(status, "coordinator", "ticket-2")).toThrow("changed");
  expect(() => queueTicket({ ...status, holder: { ...status.holder, mode: "split" } }, "coordinator")).toThrow("supervised exclusive");
  expect(() => queueTicket({ ...status, holder: { ...status.holder, share: "CI" } }, "coordinator")).toThrow("supervised exclusive");
  expect(() => queueTicket({ ...status, lock: { kind: "queue", ticket: "different" } }, "coordinator")).toThrow("inconsistent");
});
function queueStatus(id = "ticket-1", ownerBusy = false) {
  return { ownerBusy, lock: { kind: "queue", ticket: id }, holder: { id, thread: "coordinator", mode: "run", phase: "held", group_id: 123, share: null } };
}
async function admissionBoundary(root: string, probes: string[]): Promise<{ code: number; output: string; error: string; calls: number }> {
  const mesh = join(root, "bin/mesh"), calls = join(root, "calls");
  await Bun.write(mesh, `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const calls = ${JSON.stringify(calls)};
appendFileSync(calls, 'x');
const result = ${JSON.stringify(probes)}[readFileSync(calls).length-1];
if (process.argv[2] !== 'ssh' || !process.argv[7]?.endsWith('mac-queue.ts" status')) throw new Error('Unexpected status command');
if (result === 'transport error') { process.stderr.write('mesh socket reset\\n'); process.exit(42); }
process.stdout.write(result ?? 'unexpected extra probe');
`);
  await chmod(mesh, 0o755);
  const admission = new URL("./admission.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--eval", `const {verifyMacAdmission} = await import(${JSON.stringify(admission)}); process.stdout.write(await verifyMacAdmission("coordinator", "ticket-1"));`], {
    env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output, error, calls: (await Bun.file(calls).text()).length };
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
}
test("a probe failure waits for fresh evidence of the same reservation and reports the real error", async () => {
  await scratch(async root => {
    const result = await admissionBoundary(root, ["transport error", JSON.stringify(queueStatus())]);
    expect(result.code, result.error).toBe(0);
    expect(result.output).toBe("ticket-1");
    expect(result.error).toContain("mesh socket reset");
    expect(result.calls).toBe(2);
  });
});
test("persistent probe errors report both the transport error and the malformed response", async () => {
  await scratch(async root => {
    const result = await admissionBoundary(root, ["transport error", "invalid json"]);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("admission is unverified");
    expect(result.error).toContain("mesh socket reset");
    expect(result.error).toContain("SyntaxError");
    expect(result.calls).toBe(2);
  });
});
test.each([[queueStatus("ticket-2"), "changed"], [queueStatus("ticket-1", true), "reserved by its owner"]] as const)("confirmed Mac admission loss stops without retry", async (status, error) => {
  await scratch(async root => {
    const result = await admissionBoundary(root, [JSON.stringify(status), JSON.stringify(queueStatus())]);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain(error);
    expect(result.calls).toBe(1);
  });
});
test("Safari journal persists exact recorded titles across smoke processes", async () => {
  await scratch(async root => {
    const directory = join(root, "tabs"), title = "Goals " + crypto.randomUUID();
    const journal = safariTabJournal(directory);
    expect(await journal.pending()).toEqual(new Set());
    await journal.record(title);
    await Bun.write(join(directory, "Unrelated tab"), "");
    await symlink(join(directory, title), join(directory, "Goals " + crypto.randomUUID()));
    expect(await safariTabJournal(directory).pending()).toEqual(new Set([title]));
    await journal.forget(title);
    expect(await journal.pending()).toEqual(new Set());
  });
});
test("smoke cannot pass synthetic input, missing phases, another simulator or incomplete cleanup", () => {
  const box = smokeCases[0]!;
  expect(completedCase(box, source, attempt()).status).toBe("pass");
  const synthetic = attempt();
  synthetic.phases = synthetic.phases.map(value => value.phase === "click" && value.status === "pass" ? { ...value, evidence: { before: "0", after: "1" } } : value);
  expect(completedCase(box, source, synthetic)).toMatchObject({ status: "fail", failures: [{ phase: "evidence", error: expect.stringContaining("trusted native tap") }] });
  const missing = attempt(); missing.phases.shift();
  expect(completedCase(box, source, missing).status).toBe("fail");
  const other = attempt(); other.browser = { ...capabilities, "safari:deviceUDID": "other" };
  expect(completedCase(box, source, other).status).toBe("fail");
  const unclean = attempt();
  unclean.phases = unclean.phases.map(value => value.phase === "cleanup" && value.status === "pass" ? { ...value, evidence: { browserClosed: false } } : value);
  expect(completedCase(box, source, unclean).status).toBe("fail");
  expect(unsafeToContinue(completedCase(box, source, unclean))).toContain("unproved");
});
test("dev-only execution uses maintained phases while full-matrix default remains complete", async () => {
  const box = smokeCases[0]!, framework = frameworkFor(box);
  await withPlayground(framework, 0, async transport => {
    const options = { box, framework, url: "http://fixture/?engine=browser", timeoutMs: 1000, createTransport: async () => nativeFixture(transport, box), saveLog: async () => {} };
    const result = await executeAttempt(options, "click");
    expect(result.phases.map(value => value.phase), JSON.stringify(result)).toEqual(Array.from(smokePhases));
    expect(result.phases.every(value => value.status === "pass")).toBe(true);
    expect(result.phases.every(value => value.durationMs >= 0)).toBe(true);
  });
  await withPlayground(framework, 0, async transport => {
    const cell = await execute({ box: { ...box, browser: "chrome" }, framework, url: "http://fixture/?engine=browser", timeoutMs: 1000, createTransport: async () => transport, saveLog: async () => {} });
    expect(cell.status).toBe("pass");
    expect(cell.attempts[0]?.phases.map(value => value.phase)).toEqual(completeAttempt().phases.map(value => value.phase));
  });
});

test.each([undefined, "startup", "install", "dev", "render", "click", "cleanup", "device"] as const)("persists per-case outcomes and continuation after %s failure", async fail => {
  await scratch(async root => {
    const entered: string[] = [];
    const config = smokeOptions(argumentsFor(root));
    const report = await withFixtures(config, entered, { fail });
    expect(report.cases.map(value => value.id)).toEqual(smokeCases.map(boxId));
    const stops = fail === "cleanup" || fail === "device";
    expect(entered).toEqual(stops ? [boxId(smokeCases[0]!)] : smokeCases.map(boxId));
    expect(report.status).toBe(fail ? "red" : "green");
    expect(report.failedPhase).toBe(fail === "device" ? "click" : fail ?? null);
    expect(report.cases[1]?.status).toBe(stops ? "blocked" : "pass");
    expect(report.cases.every(value => value.source?.commit === source.commit)).toBe(true);
    expect(await Bun.file(report.reportPath).json()).toEqual(report);
    expect(await Bun.file(join(config.matrix.output, "TABLE.json")).exists()).toBe(false);
  });
});
type FixtureOptions = {
  fail?: Scenario;
  controller?: AbortController;
  overrides?: Parameters<typeof runSmoke>[1];
  onNavigate?(url: string): void;
  readyProfile?(box: Box): PlaygroundProfile;
  preflight?: boolean;
  afterCleanup?(caseNumber: number): Promise<void>;
};
test("common template selection is reused for preflight, execution and URLs", async () => {
  await scratch(async root => {
    const config = smokeOptions(argumentsFor(root)), urls: string[] = [];
    expect(config.matrix.profile).toBeUndefined();
    let qualified: unknown;
    const result = await withFixtures(config, [], { onNavigate: url => urls.push(url), overrides: {
      qualify: async (_config, programs) => {
        qualified = programs;
        expect(programs.map(({ box, profile }) => [box.engine, profile])).toEqual([["browser", "split"], ["quickjs", "shared-group"]]);
      },
      verify: async (_root, programs) => { expect(Object.is(programs, qualified)).toBe(true); },
    } });
    expect(result.status).toBe("green");
    expect(urls.map(url => new URL(url).searchParams.get("profile"))).toEqual(["split", "split", "shared-group"]);
    expect(result.cases[2]?.phases[0]).toMatchObject({ phase: "startup", status: "pass", evidence: { profile: "shared-group" } });
  });
});
test("a QuickJS split startup cannot satisfy shared-group execution", async () => {
  await scratch(async root => {
    const result = await withFixtures(smokeOptions(argumentsFor(root)), [], { readyProfile: () => "split" });
    expect(result.cases.slice(0, 2).every(value => value.status === "pass")).toBe(true);
    expect(result.cases[2]).toMatchObject({ status: "fail", failures: [{ phase: "startup", error: expect.stringContaining("expected shared-group, observed split") }] });
  });
});
test("ordinary QuickJS assets never substitute for the selected shared-group program", async () => {
  await scratch(async root => {
    const config = smokeOptions(argumentsFor(root));
    await mkdir(config.matrix.root);
    await Bun.write(join(config.matrix.root, "index.html"), "fixture");
    await Bun.write(join(config.matrix.root, "engine-builds.json"), "{}");
    for (const name of engineFiles("browser").concat(engineFiles("quickjs"))) await Bun.write(join(config.matrix.root, name), new Uint8Array());
    let admitted = false;
    const result = await runSmoke(config, { admission: async () => { admitted = true; return "ticket"; } });
    expect(admitted).toBe(false);
    expect(result.failures[0]?.error).toContain(profileEngineFiles("quickjs", "shared-group")[0]!);
    expect(result.cases.every(value => value.status === "blocked")).toBe(true);
  });
});
async function withFixtures(config: ReturnType<typeof smokeOptions>, entered: string[], options: FixtureOptions = {}) {
  const transports: Transport[] = [];
  const run = async (index: number): Promise<Awaited<ReturnType<typeof runSmoke>>> => {
    const box = smokeCases[index];
    const preflight = options.preflight ? {} : { qualify: async () => {}, verify: async () => {} };
    if (!box) return runSmoke(config, { ...preflight, admission: async () => "ticket", ...options.overrides,
      transport: async (_config, selected) => fixtureTransport(transports, entered, selected, options),
    }, options.controller?.signal);
    return withPlayground(frameworkFor(box), 0, async transport => { transports.push(transport); return run(index + 1); });
  };
  return run(0);
}
function fixtureTransport(transports: Transport[], entered: string[], selected: Box, options: FixtureOptions): Transport {
  entered.push(boxId(selected));
  const fixture = transports[smokeCases.findIndex(box => boxId(box) === boxId(selected))];
  if (!fixture) throw new Error("Missing transport");
  const caseNumber = entered.length;
  return nativeFixture(fixture, selected, caseNumber === 1 ? options.fail : undefined,
    () => cleanupFixture(options, caseNumber), options.readyProfile?.(selected), options.onNavigate);
}
async function cleanupFixture(options: FixtureOptions, caseNumber: number): Promise<void> {
  if (caseNumber === 3) options.controller?.abort(new Error("cancelled during final cleanup"));
  await options.afterCleanup?.(caseNumber);
}
test("missing engine manifest records an exact prerequisite and never touches a device", async () => {
  await scratch(async root => {
    const config = smokeOptions(argumentsFor(root));
    await mkdir(config.matrix.root);
    await Bun.write(join(config.matrix.root, "index.html"), "fixture");
    let admitted = false;
    const result = await runSmoke(config, { admission: async () => { admitted = true; return "ticket"; } });
    expect(admitted).toBe(false);
    expect(result).toMatchObject({ status: "red", revision: source.commit, failedPhase: "prerequisite", failures: [{ phase: "prerequisite", error: "Error: Prepared smoke root is missing engine-builds.json" }] });
    expect(result.cases.every(value => value.status === "blocked" && value.attempt === null)).toBe(true);
    expect(result.cases.every(value => value.source?.commit === source.commit)).toBe(true);
  });
});
test("lost admission leaves all cases durable and performs no native work", async () => {
  await scratch(async root => {
    const result = await runSmoke(smokeOptions(argumentsFor(root)), { qualify: async () => {}, admission: async () => { throw new Error("FIFO owner changed"); } });
    expect(result.status).toBe("red");
    expect(result.cases.every(value => value.status === "blocked" && value.phases.length === 0)).toBe(true);
    expect(await Bun.file(result.reportPath).json()).toEqual(result);
  });
});
test("interruption saves blocked remaining cases without dispatching native work", async () => {
  await scratch(async root => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let entered = false;
    const result = await runSmoke(smokeOptions(argumentsFor(root)), { qualify: async () => {}, admission: async () => "ticket", verify: async () => {}, transport: async () => { entered = true; throw new Error("must not dispatch"); } }, controller.signal);
    expect(result.status).toBe("red");
    expect(entered).toBe(false);
    expect(result.cases.every(value => value.status === "blocked")).toBe(true);
    expect(result.finishedAt).not.toBeNull();
    expect(await Bun.file(result.reportPath).json()).toEqual(result);
  });
});
test("interruption during final cleanup retains cleanup evidence and cannot report green", async () => {
  await scratch(async root => {
    const controller = new AbortController(), entered: string[] = [];
    const result = await withFixtures(smokeOptions(argumentsFor(root)), entered, { controller });
    expect(controller.signal.aborted).toBe(true);
    expect(entered).toEqual(smokeCases.map(boxId));
    expect(result.cases.every(value => value.status === "pass" && value.cleanup?.status === "pass")).toBe(true);
    expect(result.status).toBe("red");
    expect(result.failures).toContainEqual({ phase: "interruption", error: "Error: cancelled during final cleanup" });
    expect(await Bun.file(result.reportPath).json()).toEqual(result);
  });
});
test("a second invocation refuses to replace an existing result directory", async () => {
  await scratch(async root => {
    const config = smokeOptions(argumentsFor(root));
    await mkdir(config.matrix.output);
    await Bun.write(join(config.matrix.output, "result.json"), "keep previous evidence");
    await expect(runSmoke(config)).rejects.toThrow("EEXIST");
    expect(await Bun.file(join(config.matrix.output, "result.json")).text()).toBe("keep previous evidence");
  });
});
test("the real CLI lists cases and exits nonzero with a durable prerequisite failure", async () => {
  await scratch(async root => {
    const cli = new URL("../iphone-smoke.ts", import.meta.url).pathname;
    const listed = await cliResult(cli, ["--list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.trim().split("\n")).toEqual(smokeCases.map(boxId));
    const failed = await cliResult(cli, argumentsFor(root));
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "red", failedPhase: "prerequisite" });
    expect(await Bun.file(join(root, "report/result.json")).json()).toMatchObject({ status: "red", revision: source.commit });
  });
});
async function cliResult(cli: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([process.execPath, cli].concat(args), { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    return { code, stdout };
  } finally { child.kill("SIGTERM"); await child.exited; }
}
test("a local build and recorded commit need no CI origin or goals inventory metadata", async () => {
  await scratch(async root => {
    const config = smokeOptions(argumentsFor(root));
    if (config.target.mode !== "local") throw new Error("Expected local mode");
    await Bun.write(config.target.sourceFile, JSON.stringify({ commit: source.commit }));
    await preparedRoot(config.matrix.root);
    let admitted = false;
    const result = await runSmoke(config, { admission: async () => { admitted = true; throw new Error("stop before native work"); } });
    expect(admitted).toBe(true);
    expect(result.source).toEqual({ commit: source.commit, dirty: null, assets: { source: config.matrix.root } });
    expect(result.failures[0]?.error).toBe("Error: stop before native work");
  });
});
async function preparedRoot(root: string): Promise<void> {
  await mkdir(root);
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const fingerprint = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const builds = Object.fromEntries(profileEngineFiles("browser", "split").concat(profileEngineFiles("quickjs", "shared-group")).map(name => [name, fingerprint]));
  for (const name of Object.keys(builds)) await Bun.write(join(root, name), bytes);
  await Bun.write(join(root, "index.html"), `globalThis.__bunwasmBuilds = ${JSON.stringify(builds)};`);
  await Bun.write(join(root, "engine-builds.json"), JSON.stringify(builds));
}
test("final verification checks the selected shared program after all case cleanups", async () => {
  await scratch(async root => {
    const config = smokeOptions(argumentsFor(root));
    await preparedRoot(config.matrix.root);
    const result = await withFixtures(config, [], { preflight: true, afterCleanup: async caseNumber => {
      if (caseNumber === 3) await Bun.write(join(config.matrix.root, profileEngineFiles("quickjs", "shared-group")[0]!), "changed shared core");
    } });
    expect(result.cases.every(value => value.status === "pass")).toBe(true);
    expect(result.status).toBe("red");
    expect(result.failures[0]?.error).toContain("embedded host, manifest, and staged bytes disagree");
    expect(result.failures[0]?.error).toContain(profileEngineFiles("quickjs", "shared-group")[0]!);
  });
});

const site = "https://bun.sprockt.dev/";
function liveArguments(root: string): string[] {
  return argumentsFor(root).filter(value => !value.startsWith("--root=") && !value.startsWith("--source-file=")).concat([`--base-url=${site}`]);
}
test("live mode takes a site root instead of a prepared build and recorded commit", () => {
  const config = smokeOptions(liveArguments("/unused"));
  expect(config.target).toEqual({ mode: "live", url: site });
  expect(config.matrix.assetSource).toBe(site);
  expect(config.matrix.timeoutMs).toBe(phaseTimeoutMs);
  expect(config.matrix.installTimeouts).toEqual({ "vite-react": installTimeoutMs, hono: installTimeoutMs });
  expect(config.matrix.iphoneControlUrl).toBe(config.control);
  expect(smokeOptions(argumentsFor("/prepared")).target).toEqual({ mode: "local", root: "/prepared/site", sourceFile: "/prepared/source.json" });
});
test.each(["root=/prepared/site", "source-file=/prepared/source.json", "asset-source=local"])("live mode rejects the local input --%s", option => {
  expect(() => smokeOptions(liveArguments("/unused").concat([`--${option}`]))).toThrow("--base-url tests a deployed site");
});
test.each(["http://bun.sprockt.dev/", "https://bun.sprockt.dev/playground/", "https://bun.sprockt.dev/?v=1", "https://user:pass@bun.sprockt.dev/", "bun.sprockt.dev"])("live mode rejects the base URL %s", url => {
  expect(() => smokeOptions(liveArguments("/unused").filter(value => !value.startsWith("--base-url=")).concat([`--base-url=${url}`]))).toThrow("--base-url");
});
test("local mode still requires its prepared root and recorded commit", () => {
  expect(() => smokeOptions(argumentsFor("/prepared").filter(value => !value.startsWith("--root=")))).toThrow("Missing --root");
  expect(() => smokeOptions(argumentsFor("/prepared").filter(value => !value.startsWith("--source-file=")))).toThrow("Missing --source-file");
});
const isolated = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
/** Serves a prepared root as the deployed site would: the sandbox at /, the playground under /playground/. */
function deployedSite(root: string, commits: string[], requests: string[], pageHeaders: Record<string, string> = isolated): (url: string) => Promise<Response> {
  return async url => {
    requests.push(url);
    const path = new URL(url).pathname;
    if (!url.startsWith(site)) throw new Error(`Live smoke fetched another origin: ${url}`);
    if (path === "/deployment.json") return Response.json({ sourceCommit: commits.length > 1 ? commits.shift() : commits[0], waffleVersion: "0.0.0-test" });
    const isHtml = path === "/" || path === "/playground/";
    const name = isHtml ? "index.html" : path.replace(/^\/playground\//, "").replace(/^\//, "");
    const file = Bun.file(join(root, name));
    if (!await file.exists()) return new Response(null, { status: 404 });
    return new Response(file, { headers: isHtml ? { "content-type": "text/html", "cache-control": "no-store", ...pageHeaders } : { "content-type": "application/octet-stream" } });
  };
}
/** What the Mac proxy would have recorded for these paths, read from the same deployed site. */
async function servedFrom(get: (url: string) => Promise<Response>, paths: readonly string[]): Promise<LiveServed[]> {
  return Promise.all(paths.map(async url => {
    const response = await get(new URL(url, site).href);
    return { url, request: { "accept-encoding": "gzip, deflate, br" }, status: response.status, headers: pick(response.headers, comparedHeaders), sha256: decodedSha256(await response.bytes(), null) };
  }));
}
const servedPaths = ["/", "/playground/", "/playground/engine-builds.json"];
const passingSandboxRoot = async () => ({ url: "http://127.0.0.1/", status: "pass" as const, initialMs: 1200, reloadMs: 600, databases: ["bun-wasm-sandbox-vite-react"] });
test("live mode skips local setup and runs the same cases against the deployed playground", async () => {
  await scratch(async root => {
    const config = smokeOptions(liveArguments(root));
    await preparedRoot(join(root, "deployed"));
    const requests: string[] = [], urls: string[] = [];
    const get = deployedSite(join(root, "deployed"), [source.commit], requests);
    const served = await servedFrom(deployedSite(join(root, "deployed"), [source.commit], []), servedPaths);
    const result = await withFixtures(config, [], { preflight: true, onNavigate: url => urls.push(url),
      overrides: { fetch: get, served: async () => served, sandboxRoot: passingSandboxRoot } });
    expect(result.liveOrigin).toEqual({ checked: 3, mismatches: [] });
    expect(result.sandboxRoot?.status).toBe("pass");
    expect(result.status, JSON.stringify(result.failures)).toBe("green");
    expect(result.revision).toBe(source.commit);
    expect(result.source).toEqual({ commit: source.commit, dirty: null, assets: { source: site, deployment: { sourceCommit: source.commit, waffleVersion: "0.0.0-test" } } });
    expect(result.cases.map(value => value.phases.map(phase => phase.phase))).toEqual(smokeCases.map(() => Array.from(smokePhases)));
    expect(urls.map(url => new URL(url).pathname)).toEqual(["/playground/", "/playground/", "/playground/"]);
    expect(urls.map(url => new URL(url).searchParams.get("profile"))).toEqual(["split", "split", "shared-group"]);
    // Qualification, final verification and the real-origin comparison all read the deployed host page.
    expect(requests.filter(url => url === site + "playground/")).toHaveLength(3);
    expect(requests).toContain(site + "playground/" + profileEngineFiles("quickjs", "shared-group")[0]! + ".gz");
    expect(await Bun.file(join(root, "site")).exists()).toBe(false);
    expect(await Bun.file(join(root, "source.json")).json()).toEqual(source);
    expect(result.resources.external[0]).toBe(`deployed site ${site}`);
  });
});
test("live mode fails before native work when the deployed bytes disagree with their fingerprints", async () => {
  await scratch(async root => {
    const config = smokeOptions(liveArguments(root));
    await preparedRoot(join(root, "deployed"));
    await Bun.write(join(root, "deployed", profileEngineFiles("browser", "split")[0]!), "mixed deploy");
    let admitted = false;
    const result = await runSmoke(config, { fetch: deployedSite(join(root, "deployed"), [source.commit], []), admission: async () => { admitted = true; return "ticket"; } });
    expect(admitted).toBe(false);
    expect(result).toMatchObject({ status: "red", failedPhase: "prerequisite", revision: source.commit });
    expect(result.failures[0]?.error).toContain("embedded host, manifest, and staged bytes disagree");
  });
});
test("live mode reports red when the site redeploys during the smoke", async () => {
  await scratch(async root => {
    const config = smokeOptions(liveArguments(root));
    await preparedRoot(join(root, "deployed"));
    const result = await withFixtures(config, [], { preflight: true,
      overrides: { fetch: deployedSite(join(root, "deployed"), [source.commit, "b".repeat(40)], []), served: async () => [], sandboxRoot: passingSandboxRoot } });
    expect(result.cases.every(value => value.status === "pass")).toBe(true);
    expect(result.status).toBe("red");
    expect(result.failures[0]?.error).toContain(`Live site changed deployment during smoke: ${source.commit} became ${"b".repeat(40)}`);
  });
});
test("a deployed playground without COEP fails the isolation check before native work", async () => {
  await scratch(async root => {
    await preparedRoot(join(root, "deployed"));
    let admitted = false;
    const result = await runSmoke(smokeOptions(liveArguments(root)), {
      fetch: deployedSite(join(root, "deployed"), [source.commit], [], { "cross-origin-opener-policy": "same-origin" }),
      admission: async () => { admitted = true; return "ticket"; } });
    expect(admitted).toBe(false);
    expect(result).toMatchObject({ status: "red", failedPhase: "isolation" });
    expect(result.failures[0]?.error).toContain("not cross-origin isolated (COOP same-origin, COEP null)");
  });
});
test("any difference between the run and the real origin makes the live smoke red", async () => {
  await scratch(async root => {
    await preparedRoot(join(root, "deployed"));
    const get = deployedSite(join(root, "deployed"), [source.commit], []);
    const served = await servedFrom(get, servedPaths);
    served[1]!.headers["cache-control"] = "public, max-age=600";
    served[2]!.sha256 = "0".repeat(64);
    const result = await withFixtures(smokeOptions(liveArguments(root)), [], { preflight: true, overrides: { fetch: get, served: async () => served, sandboxRoot: passingSandboxRoot } });
    expect(result.cases.every(value => value.status === "pass")).toBe(true);
    expect(result).toMatchObject({ status: "red", failedPhase: "live-origin", liveOrigin: { checked: 3 } });
    expect(result.liveOrigin?.mismatches).toEqual([
      "/playground/: cache-control \"public, max-age=600\" in the run, \"no-store\" from the real origin",
      "/playground/engine-builds.json: decoded bytes differ from the real origin"]);
  });
});
test("a run whose proxy recorded no playground or root page cannot pass the origin check", async () => {
  await scratch(async root => {
    await preparedRoot(join(root, "deployed"));
    const get = deployedSite(join(root, "deployed"), [source.commit], []);
    const result = await withFixtures(smokeOptions(liveArguments(root)), [], { preflight: true, overrides: { fetch: get, served: async () => [], sandboxRoot: passingSandboxRoot } });
    expect(result).toMatchObject({
      status: "red",
      failedPhase: "live-origin",
      liveOrigin: { checked: 0, mismatches: ["the run served no /playground/ page", "the run served no / sandbox page"] },
    });
  });
});
test("live origin check rejects 404 responses (including conditional GET and HEAD via proxy) and records status changes separately", async () => {
  await scratch(async root => {
    await preparedRoot(join(root, "deployed"));
    const get = deployedSite(join(root, "deployed"), [source.commit], []);
    const upstream = (input: string | URL | Request) => get(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const served: LiveServed[] = [];
    const record = recordServed(served);
    for (const row of await servedFrom(get, servedPaths)) record(row);
    const conditional = await proxyLiveRequest(new Request("http://127.0.0.1:4100/chunks/missing-cond.js", { headers: { "if-none-match": '"etag-1"' } }), site, upstream as typeof fetch, record);
    expect(conditional.status).toBe(404);
    await conditional.arrayBuffer();
    const head = await proxyLiveRequest(new Request("http://127.0.0.1:4100/chunks/missing-head.js", { method: "HEAD" }), site, upstream as typeof fetch, record);
    expect(head.status).toBe(404);
    record({ ...served[0]!, status: 404 });
    expect(served.filter(row => row.url === "/")).toHaveLength(2);
    const check = await compareLiveOrigin(site, served, get, { requireRoot: true });
    expect(check.mismatches).toContain("/chunks/missing-cond.js: served HTTP 404");
    expect(check.mismatches).toContain("/chunks/missing-head.js: served HTTP 404");

    // Conditional GET and HEAD 404s under /__preview/ stay unrecorded and do not break live-origin checks.
    const previewServed: LiveServed[] = [];
    const recordPreview = recordServed(previewServed);
    for (const row of await servedFrom(get, servedPaths)) recordPreview(row);
    const previewCond = await proxyLiveRequest(new Request("http://127.0.0.1:4100/__preview/5173/missing.js", { headers: { "if-none-match": '"etag-1"' } }), site, upstream as typeof fetch, recordPreview);
    expect(previewCond.status).toBe(404);
    await previewCond.arrayBuffer();
    const previewHead = await proxyLiveRequest(new Request("http://127.0.0.1:4100/__preview/5173/missing.js", { method: "HEAD" }), site, upstream as typeof fetch, recordPreview);
    expect(previewHead.status).toBe(404);
    expect(await compareLiveOrigin(site, previewServed, get, { requireRoot: true })).toEqual({ checked: 3, mismatches: [] });
  });
});
test("sandbox-root probe and counter click succeed across distinct host and iframe realms", async () => {
  class HostHTMLElement {}
  class IframeHTMLElement {}
  const button = Object.assign(new IframeHTMLElement(), {
    textContent: "count is 0",
    click() { this.textContent = "count is 1"; },
  });
  expect(button instanceof HostHTMLElement).toBe(false);
  const iframe = {
    contentDocument: {
      querySelector: (selector: string) => selector === "button.counter:not([disabled])" ? button : null,
    },
  };
  const elements: Record<string, unknown> = {
    "#status": { getAttribute: (name: string) => name === "data-kind" ? "ok" : null, textContent: "dev server ready in 1.2 s" },
    "#server-dot": { getAttribute: (name: string) => name === "data-state" ? "up" : null },
    "#preview": iframe,
  };
  const context = {
    HTMLElement: HostHTMLElement,
    HTMLIFrameElement: class HostIFrame {},
    document: { querySelector: (selector: string) => elements[selector] ?? null },
    indexedDB: { databases: async () => [{ name: "bun-wasm-sandbox-vite-react" }] },
    performance: { now: () => Date.now() },
    setTimeout,
  };
  const probed = await runInNewContext(probeSandboxSource, context) as { ready: boolean; buttonText: string; databases: string[] };
  expect(probed).toMatchObject({ ready: true, buttonText: "count is 0", databases: ["bun-wasm-sandbox-vite-react"] });
  const clicked = await runInNewContext(clickCounterSource, context) as { clicked: boolean; text: string };
  expect(clicked).toEqual({ clicked: true, text: "count is 1" });
});
test("live mode reports red when the root persistent sandbox fails", async () => {
  await scratch(async root => {
    await preparedRoot(join(root, "deployed"));
    const get = deployedSite(join(root, "deployed"), [source.commit], []);
    const served = await servedFrom(get, servedPaths);
    const result = await withFixtures(smokeOptions(liveArguments(root)), [], {
      preflight: true,
      overrides: {
        fetch: get,
        served: async () => served,
        sandboxRoot: async () => ({ url: "http://127.0.0.1/", status: "fail", error: "INVALID_VFS_FORMAT" }),
      },
    });
    expect(result.cases.every(value => value.status === "pass")).toBe(true);
    expect(result).toMatchObject({ status: "red", failedPhase: "sandbox-root", sandboxRoot: { status: "fail", error: "INVALID_VFS_FORMAT" } });
  });
});
test("live mode needs the site's recorded source commit", async () => {
  await scratch(async root => {
    let admitted = false;
    const result = await runSmoke(smokeOptions(liveArguments(root)), { fetch: async () => Response.json({ waffleVersion: "0.0.0" }), admission: async () => { admitted = true; return "ticket"; } });
    expect(admitted).toBe(false);
    expect(result).toMatchObject({ status: "red", revision: null, failures: [{ phase: "prerequisite", error: "Error: Live site deployment.json has no 40-character sourceCommit" }] });
  });
});
