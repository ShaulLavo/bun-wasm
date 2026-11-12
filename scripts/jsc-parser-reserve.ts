// Parser reserve controls for one JSC pair (docs/stack-limits.md). Every run is a fresh guest of
// tests/stack-depth.js, validated by the stack measurement protocol.
//   bun scripts/jsc-parser-reserve.ts controls dist/bun-jsc.wasm
//   bun scripts/jsc-parser-reserve.ts capacities dist/bun-jsc.wasm [--launcher BIN] 192 192:1024 208:
//   bun scripts/jsc-parser-reserve.ts threshold dist/bun-jsc.wasm --launcher BIN --budget-kib 208 --root DIR --file PATH=SHA256...
// `controls` is what the blocking JSC embedding gate runs. `capacities` prints each chain's capacity
// for `budget` or `budget:reserve` settings. `threshold` finds the largest reserve on the 64-byte
// grid at which every named file loads with 16 KiB less than the budget.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { effectiveParserReserve, jscStackBudgets, qualifiedParserReserves, stackHosts } from "../web/src/engine-stack-budget.ts";
import { chainCapacities, chainMaximum, chainModes, generatorChains, guestStackSettings, iterativeChains, reserveSiteChains, stackOutcome } from "./stack-measurement.ts";

const root = resolve(import.meta.dir, "..");

export interface StackSettings { readonly budgetKib: number; readonly parserReserve?: string }
export type ProbeHost = (settings: StackSettings, mode: string, depth: number) => { code: number | null; output: string };
export interface CapacityRecord { readonly requested: StackSettings; readonly effectiveParserReserve: number; readonly capacities: Record<string, number> }

function guestOptions(settings: StackSettings): string[] {
  const reserve = settings.parserReserve === undefined ? [] : ["--env", `BUN_WASM_JSC_PARSER_RESERVE=${settings.parserReserve}`];
  return ["--dir", `${join(root, "tests")}::/`, "--env", "PWD=/", "--env", `BUN_WASM_STACK_KIB=${settings.budgetKib}`].concat(reserve);
}

function probe(command: string, args: readonly string[], mode: string, depth: number) {
  const run = spawnSync(command, args.concat(["--", "run", "/stack-depth.js", mode, String(depth)]), { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (run.error && run.status === null && run.signal === null) throw run.error;
  return { code: run.status, output: `${run.stdout ?? ""}${run.stderr ? `\n${run.stderr}` : ""}` };
}

/** The guest in web/scripts/node-host.mjs's Worker, as the JSC embedding gate runs it. */
export function nodeHost(artifact: string): ProbeHost {
  const base = ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--wasm", artifact];
  return (settings, mode, depth) => probe("node", base.concat(guestOptions(settings)), mode, depth);
}

function launcherHost(launcher: string, artifact: string): ProbeHost {
  return (settings, mode, depth) => probe(launcher, ["--wasm", artifact].concat(guestOptions(settings)), mode, depth);
}

const label = (settings: StackSettings) => `${settings.budgetKib} KiB, reserve ${settings.parserReserve === undefined ? "unset" : JSON.stringify(settings.parserReserve)}`;

/** Every parser chain's capacity in one guest that was given exactly these settings. */
export function capacitiesAt(host: ProbeHost, requested: StackSettings): CapacityRecord {
  const result = host(requested, "chainCapacity", chainMaximum);
  const outcome = stackOutcome(result, "chainCapacity", chainMaximum);
  if (outcome !== "completed") throw new Error(`Chain capacity at ${label(requested)}: ${outcome}\n${result.output}`);
  const guest = guestStackSettings(result.output);
  if (guest?.budget !== String(requested.budgetKib) || (guest.parserReserve ?? undefined) !== requested.parserReserve) {
    throw new Error(`The guest at ${label(requested)} reported other settings: ${JSON.stringify(guest)}`);
  }
  return { requested, effectiveParserReserve: effectiveParserReserve(requested.parserReserve), capacities: chainCapacities(result.output) };
}

// One of each rejected form: empty, zero, below and above the range, five digits, a sign,
// whitespace, a decimal point and trailing text.
const rejectedSettings = ["", "0", "511", "2049", "10240", "+1024", " 1024", "1024.5", "1024kb"];

function compare(left: CapacityRecord, right: CapacityRecord, modes: readonly string[], holds: (left: number, right: number) => boolean, relation: string): void {
  for (const mode of modes) {
    const a = left.capacities[mode]!, b = right.capacities[mode]!;
    if (!holds(a, b)) throw new Error(`${mode}: ${a} at ${label(left.requested)} is not ${relation} ${b} at ${label(right.requested)}`);
  }
}
const same = (left: CapacityRecord, right: CapacityRecord) => compare(left, right, chainModes, (a, b) => a === b, "equal to");
const atMost = (left: CapacityRecord, right: CapacityRecord) => compare(left, right, chainModes, (a, b) => a <= b, "at most");
// The two reserved parser sites, in both parser passes and both source widths: eight differentials.
const sitesBelow = (left: CapacityRecord, right: CapacityRecord) => compare(left, right, reserveSiteChains, (a, b) => a < b, "below");
// The code generator, not the parser reserve, stops a fully parsed assignment chain.
const generatorSame = (left: CapacityRecord, right: CapacityRecord) => compare(left, right, generatorChains, (a, b) => a === b, "equal to");
// Every chain the guard can stop: the iterative syntax-check pass loads the deepest chain tried at every tuple.
const boundedChains = chainModes.filter(mode => !iterativeChains.includes(mode));

function iterativeLoads(record: CapacityRecord): CapacityRecord {
  for (const mode of iterativeChains) {
    const capacity = record.capacities[mode];
    if (capacity !== chainMaximum) throw new Error(`${mode}: ${capacity} at ${label(record.requested)} does not reach ${chainMaximum}, the deepest tried`);
  }
  return record;
}

/** The distinct host budgets, and each family's shipped value at its budget. */
function shippedSettings(): StackSettings[] {
  return stackHosts.flatMap((host) => {
    const entry = qualifiedParserReserves[host];
    return entry ? [{ budgetKib: Number(jscStackBudgets[host]), parserReserve: entry.bytes }] : [];
  });
}

/**
 * The gate's tuples on one pair: the default at every host budget, each rejected form, the values
 * 512, 1024 and 2048, rounding, and every shipped (budget, value). Throws on the first violation.
 */
export function parserReserveControls(host: ProbeHost): CapacityRecord[] {
  const records: CapacityRecord[] = [];
  const at = (budgetKib: number, parserReserve?: string) => {
    const record = iterativeLoads(capacitiesAt(host, { budgetKib, parserReserve }));
    records.push(record);
    return record;
  };
  const budgets = Array.from(new Set(Object.values(jscStackBudgets)), Number).sort((a, b) => a - b);
  const defaults = new Map(budgets.map(budget => [budget, at(budget)]));
  const smallest = defaults.get(budgets[0]!)!;
  compare(smallest, smallest, chainModes, a => a > 0, "above zero, unlike");
  for (let index = 1; index < budgets.length; index++) atMost(defaults.get(budgets[index - 1]!)!, defaults.get(budgets[index]!)!);
  compare(smallest, defaults.get(budgets.at(-1)!)!, boundedChains, (a, b) => a < b, "below");
  // A rejected value is never clamped: the guest keeps the default's capacity exactly.
  for (const value of rejectedSettings.concat(["2048"])) same(at(smallest.requested.budgetKib, value), smallest);
  const half = at(smallest.requested.budgetKib, "1024"), quarter = at(smallest.requested.budgetKib, "512");
  sitesBelow(smallest, half);
  sitesBelow(half, quarter);
  atMost(smallest, half);
  atMost(half, quarter);
  generatorSame(smallest, half);
  generatorSame(smallest, quarter);
  // 1000 rounds up to 1008, and 1009 to 1024.
  same(at(smallest.requested.budgetKib, "1000"), at(smallest.requested.budgetKib, "1008"));
  same(at(smallest.requested.budgetKib, "1009"), half);
  for (const shipped of shippedSettings()) {
    const reduced = at(shipped.budgetKib, shipped.parserReserve);
    sitesBelow(defaults.get(shipped.budgetKib)!, reduced);
    generatorSame(defaults.get(shipped.budgetKib)!, reduced);
  }
  return records;
}

function parseSetting(text: string): StackSettings {
  const [budget, ...reserve] = text.split(":");
  if (!/^[1-9][0-9]*$/.test(budget ?? "")) throw new Error(`Expected BUDGET or BUDGET:RESERVE, got ${text}`);
  return { budgetKib: Number(budget), parserReserve: reserve.length ? reserve.join(":") : undefined };
}

interface FileInput { readonly path: string; readonly sha256: string }

function verifiedFile(filesRoot: string, text: string): FileInput {
  const separator = text.lastIndexOf("=");
  const path = text.slice(0, separator), sha256 = text.slice(separator + 1);
  const actual = createHash("sha256").update(readFileSync(join(filesRoot, path))).digest("hex");
  if (separator < 1 || actual !== sha256) throw new Error(`${path}: expected sha256 ${sha256}, found ${actual}`);
  return { path, sha256 };
}

/** Whether one real file loads from an empty stack, through the measurement harness. A parser refusal is an answer; anything else fails. */
function fileLoads(artifact: string, launcher: string, settings: StackSettings, filesRoot: string, file: string): boolean {
  const reserve = settings.parserReserve === undefined ? [] : ["--parser-reserve", settings.parserReserve];
  const run = spawnSync("python3", ["scripts/measure-stack.py", "--engine", "jsc", "--wasm", artifact, "--launcher", launcher,
    "--budget-kib", String(settings.budgetKib), "--max", "1", "--leaf-root", filesRoot, "--leaf", file].concat(reserve, ["require"]), { cwd: root, encoding: "utf8" });
  const row = JSON.parse(run.stdout).results.require;
  if (row.refused_at_zero === "caught:RangeError") return false;
  if (row.failures.length > 0) throw new Error(`${file} at ${label(settings)}: ${JSON.stringify(row)}`);
  return true;
}

/** Chooses the candidate of docs/stack-limits.md: the largest grid value at which every file loads at the budget minus 16 KiB. */
export function fileThreshold(loads: (settings: StackSettings, file: string) => boolean, budgetKib: number, files: readonly string[]) {
  const reduced = budgetKib - 16;
  const grid = Array.from({ length: 24 }, (_, index) => 512 + index * 64);
  const rows = grid.map(value => ({ value, loads: Object.fromEntries(files.map(file => [file, loads({ budgetKib: reduced, parserReserve: String(value) }, file)])) }));
  const passing = rows.filter(row => files.every(file => row.loads[file])).map(row => row.value);
  const threshold = passing.length ? Math.max(...passing) : null;
  // A larger reserve never loads more, so every smaller grid value must load too.
  const monotonic = threshold === null || rows.every(row => row.value > threshold || passing.includes(row.value));
  return { budgetKib, measuredAtKib: reduced, rows, threshold: monotonic ? threshold : null, monotonic };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args.splice(index, 2)[1];
}

function repeated(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let value = option(args, name); value !== undefined; value = option(args, name)) values.push(value);
  return values;
}

if (import.meta.main) {
  const [command, artifactName, ...args] = process.argv.slice(2);
  if (!artifactName) throw new Error("Usage: jsc-parser-reserve.ts controls|capacities|threshold ARTIFACT ...");
  const artifact = resolve(artifactName);
  const launcher = option(args, "--launcher");
  const host = launcher ? launcherHost(resolve(launcher), artifact) : nodeHost(artifact);
  if (command === "controls") {
    for (const record of parserReserveControls(host)) console.log(JSON.stringify(record));
  } else if (command === "capacities") {
    for (const setting of args) console.log(JSON.stringify(capacitiesAt(host, parseSetting(setting))));
  } else if (command === "threshold" && launcher) {
    const budget = Number(option(args, "--budget-kib")), filesRoot = resolve(option(args, "--root") ?? "");
    const files = repeated(args, "--file").map(text => verifiedFile(filesRoot, text));
    if (!Number.isSafeInteger(budget) || budget <= 16 || files.length === 0) throw new Error("threshold needs --budget-kib, --root and --file PATH=SHA256");
    const loads = (settings: StackSettings, file: string) => fileLoads(artifact, resolve(launcher), settings, filesRoot, file);
    const defaults = Object.fromEntries(files.map(file => [file.path, { atBudget: loads({ budgetKib: budget }, file.path), reduced: loads({ budgetKib: budget - 16 }, file.path) }]));
    console.log(JSON.stringify({ files, defaults, ...fileThreshold(loads, budget, files.map(file => file.path)) }));
  } else {
    throw new Error("Usage: jsc-parser-reserve.ts controls|capacities|threshold ARTIFACT ...");
  }
}
