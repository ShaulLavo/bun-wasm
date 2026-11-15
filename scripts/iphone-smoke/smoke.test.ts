import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPlayground, completeAttempt } from "../goals-matrix/test-fixture";
import { frameworks, boxId, type Box, type Framework } from "../goals-matrix/catalog";
import { execute, executeAttempt } from "../goals-matrix/execute";
import type { Transport } from "../goals-matrix/transport";
import type { Attempt, Phase, Report } from "../goals-matrix/model";
import { deviceUDID, smokeOptions, phaseTimeoutMs, installTimeoutMs } from "./options";
import { completedCase, smokeCases, smokePhases, unsafeToContinue } from "./model";
import { queueTicket } from "./admission";
import { runSmoke } from "./run";

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
function nativeFixture(transport: Transport, box: Box, fail?: Scenario): Transport {
  const evaluate: Transport["evaluate"] = async (expression, admission, options) => {
    if (expression.includes("function readyState")) return transport.evaluate(`(${JSON.stringify({ ready: true, status: box.engine === "browser" ? "Browser (native) ready" : "QuickJS ready", engine: box.engine, observedEngine: box.engine, profile: "split", agent: "iPhone Safari" })})`, admission, options);
    if (fail === "install" && expression.includes("function shellState")) throw new Error("install fixture failed");
    if (fail === "dev" && expression.includes("function listener")) throw new Error("dev fixture failed");
    if (fail === "render" && expression.includes("function rendered")) throw new Error("render fixture failed");
    return transport.evaluate(expression, admission, options);
  };
  return { ...transport, capabilities, evaluate,
    navigate: fail === "startup" ? async () => { throw new Error("startup fixture failed"); } : transport.navigate,
    nativeClick: async () => { if (fail === "device") throw new Error("T3 device command failed: fixture"); if (fail === "click") throw new Error("click fixture failed"); return { before: "count 0", after: "count 1", trusted: true, inputMethod: "fixture native tap" }; },
    cleanup: async () => { await transport.close(); if (fail === "cleanup") throw new Error("cleanup fixture failed"); return { browserClosed: true, foregroundStopped: true, previewClosed: true }; },
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
  const holder = { id: "ticket-1", thread: "coordinator", mode: "run", phase: "held", group_id: 123 };
  expect(queueTicket({ holder }, "coordinator")).toBe("ticket-1");
  expect(() => queueTicket({ holder: null }, "coordinator")).toThrow();
  expect(() => queueTicket({ holder }, "other")).toThrow("does not hold");
  expect(() => queueTicket({ holder }, "coordinator", "ticket-2")).toThrow("changed");
  expect(() => queueTicket({ holder: { ...holder, mode: "split" } }, "coordinator")).toThrow();
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
    const report = await withFixtures(config, entered, fail);
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
async function withFixtures(config: ReturnType<typeof smokeOptions>, entered: string[], fail?: Scenario) {
  const transports: Transport[] = [];
  const run = async (index: number): Promise<Awaited<ReturnType<typeof runSmoke>>> => {
    const box = smokeCases[index];
    if (!box) return runSmoke(config, { qualify: async () => {}, admission: async () => "ticket", verify: async () => {}, transport: async (_config, selected) => {
      entered.push(boxId(selected));
      const fixture = transports[smokeCases.findIndex(box => boxId(box) === boxId(selected))];
      if (!fixture) throw new Error("Missing transport");
      return nativeFixture(fixture, selected, entered.length === 1 ? fail : undefined);
    } });
    return withPlayground(frameworkFor(box), 0, async transport => { transports.push(transport); return run(index + 1); });
  };
  return run(0);
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
    await mkdir(config.matrix.root);
    await Bun.write(config.sourceFile, JSON.stringify({ commit: source.commit }));
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const fingerprint = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const builds = Object.fromEntries(["bun-browser.wasm", "bun.wasm", "quickjs.wasm"].map(name => [name, fingerprint]));
    for (const name of Object.keys(builds)) await Bun.write(join(config.matrix.root, name), bytes);
    await Bun.write(join(config.matrix.root, "index.html"), `globalThis.__bunwasmBuilds = ${JSON.stringify(builds)};`);
    await Bun.write(join(config.matrix.root, "engine-builds.json"), JSON.stringify(builds));
    let admitted = false;
    const result = await runSmoke(config, { admission: async () => { admitted = true; throw new Error("stop before native work"); } });
    expect(admitted).toBe(true);
    expect(result.source).toEqual({ commit: source.commit, dirty: null, assets: { source: config.matrix.root } });
    expect(result.failures[0]?.error).toBe("Error: stop before native work");
  });
});
