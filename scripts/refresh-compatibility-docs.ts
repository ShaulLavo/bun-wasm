import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Status = "pass" | "fail" | "blocked";
type Stage = { app: string; engine: string; host: string; stage: string; status: Status; blocker: string };
const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Use --check or no arguments");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Expected a nonnegative integer");
  return value;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(root + path, "utf8"));
}

function stage(value: unknown): Stage {
  const row = record(value);
  const status = string(row.status);
  if (status !== "pass" && status !== "fail" && status !== "blocked") throw new Error(`Unexpected status ${status}`);
  return { app: string(row.app), engine: string(row.engine), host: string(row.host), stage: string(row.stage), status, blocker: row.blocker === undefined ? "-" : string(row.blocker) };
}

function matrix(path: string) {
  const data = record(json(path));
  const rows = array(data.results).map(stage).filter(row => row.engine !== "reference");
  const keys = new Set(rows.map(row => `${row.app}/${row.engine}/${row.host}/${row.stage}`));
  if (keys.size !== rows.length) throw new Error(`Duplicate stages in ${path}`);
  return { path, rows, provenance: record(data.provenance) };
}

function totals(rows: readonly Stage[]) {
  const counts = { pass: 0, fail: 0, blocked: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}

function countCells(rows: readonly Stage[]): string[] {
  const counts = totals(rows);
  return [String(counts.pass), String(counts.fail), String(counts.blocked)];
}

function countText(rows: readonly Stage[]): string {
  const counts = totals(rows);
  return `${counts.pass} pass / ${counts.fail} fail / ${counts.blocked} blocked`;
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell => cell.replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---"))].concat(rows.map(line)).join("\n");
}

function write(path: string, text: string) {
  if (readFileSync(root + path, "utf8") === text) return;
  if (check) throw new Error(`${path} is stale; run bun scripts/refresh-compatibility-docs.ts`);
  writeFileSync(root + path, text);
}

function section(path: string, name: string, text: string) {
  const contents = readFileSync(root + path, "utf8");
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const first = contents.indexOf(start);
  const last = contents.indexOf(end);
  if (first === -1 || last < first || contents.indexOf(start, first + 1) !== -1) throw new Error(`Invalid ${name} markers in ${path}`);
  write(path, contents.slice(0, first) + start + "\n" + text.trim() + "\n" + contents.slice(last));
}

const evidence = "docs/app-matrix/measurements/2026-10-17/";
const before = matrix(evidence + "before.json");
const after = matrix(evidence + "after.json");
const recording = matrix(evidence + "recording.json");
const selection = (rows: readonly Stage[]) => rows.map(row => `${row.app}/${row.engine}/${row.host}/${row.stage}`).sort();
if (JSON.stringify(selection(before.rows)) !== JSON.stringify(selection(after.rows))) throw new Error("App replay selections differ");
for (const run of [recording, after]) {
  const registry = record(run.provenance.registry);
  if (array(registry.misses).length || array(registry.errors).length) throw new Error(`${run.path} has registry misses or errors`);
}

const apps = Array.from(new Set(after.rows.map(row => row.app))).sort();
const appRows = apps.map(app => {
  const rows = after.rows.filter(row => row.app === app);
  const first = rows.find(row => row.status === "fail");
  const blocker = first ? `${first.engine}/${first.host}/${first.stage}: ${first.blocker}` : "-";
  return [app].concat(countCells(rows), [blocker]);
});
appRows.push(["Overall"].concat(countCells(after.rows), ["-"]));
const scopes = ["native", "playground"];
const scopeRows = scopes.map(host => [host, countText(before.rows.filter(row => row.host === host)), countText(after.rows.filter(row => row.host === host))]);
scopeRows.push(["All stages", countText(before.rows), countText(after.rows)]);
const engineRows = ["quickjs", "jsc", "browser"].flatMap(engine => scopes.map(host => [engine, host].concat(countCells(after.rows.filter(row => row.engine === engine && row.host === host)))));
const mirrorBlocks = before.rows.filter(row => row.status === "blocked" && row.blocker.includes("/esbuild-wasm")).length;
const appProvenance = [before, recording, after].map(run => [run.path.split("/").at(-1) ?? run.path, string(run.provenance.revision), createHash("sha256").update(readFileSync(root + run.path)).digest("hex")]);
const artifactRows = ["quickjs", "jsc", "browser"].map(engine => [engine, string(record(before.provenance.artifacts)[engine]), string(record(after.provenance.artifacts)[engine])]);
section("docs/app-matrix/README.md", "replay", [
  "## Current full replay after mirror recording",
  "The recording and corrected offline replay have zero registry misses and zero registry errors. Counts below exclude the recording's native Bun controls.",
  table(["App", "Pass", "Fail", "Blocked", "First blocker"], appRows),
  table(["Engine", "Host", "Pass", "Fail", "Blocked"], engineRows),
  table(["Scope", "Before recording", "Corrected offline replay"], scopeRows),
  `The original replay had ${totals(before.rows).blocked} blocked stages. Of those, ${mirrorBlocks} were blocked by missing esbuild-wasm records. The corrected replay has ${totals(after.rows).blocked} prerequisite blocks, from Next builds and Prisma installs. Missing diagnostics identify an unresolved failure, not a proven cause.`,
  "### Provenance",
  "These tables are generated from the committed raw JSON snapshots. Each snapshot is byte-identical to the retained results.json. The suite artifacts were built at runtime commit `6e93c80c6f9bccc879990bedb999c3efdcd3166f`. The app snapshots record their checkout revisions below, including the docs-only checkout `ec213e8ee326336f31feea9ef5763e793b9e2d60` used for the corrected replay. App artifact hashes changed between replays. These runs establish app outcomes for the recorded artifacts, not an isolated runtime before/after improvement.",
  table(["Snapshot", "Recorded checkout revision", "Raw JSON SHA-256"], appProvenance),
  table(["Engine", "Original replay wasm SHA-256", "Corrected replay wasm SHA-256"], artifactRows),
  `Corrected registry digest: \`${string(record(after.provenance.registry).sha256)}\`.`,
  "Regenerate or check every table in this section, and the suite headline and progress tables, with:",
  "```sh\nbun scripts/refresh-compatibility-docs.ts\nbun scripts/refresh-compatibility-docs.ts --check\n```",
].join("\n\n"));

const summary = record(json("docs/bun-test-suite/summary.json"));
const historical = record(json("docs/bun-test-suite/historical-summary.json"));
const oldQuickjs = record(historical.summary);
const currentQuickjs = record(summary.summary);
const quickjsChange = `QuickJS ${number(oldQuickjs.fully_passing)} → ${number(currentQuickjs.fully_passing)}`;
const history = array(json("docs/bun-test-suite/progress.json")).map(record);
const categories = ["a", "b", "c", "d", "e", "f"];
const historyRows = history.map(row => [string(row.date), string(row.commit), String(number(row.fully_passing)), String(number(row.tests_passing)), String(number(row.timeouts))].concat(categories.map(key => String(number(record(row.categories)[key])))));
section("docs/bun-test-suite/README.md", "progress", [
  "## Progress",
  `${quickjsChange} is the sole comparable baseline by matched file selection. JSC and browser are non-comparable because their selections changed. Changed runner, suite, and supplemental-dependency hashes prevent an isolated runtime-gain claim for any engine.`,
  table(["Date", "Runtime commit", "Files fully passing", "Tests passing", "Timeouts"].concat(categories), historyRows),
  "Category counts use each run's classifier. Category movement alone is not a compatibility gain.",
].join("\n\n"));

summary.previous_baseline ??= {};
summary.before_after ??= {};
const previousBaseline = record(summary.previous_baseline);
const beforeAfter = record(summary.before_after);
for (const engine of ["quickjs", "jsc", "browser"]) {
  previousBaseline[engine] ??= {};
  beforeAfter[engine] ??= {};
  const prior = record(previousBaseline[engine]);
  const comparison = record(beforeAfter[engine]);
  const old = record(engine === "quickjs" ? historical.summary : record(historical.comparison)[engine]);
  const current = record(engine === "quickjs" ? summary.summary : record(summary.comparison)[engine]);
  const status = engine === "quickjs" ? "comparable" : "non-comparable";
  const scope = engine === "quickjs" ? "same-selection baseline" : "different selections";
  const reason = (engine === "quickjs" ? `QuickJS is the sole matched-selection baseline, with ${number(current.files).toLocaleString("en-US")} files on both sides. ` : "Historical selection covered only js/bun, js/node, and js/web; current selection covers all files. ") + "Runner hash, suite revision, and supplemental dependency hash changed, preventing an isolated runtime-gain claim.";
  prior.fully_passing = number(old.fully_passing);
  prior.observed_passes = number(record(old.counts).pass);
  prior.timeouts = number(old.timeouts);
  prior.comparison_status = status;
  prior.comparison_scope = scope;
  prior.reason = reason;
  prior.selected_files = number(old.files);
  prior.selection = engine === "quickjs" ? ["**"] : ["js/bun", "js/node", "js/web"];
  prior.provenance = engine === "quickjs" ? historical.provenance : record(historical.comparison_provenance)[engine];
  comparison.comparison_status = status;
  comparison.comparison_scope = scope;
  comparison.selected_files = [number(old.files), number(current.files)];
  comparison.reason = reason;
  comparison.fully_passing = [number(old.fully_passing), number(current.fully_passing)];
  comparison.observed_passes = [number(record(old.counts).pass), number(record(current.counts).pass)];
  comparison.timeouts = [number(old.timeouts), number(current.timeouts)];
}
write("docs/bun-test-suite/summary.json", JSON.stringify(summary, null, 2) + "\n");
const headlineRows = ["quickjs", "jsc", "browser"].map(engine => {
  const old = record(engine === "quickjs" ? historical.summary : record(historical.comparison)[engine]);
  const current = record(engine === "quickjs" ? summary.summary : record(summary.comparison)[engine]);
  const result = (run: Record<string, unknown>) => `${number(run.fully_passing)} fully passing files; ${number(record(run.counts).pass)} observed passes; ${number(run.timeouts)} timeouts`;
  return [engine, String(number(old.files)), String(number(current.files)), result(old), result(current), engine === "quickjs" ? "Comparable baseline (matched selection)" : "Non-comparable"];
});
section("docs/bun-test-suite/README.md", "history-comparison", [
  "## Historical and current observations",
  `${quickjsChange} is the sole comparable baseline by matched file selection, with all ${number(currentQuickjs.files).toLocaleString("en-US")} files selected on both sides. JSC and browser are non-comparable. They previously selected ${number(record(record(historical.comparison).jsc).files).toLocaleString("en-US")} files under js/bun, js/node, and js/web, while each current run selected all ${number(currentQuickjs.files).toLocaleString("en-US")} files. Runner, suite, and supplemental-dependency hashes changed on all engines, so the matched QuickJS selection does not establish an isolated runtime gain.`,
  table(["Engine", "Historical selected files", "Current selected files", "Historical result", "Current result", "Comparison"], headlineRows),
  table(["Input on all engines", "Historical", "Current"], [
    ["Suite revision", string(record(historical.provenance).suite_commit), string(record(summary.provenance).suite_commit)],
    ["Runner SHA-256", string(record(historical.provenance).runner_sha256), string(record(summary.provenance).runner_sha256)],
    ["Supplemental dependency files", String(number(record(record(historical.provenance).test_dependencies).files)), String(number(record(record(summary.provenance).test_dependencies).files))],
    ["Supplemental dependency SHA-256", string(record(record(historical.provenance).test_dependencies).sha256), string(record(record(summary.provenance).test_dependencies).sha256)],
    ["Root dependency SHA-256", string(record(record(historical.provenance).dependencies).sha256), string(record(record(summary.provenance).dependencies).sha256)],
    ["File deadline / test deadline", "15 seconds / 2,000 ms", "15 seconds / 2,000 ms"],
  ]),
  "The historical inputs are preserved in [historical-summary.json](historical-summary.json). The current inputs are in [summary.json](summary.json). No historical artifact was rerun with the current runner and dependencies. Regenerate these tables with `bun scripts/refresh-compatibility-docs.ts`; `--check` rejects stale tables.",
].join("\n\n"));

process.stdout.write(`Compatibility tables ${check ? "verified" : "refreshed"} from raw JSON.\n`);
