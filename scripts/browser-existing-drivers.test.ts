import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coverageFixture } from "./browser-guest-coverage-fixture";
import { ownerEngines, rowIdentity, type BrowserGuestSelection, type CoverageEngine, type CoverageLeg } from "./browser-guest-catalogue";
import { executeExistingBrowserDriver, existingDriverCommand, existingDriverEvidence } from "./browser-existing-drivers";
import { withBrowserGuestRegression } from "./browser-guest-wrapper";
import { browserGuestManifest } from "./browser-guest-selection";
import { discoverChecks } from "./test-checks";
import { hash } from "./guest-source-manifest";

const cleanup = new Set<string>();
afterEach(() => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); cleanup.clear(); });
const owners = ["installer-links", "subprocess", "preview-websocket", "tools-integrity"] as const;
type Owner = typeof owners[number];
const driverNames = { "installer-links": "browser-installer-links.ts", subprocess: "browser-subprocess.ts", "preview-websocket": "browser-net.mjs", "tools-integrity": "browser-tools.ts" };

function success(owner: Owner, leg: CoverageLeg, engine: CoverageEngine, programs: ReadonlyMap<string, Uint8Array>): string[] {
  if (owner === "installer-links") return [`ok ${leg}/${engine}: bin warnings, lock, bun run, script, bunx, fatal non-link error`, "1 passed, 0 failed"];
  if (owner === "preview-websocket") return [`ok   ${leg}/${engine}: preview WebSocket preserves browser Origin and Host`,
    `ok   ${leg}/${engine}: preview gone after foreground teardown`, `ok   ${leg}/${engine}: no page errors`, "all passed"];
  if (owner === "subprocess") return [`ok ${leg} ${engine} #1: Bun/Node subprocess APIs, nested workers, large stdin, cwd, files, timeout`,
    `ok ${leg} ${engine}: current executable survives missing or cross-engine PATH in spawn, fork and Worker`,
    `ok ${leg} ${engine}: invalid stdin conversion, synchronous EPIPE and Node stdin destroy EOF`,
    `ok ${leg} ${engine}: configuration capacity, limits, ancestry, cwd and cleanup`,
    `ok ${leg} ${engine}: closed child stdout/stderr reports EPIPE and exits`,
    `ok ${leg} ${engine}: pipe-write-order.ts`, `ok ${leg} ${engine}: pipe-stdin-race.ts`,
    `ok ${leg} ${engine}: isolated Worker guests, transfers, lifecycle, nested workers, termination and stdio`];
  const tools = programs.get("bun-tools.wasm"), qjs = programs.get("bun.wasm");
  if (!tools || !qjs) throw new Error("Control missing tools closure");
  return [JSON.stringify({ coverage: "tools-integrity", phase: "wrong-payload", browser: leg, engine, exit: 126,
    expected: hash(tools), received: hash(qjs), compileCount: 0, cacheHit: false }),
  JSON.stringify({ coverage: "tools-integrity", phase: "complete", browser: leg, engine })];
}
async function fixture(owner: Owner, leg: CoverageLeg, engines = ownerEngines(owner)) {
  const selection: BrowserGuestSelection = [{ owner, engines }], site = await coverageFixture(cleanup, selection);
  const artifact = await site.prepare();
  const directory = mkdtempSync("/work/tmp/bun-wasm-adapter-"); cleanup.add(directory);
  const repository = join(directory, "drivers"), reports = join(directory, "reports");
  mkdirSync(join(repository, "web/tests"), { recursive: true });
  const outputs = Object.fromEntries(engines.map(engine => [engine, success(owner, leg, engine, artifact.programs)]));
  // Generated small driver, never a guest or browser. The production adapter supervises it unchanged.
  const code = `import {readFileSync,writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nconst engine=args.find(a=>a.startsWith('--engine='))?.slice(9)??process.env.ENGINES;\nconst outputs=${JSON.stringify(outputs)};\nwriteFileSync(new URL('../'+engine+'.json',import.meta.url),JSON.stringify({args,root:process.env.ROOT,tmp:process.env.BUN_WASM_TEST_TMP}));\nfor(const line of outputs[engine])console.log(line);\nconsole.log('x'.repeat(70000));\nif(engine===process.env.CONTROL_FAIL_ENGINE)process.exitCode=7;\n`;
  writeFileSync(join(repository, "web/tests", driverNames[owner]), code);
  return { artifact, repository, reports, env: { PATH: process.env.PATH, BUN_WASM_BROWSER_COVERAGE_SELECTION: JSON.stringify(selection),
    BUN_WASM_TEST_BROWSERS: leg, BUN_WASM_BROWSER_SITE: site.out, BUN_WASM_BROWSER_COVERAGE_REPORTS: reports } };
}
function ledger(reports: string) {
  const name = readdirSync(reports)[0]; if (!name) throw new Error("Missing retained ledger");
  const directory = join(reports, name);
  return { directory, value: JSON.parse(readFileSync(join(directory, "rows.json"), "utf8")) };
}

for (const owner of owners) {
  for (const leg of ["chromium", "webkit"] as const) {
    test(`${owner}/${leg} executes only explicit engines, full original argv and complete evidence through supervisor`, async () => {
      const fixtureData = await fixture(owner, leg);
      await withBrowserGuestRegression({ owner, controls: () => [], execute: context => executeExistingBrowserDriver(owner, { ...context, repository: fixtureData.repository }) }, fixtureData.env);
      const { directory, value } = ledger(fixtureData.reports);
      expect(value.rows.every((row: { status: string }) => row.status === "passed")).toBe(true);
      expect(value.expected).toHaveLength(ownerEngines(owner).length);
      for (const engine of ownerEngines(owner)) checkInvocation(owner, leg, engine, fixtureData);
      expect(statSync(join(directory, "child-0.log")).size).toBe(65_536);
      expect(readFileSync(join(directory, "child-0.log"), "utf8")).not.toContain("ok ");
      expect(JSON.parse(readFileSync(join(directory, "ownership.json"), "utf8")).status).toBe("removed");
    }, 30_000);
  }
}
function checkInvocation(owner: Owner, leg: CoverageLeg, engine: CoverageEngine, data: Awaited<ReturnType<typeof fixture>>) {
  const invocation = JSON.parse(readFileSync(join(data.repository, "web", engine + ".json"), "utf8"));
  const args: string[] = [leg];
  if (owner === "subprocess") args.push(`--engine=${engine}`, "--repeat=1");
  if (owner === "tools-integrity") args.push(`--engine=${engine}`, `--root=${data.artifact.site}`);
  expect(invocation.args).toEqual(args);
  expect(invocation.root).toBe(data.artifact.site);
  expect(existsSync(invocation.tmp)).toBe(false);
}

test("failed engine remains red while independent selected engines continue after proven drain", async () => {
  const data = await fixture("subprocess", "chromium");
  await expect(withBrowserGuestRegression({ owner: "subprocess", controls: () => [], execute: context => executeExistingBrowserDriver("subprocess", { ...context, repository: data.repository }) },
    { ...data.env, CONTROL_FAIL_ENGINE: "browser" })).rejects.toThrow();
  const { value } = ledger(data.reports);
  expect(value.children).toHaveLength(3);
  expect(value.children.every((child: { cleanup: { kind: string } }) => child.cleanup.kind === "drained")).toBe(true);
  expect(value.rows.map((row: { status: string }) => row.status)).toEqual(["passed", "passed", "failed"]);
}, 30_000);

test("marker validation rejects every missing continuation and tools negative mismatch", async () => {
  for (const owner of owners) await checkMissingMarkers(owner);
}, 30_000);
async function checkMissingMarkers(owner: Owner) {
  const data = await fixture(owner, "chromium", ["browser"]);
  await withBrowserGuestRegression({ owner, controls: () => [], execute: async context => {
    const log = join(context.scratch, "markers.log"), lines = success(owner, context.leg, "browser", context.artifact.programs);
    for (let missing = 0; missing < lines.length; missing++) {
      writeFileSync(log, lines.filter((_, index) => index !== missing).join("\n"));
      expect(existingDriverEvidence(owner, context, "browser", log).every(row => row.status === "not-run")).toBe(true);
    }
    writeFileSync(log, lines.join("\n").replace('"exit":126', '"exit":0'));
    if (owner === "tools-integrity") expect(existingDriverEvidence(owner, context, "browser", log)[0]?.status).toBe("not-run");
    expect(() => existingDriverCommand(owner, context, "jsc")).toThrow("Unselected");
    const request = existingDriverCommand(owner, context, "browser");
    await context.regression.runChild({ ...request, command: [process.execPath, "-e", `console.log(${JSON.stringify(lines.join("\n"))})`], rows: context.regression.expected,
      signal: context.signal, evidence: result => existingDriverEvidence(owner, context, "browser", result.log) });
    expect(context.regression.expected.map(rowIdentity)).toHaveLength(1);
  } }, data.env);
}

test("four manifests retain foundation inputs and discover each wrapper exactly once", () => {
  const checks = discoverChecks(join(import.meta.dir, ".."));
  for (const owner of owners) {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../checks", `browser-guest-${owner}.json`), "utf8"));
    const original = browserGuestManifest(owner);
    expect(manifest).toEqual({ ...original, inputs: original.inputs.concat(["scripts/browser-guest-wrapper.ts", "scripts/browser-existing-drivers.ts"]) });
    expect(checks.filter(check => check.path === original.path)).toHaveLength(1);
  }
});

test("tools rejects invalid engine, root and narrowing options before browser setup", () => {
  for (const args of [["--engine=unknown"], ["--engine=browser", "--engine=jsc"], ["--root="], ["--api-only"], ["unknown-browser"]]) {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../web/tests/browser-tools.ts")].concat(args));
    expect(result.exitCode).toBe(1);
  }
});
