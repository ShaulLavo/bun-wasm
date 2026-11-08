import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialReport, options, run } from "./run";
import { deadlinePolicy } from "./deadlines";
import { frameworks } from "./catalog";
import { execute } from "./execute";
import { combine, nativeRunnerArgs } from "./fleet";
import { finish, initialCells, validateReport, type Report } from "./model";
import { object } from "./evidence";
import type { Transport } from "./transport";
import { markdown, saveReport } from "./report";
import { completeAttempt, withPlayground } from "./test-fixture";

const campaign = ["--asset-source=test", "--timeout-ms=90000"];
const override = "--install-timeout-ms=nuxt:110000";

test("an explicit Nuxt install budget leaves the campaign phase timeout unchanged", () => {
  const config = options(campaign.concat(override));
  expect(config).toMatchObject({ timeoutMs: 90_000, installTimeouts: { nuxt: 110_000 } });
  const policy = deadlinePolicy(config.timeoutMs, config.installTimeouts);
  expect(policy.timeoutMs).toBe(90_000);
  expect(policy.cleanupTimeoutMs).toBe(20_000);
  for (const framework of frameworks) expect(policy.installTimeouts[framework.id]).toBe(framework.id === "nuxt" ? 110_000 : 90_000);
});

test("default, strict, and explicit equal-budget runs keep their original effective bounds", () => {
  expect(options(["--asset-source=test"]).timeoutMs).toBe(180_000);
  const strict = options(campaign), equal = options(campaign.concat("--install-timeout-ms=nuxt:90000"));
  expect(strict.installTimeouts).toEqual({});
  expect(deadlinePolicy(strict.timeoutMs, strict.installTimeouts)).toEqual(deadlinePolicy(equal.timeoutMs, equal.installTimeouts));
  expect(Object.values(deadlinePolicy(strict.timeoutMs).installTimeouts).every(timeout => timeout === 90_000)).toBe(true);
});

test.each(["", "nuxt", "nuxt:", "nuxt:99", "nuxt:900001", "nuxt:1.5", "nuxt:-1", "nuxt:NaN", "nuxt:Infinity", "nuxt:1e5", "nuxt: 110000", "nuxt:110000:extra", "Nuxt:110000", "unknown:110000", "__proto__:110000", "nuxt:110000,", "nuxt:110000,nuxt:120000"])("rejects invalid install budget %j at the CLI boundary", value => {
  expect(() => options(campaign.concat(`--install-timeout-ms=${value}`))).toThrow();
});
test("rejects repeated flags and accepts independent catalogued overrides", () => {
  expect(() => options(campaign.concat(override, override))).toThrow("repeated");
  expect(() => options(campaign.concat("--install-timeout-ms"))).toThrow();
  expect(options(campaign.concat("--install-timeout-ms=nuxt:110000,astro:100000")).installTimeouts).toEqual({ nuxt: 110_000, astro: 100_000 });
});

test("fleet forwards explicit install policy to the native runner without changing its campaign bound", () => {
  const config = options(campaign.concat(override, "--browsers=safari", "--frameworks=nuxt,astro", "--engines=browser", "--resume", "--retry-failures"));
  const args = nativeRunnerArgs(config, "/Users/fixture/tmp/goals");
  expect(args).toContain(override);
  expect(args).toContain("--timeout-ms=90000");
  const native = options(args);
  expect(native).toMatchObject({ timeoutMs: 90_000, installTimeouts: { nuxt: 110_000 }, browsers: ["safari"], frameworks: ["nuxt", "astro"], resume: true, retryFailures: true });
  expect(deadlinePolicy(native.timeoutMs, native.installTimeouts)).toEqual(deadlinePolicy(config.timeoutMs, config.installTimeouts));
  expect(nativeRunnerArgs(options(campaign), "/Users/fixture/tmp/goals").some(arg => arg.startsWith("--install-timeout-ms"))).toBe(false);
});

async function sampleExecution(installTimeoutMs?: number, stallRender = false) {
  const framework = frameworks.find(item => item.id === "nuxt");
  if (!framework) throw new Error("Missing Nuxt fixture");
  return withPlayground(framework, 150, transport => {
    if (stallRender) transport.openPreview = () => new Promise(() => {});
    return execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "browser" },
      url: "http://fixture/?engine=browser", timeoutMs: 100, installTimeoutMs,
      async createTransport() { return transport; }, async saveLog() {},
    });
  });
}
test("the install's outer deadline and command polling both get the override, and every later phase keeps the campaign bound", async () => {
  const strict = await sampleExecution();
  expect(strict).toMatchObject({ status: "fail", phase: "install", error: expect.stringContaining("100 ms") });
  const relaxed = await sampleExecution(500);
  expect(relaxed.status).toBe("pass");
  const results = relaxed.attempts[0]?.phases;
  expect(results).toHaveLength(9);
  for (const result of results ?? []) expect(result.timeoutMs).toBe(result.phase === "install" ? 500 : result.phase === "cleanup" ? 20_000 : 100);
});

test("an install override never extends a stalled render phase", async () => {
  const result = await sampleExecution(500, true);
  expect(result).toMatchObject({ status: "fail", phase: "render", error: expect.stringContaining("100 ms") });
});

function sampleReport(overrides: Record<string, number> = {}): Report {
  return { schema: 2, run: "unit-deadlines", createdAt: "now", command: `bun scripts/goals-matrix/run.ts --timeout-ms=90000${overrides.nuxt ? ` --install-timeout-ms=nuxt:${overrides.nuxt}` : ""}`,
    source: { commit: "test", dirty: false, assets: {} }, deadlines: deadlinePolicy(90_000, overrides), cells: initialCells(),
  };
}
test("report evidence states and validates the effective install and phase bounds", () => {
  const report = sampleReport({ nuxt: 110_000 });
  const index = report.cells.findIndex(cell => cell.framework === "nuxt" && cell.browser === "chrome" && cell.engine === "browser");
  const box = report.cells[index];
  if (!box) throw new Error("Missing box");
  const attempt = completeAttempt();
  for (const phase of attempt.phases) phase.timeoutMs = phase.phase === "install" ? 110_000 : phase.phase === "cleanup" ? 20_000 : 90_000;
  report.cells[index] = finish(box, attempt);
  const text = markdown(report);
  expect(text).toContain(override);
  expect(text).toContain("Campaign phases: 90000 ms. Cleanup: 20000 ms");
  expect(text).toContain("| Nuxt | 110000 |");
  expect(text).toContain("| Astro | 90000 |");
  const install = attempt.phases.find(phase => phase.phase === "install");
  if (!install) throw new Error("Missing install phase");
  install.timeoutMs = 90_000;
  expect(() => validateReport(report)).toThrow("Phase timeout differs");
});
test("shard combination rejects different effective policies even without overlapping attempts", () => {
  expect(() => combine(sampleReport(), sampleReport({ nuxt: 110_000 }))).toThrow("deadline policies");
  expect(combine(sampleReport(), sampleReport({ nuxt: 90_000 })).deadlines).toEqual(deadlinePolicy(90_000));
});
const invalidPolicies: unknown[] = [
  {},
  { timeoutMs: "90000" },
  { ...deadlinePolicy(90_000), cleanupTimeoutMs: 90_000 },
  { ...deadlinePolicy(90_000), installTimeouts: { nuxt: 110_000 } },
  { ...deadlinePolicy(90_000), installTimeouts: { ...deadlinePolicy(90_000).installTimeouts, unknown: 110_000 } },
  { ...deadlinePolicy(90_000), installTimeouts: { ...deadlinePolicy(90_000).installTimeouts, nuxt: -1 } },
];
test.each(invalidPolicies)("rejects malformed report policy %j", deadlines => {
  expect(() => validateReport({ ...sampleReport(), deadlines })).toThrow();
});

async function withReportRoot(action: (root: string, output: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-deadlines-"));
  try { const root = join(scratch, "site"), output = join(scratch, "report"); await mkdir(root); await action(root, output); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
test("PC runner reports the explicit policy without inventing runnable or accepted boxes", async () => {
  await withReportRoot(async (root, output) => {
    const report = await run(options(campaign.concat(override, `--root=${root}`, `--output=${output}`, "--browsers=chrome", "--frameworks=nuxt,astro", "--engines=browser")));
    expect(report.deadlines).toEqual(deadlinePolicy(90_000, { nuxt: 110_000 }));
    expect(report.cells.every(cell => cell.attempts.length === 0 && cell.status !== "pass")).toBe(true);
    expect(await Bun.file(join(output, "TABLE.md")).text()).toContain("| Nuxt | 110000 |");
    expect(report.resources?.every(resource => resource.stopped)).toBe(true);
  });
});
test("continuation accepts the same policy, retains failed history, and rejects policy or source and asset changes without writing", async () => {
  await withReportRoot(async (root, output) => {
    const sourceFile = join(root, "source.json");
    const args = campaign.concat(override, `--root=${root}`, `--output=${output}`);
    const first = await initialReport(options(args));
    first.source.dirty = false;
    await writeFile(sourceFile, JSON.stringify(first.source));
    const resumed = options(args.concat("--resume", `--source-file=${sourceFile}`));
    await expect(initialReport(resumed)).rejects.toThrow("Staged assets differ");
    await rm(sourceFile);
    const staged = join(output, "source.json");
    await mkdir(output);
    await writeFile(staged, JSON.stringify(first.source));
    resumed.sourceFile = staged;
    const box = first.cells[0];
    if (!box) throw new Error("Missing cell");
    first.cells[0] = finish(box, { startedAt: "original", finishedAt: "original", browser: {}, phases: [{ phase: "install", status: "fail", error: "Original 90-second miss", startedAt: "original", durationMs: 90_000, timeoutMs: 90_000 }] });
    await saveReport(output, first);
    const saved = await Bun.file(join(output, "TABLE.json")).text();
    expect((await initialReport(resumed)).cells[0]).toEqual(first.cells[0]);
    await expect(initialReport({ ...resumed, installTimeouts: {} })).rejects.toThrow("same effective deadline policy");
    await expect(initialReport({ ...resumed, timeoutMs: 80_000 })).rejects.toThrow("same effective deadline policy");
    await writeFile(join(root, "host.js"), "changed bytes");
    await expect(initialReport(resumed)).rejects.toThrow("Staged assets differ");
    await rm(join(root, "host.js"));
    await writeFile(staged, JSON.stringify({ ...first.source, commit: "other", dirty: false }));
    await expect(initialReport(resumed)).rejects.toThrow("same clean source commit and asset identity");
    expect(await Bun.file(join(output, "TABLE.json")).text()).toBe(saved);
  });
});

async function withDriver(transport: Transport, action: (endpoint: string, timeouts: unknown[]) => Promise<void>): Promise<void> {
  const timeouts: unknown[] = [];
  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? object(await request.json()) : {};
    if (path === "/session") return Response.json({ value: { sessionId: "deadline-unit", capabilities: { browserName: "Safari", platformName: "macOS", transport: "unit-fixture" } } });
    if (path.endsWith("/timeouts")) { timeouts.push(body); return Response.json({ value: null }); }
    if (path.endsWith("/window") && request.method === "GET") return Response.json({ value: "host" });
    if (path.endsWith("/window/new")) return Response.json({ value: { handle: "preview" } });
    if (path.endsWith("/url")) await transport.navigate(String(body.url));
    if (path.endsWith("/execute/async")) return evaluation(body);
    return Response.json({ value: null });
  }
  async function evaluation(body: Record<string, unknown>): Promise<Response> {
    const args = body.args;
    if (!Array.isArray(args) || typeof args[0] !== "string") throw new Error("Invalid fixture evaluation");
    try { return Response.json({ value: { ok: true, json: JSON.stringify((await transport.evaluate(args[0])) ?? null) } }); }
    catch (error) { return Response.json({ value: { ok: false, message: String(error) } }); }
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: route });
  try { await action(server.url.href, timeouts); }
  finally { await server.stop(true); }
}
async function stageUnitHost(root: string, framework: string): Promise<void> {
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const builds = JSON.stringify({ "bun-browser.wasm": new Bun.CryptoHasher("sha256").update(wasm).digest("hex") });
  await writeFile(join(root, "bun-browser.wasm"), wasm);
  await writeFile(join(root, "engine-builds.json"), builds);
  await writeFile(join(root, "index.html"), `globalThis.__bunwasmBuilds=${builds};`);
  await writeFile(join(root, "goals-host-source.json"), JSON.stringify({ commit: "0".repeat(40), dirty: true }));
  await writeFile(join(root, `${framework}.json`), "{}");
}
test.each(["nuxt", "astro"])("the real runner and WebDriver transport apply the override only to %s's install in a local unit fixture", async id => {
  const framework = frameworks.find(item => item.id === id);
  if (!framework) throw new Error("Missing framework fixture");
  await withPlayground(framework, 300, transport => withDriver(transport, (endpoint, timeouts) => runFixture(framework.id, endpoint, timeouts)));
});
async function runFixture(framework: string, endpoint: string, timeouts: unknown[]): Promise<void> {
  await withReportRoot(async (root, output) => {
    await stageUnitHost(root, framework);
    const config = options(["--asset-source=unit-fixture-not-acceptance", `--root=${root}`, `--output=${output}`, "--timeout-ms=200", "--install-timeout-ms=nuxt:900", "--browsers=safari", "--engines=browser", `--frameworks=${framework}`, `--safari-endpoint=${endpoint}`]);
    const report = await run(config);
    const cell = report.cells.find(cell => cell.framework === framework && cell.browser === "safari" && cell.engine === "browser");
    expect(cell).toMatchObject(framework === "nuxt" ? { status: "pass" } : { status: "fail", phase: "install", error: expect.stringContaining("200 ms") });
    expect(cell?.attempts[0]?.phases.find(phase => phase.phase === "install")?.timeoutMs).toBe(framework === "nuxt" ? 900 : 200);
    expect(timeouts).toEqual([{ script: 200, pageLoad: 200, implicit: 0 }]);
    const resource = report.resources?.[0];
    if (!resource) throw new Error("Missing owned server receipt");
    expect(resource.stopped).toBe(true);
    expect(() => process.kill(resource.pid, 0)).toThrow();
  });
}

test("historical reports without deadline evidence are rejected, never rewritten for a new policy", async () => {
  await withReportRoot(async (root, output) => {
    await mkdir(output);
    const historical = JSON.stringify({ ...sampleReport(), schema: 1, deadlines: undefined });
    await writeFile(join(output, "TABLE.json"), historical);
    const config = options(campaign.concat(override, `--root=${root}`, `--output=${output}`, "--resume"));
    await expect(initialReport(config)).rejects.toThrow("Unknown report schema");
    expect(await Bun.file(join(output, "TABLE.json")).text()).toBe(historical);
  });
});
