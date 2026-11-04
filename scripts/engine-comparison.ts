import type { Engine } from "../src/engine-kind.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { productApps } from "./app-matrix/product.ts";
import { completeObservations } from "./app-matrix/product-browser.ts";
import { networkGuardStage } from "./app-matrix/product-campaign.ts";
import { record } from "./guest-core-receipt.ts";
import { distribution, engineOrder } from "./bench-engines.ts";

const engines: readonly Exclude<Engine, "browser">[] = ["quickjs", "jsc"];
const root = resolve(import.meta.dirname, "..");
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
type ExpectedApp = { id: string; stages: string[] };
type Host = "native" | "playground";
type StageRow = { app: string; engine: string; host: string; stage: string; status: "pass" | "fail" | "blocked"; durationMs: number | null };
type MatrixReport = { provenance: Record<string, unknown>; rows: StageRow[] };
type Outcome = StageRow["status"] | "not-run" | "measurement-error";

export function registerCensus(ids: readonly string[], host: Host, rounds: number) {
  assert.ok(rounds === 1 || rounds === 6, "use one experimental census or six balanced rounds");
  assert.ok(ids.length && new Set(ids).size === ids.length, "choose unique app IDs");
  assert.ok(ids.every(id => productApps.some(app => app.id === id)), "unknown product app");
  const selected = productApps.filter(app => ids.includes(app.id));
  const apps = selected.map(app => ({ id: app.id, stages: ["install"].concat(app.commands.flatMap(command => [command.name].concat(
    completeObservations(command.check, [], { status: "not-run" }).map(probe => `${command.name}:${probe.stage}`),
  ))) }));
  const order = Array.from({ length: rounds }, (_, round) => engineOrder(engines.map(name => ({ name, path: "" })), round).map(engine => engine.name));
  return { schemaVersion: 1, kind: "experimental-app-census", registeredAt: new Date().toISOString(), host, rounds, engines, apps,
    fixturesSha256: hash(JSON.stringify(selected)), order,
    denominator: "all registered cells; blocked and not-run stay in denominator; native reference excluded", sourceCatalog: selected };
}

export function parseMatrixReport(value: unknown): MatrixReport {
  assert.ok(record(value) && record(value.provenance) && Array.isArray(value.results), "invalid matrix report");
  const rows = value.results.map((row: unknown): StageRow => {
    assert.ok(record(row) && typeof row.app === "string" && typeof row.engine === "string" && typeof row.host === "string" && typeof row.stage === "string", "invalid matrix cell");
    assert.ok(row.status === "pass" || row.status === "fail" || row.status === "blocked", "invalid matrix status");
    assert.ok(row.durationMs === undefined || row.durationMs === null || (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0), "invalid stage duration");
    return { app: row.app, engine: row.engine, host: row.host, stage: row.stage, status: row.status, durationMs: typeof row.durationMs === "number" ? row.durationMs : null };
  });
  return { provenance: value.provenance, rows };
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

export function reduceCensus(reports: readonly MatrixReport[], apps: readonly ExpectedApp[], host: Host) {
  return engines.map(engine => {
    const rows = reports.flatMap(report => report.rows).filter(row => row.engine === engine && row.host === host);
    const cells = apps.flatMap(app => app.stages.map(stage => ({ app: app.id, stage, ...outcome(rows, app.id, stage) })));
    return { engine, host, stages: counts(cells.map(cell => cell.status)),
      apps: counts(apps.map(app => appOutcome(cells.filter(cell => cell.app === app.id).map(cell => cell.status)))),
      cells: cells.map(cell => ({ ...cell, successfulTiming: distribution(cell.durationMs === null ? [] : [cell.durationMs]) })) };
  });
}

function parsePlan(value: unknown): { host: Host; rounds: 1 | 6; fixturesSha256: string; apps: ExpectedApp[] } {
  assert.ok(record(value) && value.schemaVersion === 1 && value.kind === "experimental-app-census" && Array.isArray(value.apps), "invalid registered plan");
  assert.ok(value.host === "native" || value.host === "playground", "invalid host");
  assert.ok(value.rounds === 1 || value.rounds === 6, "invalid rounds");
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
    register: { type: "boolean" }, apps: { type: "string" }, host: { type: "string", default: "playground" }, rounds: { type: "string", default: "1" },
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
    const plan = registerCensus(values.apps?.split(",") ?? [], values.host, Number(values.rounds));
    const commands = plan.order.map((order, round) => ["bash", join(root, "scripts/app-matrix.sh"), "--product", `--apps=${plan.apps.map(app => app.id).join(",")}`, `--engines=${order.join(",")}`, `--hosts=${plan.host}`, "--cache=/work/cache/bun-wasm-app-matrix", `--output=${join(dirname(output), `round-${round}`)}`]);
    await writeFile(output, JSON.stringify({ ...plan, commands }, null, 2) + "\n", { flag: "wx" });
    return;
  }
  assert.ok(values.plan, "--plan is required");
  const planBytes = await readFile(values.plan, "utf8");
  const plan = parsePlan(JSON.parse(planBytes));
  const inputs = await Promise.all((values.report ?? []).map(async path => {
    const bytes = await readFile(path, "utf8");
    const report = parseMatrixReport(JSON.parse(bytes));
    assert.equal(report.provenance.fixtures_sha256, plan.fixturesSha256, "matrix fixtures differ from registered plan");
    return { path: resolve(path), sha256: hash(bytes), report };
  }));
  const result = { scope: "experimental-app-census", defaultDecision: "owner-required", plan: { path: resolve(values.plan), sha256: hash(planBytes) },
    inputs, round: reduceCensus(inputs.map(input => input.report), plan.apps, plan.host),
    notes: ["Reduce one round at a time; duplicate cells are rejected", "Missing duration is null; only successful stage times are included", "Producer verifier and browser identity/noise review remain required; input provenance retained verbatim", "Guest memory stays in original reports/hook samples without summing overlapping counters"] };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
