import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inventory, boxId, type Box } from "./catalog";
import { validateArchive, recordedTime, type ArchivedReport } from "./archive";
import { finish, type Attempt, type PhaseResult, type Phase } from "./model";

type Observation = { input: number; cell: number };
type AttemptRef = Observation & { attempt: number };
type Outcome = { status: "unattempted" } | { status: "pass" } | { status: "fail"; phase: Phase; error: string };
interface ViewCell extends Box {
  observations: Observation[];
  attempts: AttemptRef[];
  latest: AttemptRef | null;
  overall: Outcome;
  install: PhaseResult | null;
}
interface Projection {
  kind: "bun-wasm-goals-view";
  resumable: false;
  inputs: { path: string; sha256: string; report: ArchivedReport }[];
  cells: ViewCell[];
}
function readInput(input: { path: string; contents: string }): Projection["inputs"][number] {
  const report: unknown = JSON.parse(input.contents);
  validateArchive(report);
  return { path: resolve(input.path), sha256: createHash("sha256").update(input.contents).digest("hex"), report };
}
function uniqueInputs(inputs: Projection["inputs"]): void {
  const paths = new Set<string>(), runs = new Set<string>();
  for (const input of inputs) {
    if (paths.has(input.path) || runs.has(input.report.run)) throw new Error(`Duplicate input identity: ${input.path}, run ${input.report.run}`);
    paths.add(input.path); runs.add(input.report.run);
  }
}
function getAttempt(inputs: Projection["inputs"], ref: AttemptRef): Attempt {
  const attempt = inputs[ref.input]?.report.cells[ref.cell]?.attempts[ref.attempt];
  if (!attempt) throw new Error("Missing referenced attempt");
  return attempt;
}
function compareAttempts(first: Attempt, second: Attempt): number {
  return recordedTime(first.finishedAt) - recordedTime(second.finishedAt) || recordedTime(first.startedAt) - recordedTime(second.startedAt);
}
function attemptedOutcome(box: Box, attempt: Attempt): Outcome {
  const result = finish(box, attempt);
  if (result.status === "fail") return { status: "fail", phase: result.phase, error: result.error };
  return { status: "pass" };
}
function projectCell(box: Box, inputs: Projection["inputs"]): ViewCell {
  const observations = inputs.flatMap((input, inputIndex) => input.report.cells.flatMap((cell, cellIndex) =>
    cell.framework === box.framework && cell.browser === box.browser && cell.engine === box.engine ? [{ input: inputIndex, cell: cellIndex }] : []));
  const attempts = observations.flatMap(ref => inputs[ref.input]!.report.cells[ref.cell]!.attempts.map((_attempt, index) => ({ ...ref, attempt: index })));
  attempts.sort((first, second) => compareAttempts(getAttempt(inputs, first), getAttempt(inputs, second)));
  for (let index = 1; index < attempts.length; index++) {
    const first = getAttempt(inputs, attempts[index - 1]!), second = getAttempt(inputs, attempts[index]!);
    if (compareAttempts(first, second) === 0 && !isDeepStrictEqual(first, second)) throw new Error(`Ambiguous equal-time attempts for ${boxId(box)}`);
  }
  const latest = attempts.at(-1) ?? null;
  if (!latest) return { ...box, observations, attempts, latest, overall: { status: "unattempted" }, install: null };
  const actual = getAttempt(inputs, latest);
  return { ...box, observations, attempts, latest, overall: attemptedOutcome(box, actual), install: actual.phases.find(phase => phase.phase === "install") ?? null };
}
export function project(raw: readonly { path: string; contents: string }[], boxes: readonly Box[] = inventory()): Projection {
  if (!raw.length) throw new Error("Provide at least one schema 2 report path");
  const inputs = raw.map(readInput);
  uniqueInputs(inputs);
  return { kind: "bun-wasm-goals-view", resumable: false, inputs, cells: boxes.map(box => projectCell(box, inputs)) };
}
function status(outcome: Outcome): string {
  if (outcome.status === "fail") return `FAIL (${outcome.phase})`;
  return outcome.status === "pass" ? "PASS" : "Unattempted";
}
function code(contents: string, language = ""): string[] {
  const fence = "`".repeat(Math.max(3, ...Array.from(contents.matchAll(/`+/g), match => match[0].length + 1)));
  return [fence + language, contents, fence, ""];
}
function json(value: unknown): string[] { return code(JSON.stringify(value, null, 2), "json"); }
function assets(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("files" in value)) return value;
  const { files, ...identities } = value;
  return { ...identities, fileCount: Array.isArray(files) ? files.length : null, fullInventory: "VIEW.json" };
}
function reference(ref: Observation, inputs: Projection["inputs"]): string {
  return `Input ${ref.input + 1}, cell ${ref.cell}, run ${inputs[ref.input]!.report.run}`;
}
function history(cell: ViewCell, inputs: Projection["inputs"]): string[] {
  const lines = [`### ${boxId(cell)}`, ""];
  for (const ref of cell.observations) {
    const observed = inputs[ref.input]!.report.cells[ref.cell]!;
    lines.push(reference(ref, inputs) + ". Recorded status: " + observed.status + ".", "");
    if (observed.status === "pending") lines.push(...json({ reason: observed.reason }));
    if (observed.status === "not runnable yet") lines.push(...json({ reason: observed.reason, discovery: observed.discovery }));
  }
  for (const ref of cell.attempts) {
    lines.push(`${reference(ref, inputs)}, attempt ${ref.attempt}.${ref === cell.latest ? " Selected actual attempt." : ""}`, "");
    const attempt = getAttempt(inputs, ref);
    for (const phase of attempt.phases) {
      if (phase.status === "fail") lines.push(`${phase.phase} failure:`, "", ...code(phase.error));
    }
    lines.push(...json(attempt));
  }
  return lines;
}
export function viewMarkdown(view: Projection): string {
  const lines = ["# Framework evidence view", "", "NON-RESUMABLE. This is a read-only projection, not an executable campaign.", "", "Each input keeps its own runner source, product assets, deadline policy and history in VIEW.json. Install PASS does not mean overall PASS. Unattempted is not a result.", "", "The latest actual attempt is selected by finish time, then start time, never by success. Pending and prerequisite observations remain in history and cannot overwrite attempts.", "", "## Inputs", ""];
  view.inputs.forEach((input, index) => {
    lines.push(`### Input ${index + 1}`, "");
    lines.push(...json({ path: input.path, sha256: input.sha256, run: input.report.run, createdAt: input.report.createdAt, command: input.report.command, runner: { commit: input.report.source.commit, dirty: input.report.source.dirty }, productAssets: assets(input.report.source.assets), deadlines: input.report.deadlines, inventoryCount: input.report.cells.length, sourceAndFullInventory: `VIEW.json inputs[${index}].report` }));
  });
  lines.push("## Selected cells", "", "| Cell | Install | Overall | Selected actual attempt |", "| --- | --- | --- | --- |");
  for (const cell of view.cells) {
    const install = cell.install ? cell.install.status.toUpperCase() : "Not attempted";
    lines.push(`| ${boxId(cell)} | ${install} | ${status(cell.overall)} | ${cell.latest ? reference(cell.latest, view.inputs) + `, attempt ${cell.latest.attempt}` : "None"} |`);
  }
  lines.push("", "## Original observations and attempts", "", "Every phase status, full error, browser capability and prerequisite below belongs to its referenced input. Inputs not visible in this selection, including parked engines, remain intact in VIEW.json.", "");
  for (const cell of view.cells) lines.push(...history(cell, view.inputs));
  return lines.join("\n");
}
function selection(args: readonly string[]): { output: string; paths: string[]; boxes: Box[] } {
  let output: string | undefined, boxes = inventory();
  const paths: string[] = [], seen = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) { paths.push(arg); continue; }
    const [key, value, extra] = arg.slice(2).split("=");
    if (!key || !value || extra !== undefined || seen.has(key)) throw new Error(`Invalid or repeated option: ${arg}`);
    seen.add(key);
    if (key === "output") { output = resolve(value); continue; }
    const field = key === "frameworks" ? "framework" : key === "browsers" ? "browser" : key === "engines" ? "engine" : null;
    if (!field) throw new Error(`Unknown option: ${arg}`);
    const values = value.split(","), allowed = new Set(inventory().map(box => box[field]));
    if (values.some(item => !allowed.has(item))) throw new Error(`Unknown selection: ${arg}`);
    boxes = boxes.filter(box => values.includes(box[field]));
  }
  if (!output) throw new Error("Required: --output=<new-directory> [--frameworks=...] [--browsers=...] [--engines=...] <TABLE.json>...");
  return { output, paths, boxes };
}
export async function writeView(args: readonly string[]): Promise<void> {
  const config = selection(args), raw = [];
  for (const path of config.paths) raw.push({ path: await realpath(path), contents: await readFile(path, "utf8") });
  const view = project(raw, config.boxes), markdown = viewMarkdown(view);
  await mkdir(config.output);
  await writeFile(join(config.output, "VIEW.json"), JSON.stringify(view, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(config.output, "VIEW.md"), markdown, { flag: "wx" });
}
if (import.meta.main) await writeView(process.argv.slice(2));
