import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
const source = new URL("docs/bun-test-suite/category-d-first-errors.tsv", root);
const rows = parseTsv(readFileSync(source, "utf8")).slice(1).map(([file, test, error, cause]) => {
  if (!file || !test || !error || !cause) throw new Error(`Invalid first-blocker row: ${file}`);
  return { file, test, error, cause };
});
if (rows.length !== 720 || new Set(rows.map(row => row.file)).size !== 720) throw new Error("Expected 720 distinct baseline files");
const titles = record(JSON.parse(readFileSync(new URL("docs/bun-test-suite/category-d-causes.json", root), "utf8")));

function parseTsv(input: string): string[][] {
  const parsed: string[][] = [];
  let cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (character === '"' && quoted && input[i + 1] === '"') { value += '"'; i++; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === "\t") { cells.push(value); value = ""; continue; }
    if (!quoted && character === "\n") { parsed.push(cells.concat([value])); cells = []; value = ""; continue; }
    value += character;
  }
  if (quoted) throw new Error("Unterminated TSV field");
  if (cells.length || value) parsed.push(cells.concat([value]));
  return parsed;
}

function title(id: string): string {
  const value: unknown = Reflect.get(titles, id);
  if (typeof value !== "string") throw new Error(`Missing cause title: ${id}`);
  return value;
}

function groups(key: "error" | "cause") {
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const items = grouped.get(row[key]) || [];
    items.push(row);
    grouped.set(row[key], items);
  }
  return Array.from(grouped, ([id, members]) => ({ id, members })).sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
}

function table(headers: string[], data: string[][]): string {
  const row = (cells: string[]) => "| " + cells.map(cell => cell.replaceAll("|", "\\|")).join(" | ") + " |";
  return [row(headers), row(headers.map(() => "---"))].concat(data.map(row)).join("\n");
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a record");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Expected a count");
  return value;
}

function result(value: unknown) {
  const row = record(value);
  const counts = record(row.counts);
  if (typeof row.file !== "string" || typeof row.fully_passing !== "boolean" || typeof row.timed_out !== "boolean") throw new Error("Invalid suite result");
  return { file: row.file, fully_passing: row.fully_passing, timed_out: row.timed_out, counts: { pass: count(counts.pass), fail: count(counts.fail) } };
}

function loadRun(path: string) {
  const data = record(JSON.parse(readFileSync(path, "utf8")));
  if (!Array.isArray(data.results)) throw new Error("Missing suite results");
  return { provenance: record(data.provenance), results: data.results.map(result) };
}

function summarize(results: ReturnType<typeof result>[]) {
  return {
    files: results.length,
    fully_passing: results.filter(row => row.fully_passing).length,
    passed: results.reduce((sum, row) => sum + row.counts.pass, 0),
    failed: results.reduce((sum, row) => sum + row.counts.fail, 0),
    timeouts: results.filter(row => row.timed_out).length,
  };
}

function measurement(directory: string, engine: string) {
  const before = loadRun(join(directory, `path-before-${engine}.json`));
  const current = loadRun(join(directory, `full-after-${engine}.json`));
  const files = new Set(before.results.map(row => row.file));
  if (files.size !== 19 || before.results.length !== 19) throw new Error("Expected the 19-file path selection");
  const after = current.results.filter(row => files.has(row.file));
  if (after.length !== 19 || new Set(after.map(row => row.file)).size !== 19) throw new Error("Incomplete path replay");
  for (const key of ["suite_commit", "runner_sha256", "network", "timeout_seconds", "test_timeout_ms", "dependencies", "test_dependencies", "host_sources", "runtime_package", "node_parallel"]) {
    if (JSON.stringify(before.provenance[key]) !== JSON.stringify(current.provenance[key])) throw new Error(`${engine} input changed: ${key}`);
  }
  const previous = new Map(before.results.map(row => [row.file, row]));
  for (const row of after) {
    const old = previous.get(row.file);
    if (!old || old.fully_passing && !row.fully_passing || row.counts.pass < old.counts.pass || row.timed_out && !old.timed_out) throw new Error(`${engine} regression: ${row.file}`);
  }
  const provenance = (run: typeof before) => ({
    ...Object.fromEntries(Object.entries(run.provenance).filter(([key]) => !["host_sources", "runtime_package"].includes(key))),
    host_sources_sha256: createHash("sha256").update(JSON.stringify(run.provenance.host_sources)).digest("hex"),
    runtime_package_sha256: createHash("sha256").update(JSON.stringify(run.provenance.runtime_package)).digest("hex"),
  });
  return { engine, before: { provenance: provenance(before), summary: summarize(before.results), results: before.results }, after: { provenance: provenance(current), summary: summarize(after), results: after } };
}

const measurements = new URL("docs/bun-test-suite/category-d-path-results.json", root);
const resultsOption = process.argv.indexOf("--results");
if (resultsOption >= 0) {
  const directory = process.argv[resultsOption + 1];
  if (!directory || check) throw new Error("Use --results <report directory> without --check");
  const data = { source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), engines: ["quickjs", "jsc", "browser"].map(engine => measurement(directory, engine)) };
  writeFileSync(measurements, JSON.stringify(data, null, 2) + "\n");
}

const document = new URL("docs/bun-test-suite/category-d-runtime.md", root);
const original = readFileSync(document, "utf8");
let text = original;
function section(name: string, content: string) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const first = text.indexOf(start);
  const last = text.indexOf(end);
  if (first < 0 || last < first) throw new Error(`Missing ${name} section`);
  text = text.slice(0, first) + start + "\n" + content + "\n" + text.slice(last);
}

const errors = groups("error");
section("first-errors", table(["Recorded first error", "Files", "Example"], errors.map(group => [
  "`" + group.id.replaceAll("`", "'") + "`", String(group.members.length), "`" + group.members[0].file + "`",
])));
const causes = groups("cause");
for (const cause of causes) title(cause.id);
section("causes", table(["Baseline root cause", "Files", "Example"], causes.filter(group => group.members.length > 1).map(group => [
  title(group.id), String(group.members.length), "`" + group.members[0].file + "`",
])));
if (existsSync(measurements)) {
  const data = record(JSON.parse(readFileSync(measurements, "utf8")));
  if (!Array.isArray(data.engines)) throw new Error("Missing engine measurements");
  const rows = data.engines.map(value => {
    const engine = record(value);
    if (typeof engine.engine !== "string") throw new Error("Missing engine name");
    const before = record(record(engine.before).summary);
    const after = record(record(engine.after).summary);
    const pair = (key: string) => `${count(before[key])} / ${count(after[key])}`;
    return [engine.engine, pair("fully_passing"), pair("passed"), pair("failed"), pair("timeouts")];
  });
  section("measurements", table(["Engine", "Fully passing files before / after", "Observed passes before / after", "Failures before / after", "Timeouts before / after"], rows));
}
if (text !== original && check) throw new Error("Run node scripts/group-suite-category-d.ts");
if (text !== original) writeFileSync(document, text);
console.log(`${rows.length} files; ${errors.length} first-error groups; ${causes.length - 1} assigned root causes; ${rows.filter(row => row.cause === "unknown").length} require further diagnosis. ${check ? "Verified" : "Generated"}.`);
