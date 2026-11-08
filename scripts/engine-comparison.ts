import { labelsForHost, loadArmRegistry, parseArmRegistry, verifyMeasurementInput, type ArmRegistry } from "./engine-arm-registry.ts";
import { censusArms, censusChild, verifyCensusProvenance, type ChromiumSample } from "./app-matrix/engine-arms.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { productApps } from "./app-matrix/product.ts";
import { completeObservations } from "./app-matrix/product-browser.ts";
import { networkGuardStage } from "./app-matrix/product-campaign.ts";
import { record } from "./guest-core-receipt.ts";
import { distribution, engineOrder } from "./bench-engines.ts";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
type ExpectedApp = { id: string; stages: string[] };
type Host = "native" | "playground";
type StageRow = { app: string; engine: string; host: string; stage: string; status: "pass" | "fail" | "blocked"; durationMs: number | null };
type MatrixReport = { provenance: Record<string, unknown>; launcherSha256: string | null; rows: StageRow[] };
type Outcome = StageRow["status"] | "not-run" | "measurement-error";

export function registerCensus(ids: readonly string[], host: Host, rounds: number) {
  const selectedEngines = labelsForHost(host === "native" ? "native" : "chromium");
  const balancedRounds = host === "native" ? 4 : 10;
  assert.ok(rounds === 1 || rounds % balancedRounds === 0, `use one experimental census or complete ${balancedRounds}-round blocks`);
  assert.ok(ids.length && new Set(ids).size === ids.length, "choose unique app IDs");
  assert.ok(ids.every(id => productApps.some(app => app.id === id)), "unknown product app");
  const selected = productApps.filter(app => ids.includes(app.id));
  const apps = selected.map(app => ({ id: app.id, stages: ["install"].concat(app.commands.flatMap(command => [command.name].concat(
    completeObservations(command.check, [], { status: "not-run" }).map(probe => `${command.name}:${probe.stage}`),
  ))) }));
  const order = Array.from({ length: rounds }, (_, round) => engineOrder(selectedEngines.map(name => ({ name, path: "" })), round).map(engine => engine.name));
  return { schemaVersion: 1, kind: "experimental-app-census", registeredAt: new Date().toISOString(), host, rounds, engines: selectedEngines, apps,
    fixturesSha256: hash(JSON.stringify(selected)), order,
    denominator: "all registered cells; blocked and not-run stay in denominator; native reference excluded", sourceCatalog: selected };
}

export function parseMatrixReport(value: unknown): MatrixReport {
  assert.ok(record(value) && record(value.provenance) && Array.isArray(value.results), "invalid matrix report");
  const launcherSha256 = value.provenance.launcher_sha256;
  assert.ok(launcherSha256 === undefined || launcherSha256 === null || typeof launcherSha256 === "string" && /^[a-f0-9]{64}$/.test(launcherSha256), "invalid launcher hash");
  const rows = value.results.map((row: unknown): StageRow => {
    assert.ok(record(row) && typeof row.app === "string" && typeof row.engine === "string" && typeof row.host === "string" && typeof row.stage === "string", "invalid matrix cell");
    assert.ok(row.status === "pass" || row.status === "fail" || row.status === "blocked", "invalid matrix status");
    assert.ok(row.durationMs === undefined || row.durationMs === null || (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0), "invalid stage duration");
    return { app: row.app, engine: row.engine, host: row.host, stage: row.stage, status: row.status, durationMs: typeof row.durationMs === "number" ? row.durationMs : null };
  });
  return { provenance: value.provenance, launcherSha256: typeof launcherSha256 === "string" ? launcherSha256 : null, rows };
}

function outcome(rows: readonly StageRow[], app: string, stage: string): { status: Outcome; durationMs: number | null } {
  const found = rows.filter(row => row.app === app && row.stage === stage);
  assert.ok(found.length <= 1, `duplicate matrix cell ${app}/${stage}`);
  if (rows.some(row => row.app === app && row.stage === networkGuardStage)) return { status: "measurement-error", durationMs: null };
  const row = found[0];
  return { status: row?.status ?? "not-run", durationMs: row?.status === "pass" ? row.durationMs : null };
}

function counts(outcomes: readonly Outcome[]) {
  const pass = outcomes.filter(status => status === "pass").length;
  const fail = outcomes.filter(status => status === "fail").length;
  return { expected: outcomes.length, pass, fail, blocked: outcomes.filter(status => status === "blocked").length,
    notRun: outcomes.filter(status => status === "not-run").length, measurementError: outcomes.filter(status => status === "measurement-error").length,
    passRate: outcomes.length ? pass / outcomes.length : null, executedPassRate: pass + fail ? pass / (pass + fail) : null };
}

function appOutcome(outcomes: readonly Outcome[]): Outcome {
  for (const status of ["fail", "measurement-error", "blocked", "not-run"] satisfies Outcome[]) if (outcomes.includes(status)) return status;
  return "pass";
}

export function reduceCensus(reports: readonly MatrixReport[], apps: readonly ExpectedApp[], host: Host, selectedEngines: readonly string[] = labelsForHost(host === "native" ? "native" : "chromium")) {
  return selectedEngines.map(engine => {
    const rows = reports.flatMap(report => report.rows).filter(row => row.engine === engine && row.host === host);
    const cells = apps.flatMap(app => app.stages.map(stage => ({ app: app.id, stage, ...outcome(rows, app.id, stage) })));
    return { engine, host, stages: counts(cells.map(cell => cell.status)),
      apps: counts(apps.map(app => appOutcome(cells.filter(cell => cell.app === app.id).map(cell => cell.status)))),
      cells: cells.map(cell => ({ ...cell, successfulTiming: distribution(cell.durationMs === null ? [] : [cell.durationMs]) })) };
  });
}

function parsePlan(value: unknown): { host: Host; rounds: number; fixturesSha256: string; apps: ExpectedApp[] } {
  assert.ok(record(value) && (value.schemaVersion === 1 || value.schemaVersion === 2) && value.kind === "experimental-app-census" && Array.isArray(value.apps), "invalid registered plan");
  assert.ok(value.host === "native" || value.host === "playground", "invalid host");
  assert.equal(value.rounds, 1, "reduce one round at a time");
  assert.ok(typeof value.fixturesSha256 === "string" && /^[a-f0-9]{64}$/.test(value.fixturesSha256), "invalid fixture digest");
  const apps = value.apps.map((app: unknown): ExpectedApp => {
    assert.ok(record(app) && typeof app.id === "string" && Array.isArray(app.stages) && app.stages.length && app.stages.every((stage: unknown) => typeof stage === "string"), "invalid expected cells");
    assert.equal(new Set(app.stages).size, app.stages.length, "duplicate expected stage");
    return { id: app.id, stages: app.stages };
  });
  assert.ok(apps.length && new Set(apps.map(app => app.id)).size === apps.length, "duplicate or empty expected apps");
  return { host: value.host, rounds: value.rounds, fixturesSha256: value.fixturesSha256, apps };
}

async function main() {
  const { values } = parseArgs({ options: {
    registry: { type: "string" }, register: { type: "boolean" }, apps: { type: "string" }, host: { type: "string", default: "playground" }, rounds: { type: "string", default: "1" },
    plan: { type: "string" }, report: { type: "string", multiple: true }, output: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Register: bun scripts/engine-comparison.ts --register --apps vite-react,hono,typescript,next-16-app --host playground --rounds 1 --output NEW-plan.json\nReduce one round: bun scripts/engine-comparison.ts --plan plan.json --report matrix/results.json --output NEW-summary.json");
    return;
  }
  assert.ok(values.output, "--output is required");
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  if (values.register) {
    assert.ok(values.host === "native" || values.host === "playground", "invalid host");
    assert.ok(values.registry, "current census registration requires --registry");
    assert.equal(Number(values.rounds), 1, "register one census round");
    const registry = await loadArmRegistry(resolve(values.registry));
    const plan = registerArmCensus(registry, values.apps?.split(",") ?? [], values.host);
    // The app runner consumes one admitted request with --census-plan and --arm.
    await writeFile(output, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    return;
  }
  assert.ok(values.plan, "--plan is required");
  const planBytes = await readFile(values.plan, "utf8");
  const planValue: unknown = JSON.parse(planBytes);
  assert.ok(record(planValue) && planValue.schemaVersion === 2, "current reduction requires an arm-aware plan");
  const registry = parseArmRegistry(planValue.armRegistry);
  await verifyMeasurementInput(registry);
  const plan = parsePlan(planValue);
  const inputs = await Promise.all((values.report ?? []).map(async path => {
    const bytes = await readFile(path, "utf8");
    const report = parseMatrixReport(JSON.parse(bytes));
    assert.equal(report.provenance.fixtures_sha256, plan.fixturesSha256, "matrix fixtures differ from registered plan");
    return { path: resolve(path), sha256: hash(bytes), report };
  }));
  const result = { scope: "experimental-app-census", defaultDecision: "owner-required", plan: { path: resolve(values.plan), sha256: hash(planBytes) },
    inputs, sizes: registrySizes(registry, plan.host === "native" ? "native" : "chromium"), round: reduceArmCensus(inputs.map(input => input.report), plan.apps, plan.host, registry),
    notes: ["Reduce one round at a time; duplicate cells are rejected", "Missing duration is null; only successful stage times are included", "Producer verifier and browser identity/noise review remain required; input provenance retained verbatim", "Guest memory stays in original reports/hook samples without summing overlapping counters"] };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });

export function registerArmCensus(registry: ArmRegistry, ids: readonly string[], host: Host) {
  const template = registerCensus(ids, host, 1);
  const measurementHost = host === "native" ? "native" : "chromium";
  const arms = censusArms(registry, measurementHost);
  return { ...template, schemaVersion: 2, armRegistry: registry, engines: arms.map(arm => arm.label),
    order: [arms.map(arm => arm.label)], children: arms.map(arm => censusChild(arm, measurementHost, {})),
    unavailableArms: host === "native" ? ["browser:unavailable-native"] : [], stageTimeoutMs: 90_000, replay: "offline-required", rounds: 1 };
}

export function reduceArmCensus(reports: readonly MatrixReport[], apps: readonly ExpectedApp[], host: Host, registry: ArmRegistry) {
  const arms = censusArms(registry, host === "native" ? "native" : "chromium");
  for (const report of reports) {
    const arm = arms.find(arm => arm.label === report.provenance.armLabel);
    assert.ok(arm, "report arm is not registered on this host");
    verifyCensusProvenance(report.provenance, registry, arm);
    assert.equal(report.launcherSha256, registry.launcher.sha256, "census report launcher differs");
    assert.ok(report.rows.every(row => row.engine === arm.label && row.host === host && apps.some(app => app.id === row.app && (app.stages.includes(row.stage) || row.stage === networkGuardStage))), "unexpected census cell");
  }
  return reduceCensus(reports, apps, host, arms.map(arm => arm.label));
}

export function registrySizes(registry: ArmRegistry, host: "native" | "chromium") {
  return censusArms(registry, host).map(arm => ({
    engine: arm.label, engineKind: arm.engineKind, tier: arm.tier,
    source: { head: arm.sourceCommit, tree: arm.sourceTree },
    qualification: registry.evidence === "synthetic" ? "synthetic-setup-only" : "admission-still-required",
    profile: arm.program.kind === "single" ? "browser-single" : "split",
    core: arm.program.core, gzip: arm.servedGzip.core,
    side: arm.program.kind === "single" ? null : arm.program.side,
    sideGzip: arm.servedGzip.kind === "single" ? null : arm.servedGzip.side,
    rawBytes: arm.program.core.bytes + (arm.program.kind === "single" ? 0 : arm.program.side.bytes),
    gzipBytes: arm.servedGzip.core.bytes + (arm.servedGzip.kind === "single" ? 0 : arm.servedGzip.side.bytes),
    commonCoreDeltaBytes: null, guestHeap: null, backingStores: null, swc: null, concurrentHeadroom: null,
  }));
}

export function reduceChromiumSamples(samples: readonly ChromiumSample[], registry: ArmRegistry, workloads: readonly string[]) {
  const labels = registry.chromiumArms.map(arm => arm.label);
  const cells = new Set<string>();
  for (const sample of samples) {
    assert.ok(labels.includes(sample.engine) && workloads.includes(sample.workload), "unregistered Chromium sample");
    assert.ok(Number.isSafeInteger(sample.round) && sample.round >= 0 && sample.round < registry.chromiumRounds, "unregistered Chromium round");
    const key = `${sample.engine}/${sample.workload}/${sample.round}`;
    assert.ok(!cells.has(key), "duplicate Chromium sample");
    cells.add(key);
  }
  return labels.flatMap(engine => workloads.map(workload => {
    const rows = samples.filter(sample => sample.engine === engine && sample.workload === workload);
    const passed = rows.filter(row => row.status === "pass");
    return { engine, workload, ...counts(rows.map<Outcome>(row => row.status).concat(Array<Outcome>(registry.chromiumRounds - rows.length).fill("not-run"))),
      wallMs: distribution(passed.flatMap(row => row.wallMs === null ? [] : [row.wallMs])),
      compileMs: distribution(passed.flatMap(row => row.compileMs === null ? [] : [row.compileMs])) };
  }));
}
