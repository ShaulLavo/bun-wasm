import { readFileSync } from "node:fs";
import { acceptedStackOutcome, stackModeSlice, type GuestStackSettings } from "./stack-measurement.ts";

const overflowFixtures = ["stack-overflow", "stack-overflow-console"];

export function stackSelection(slice: string | undefined, measure: boolean) {
  if (slice === undefined) {
    const modes = stackModeSlice(0, 1);
    return { slice: null, first: 1, last: 1, count: 1, modeCount: modes.length, modes, fixtures: overflowFixtures };
  }
  if (!measure) throw new Error("STACK_SLICE requires --measure");
  const parts = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?\/([1-9][0-9]*)$/.exec(slice);
  if (!parts) throw new Error(`STACK_SLICE must be PART/COUNT or FIRST-LAST/COUNT, got ${slice}`);
  const first = Number(parts[1]), last = Number(parts[2] ?? parts[1]), count = Number(parts[3]);
  // Validate both ends before allocating the range, including unsafe integers and empty parts.
  stackModeSlice(first - 1, count);
  stackModeSlice(last - 1, count);
  if (last < first) throw new Error(`STACK_SLICE parts run backwards: ${slice}`);
  const modes = Array.from({ length: last - first + 1 }, (_, offset) => stackModeSlice(first - 1 + offset, count)).flat();
  return { slice, first, last, count, modeCount: modes.length, modes, fixtures: first === 1 ? overflowFixtures : [] };
}

type Selection = ReturnType<typeof stackSelection>;

export function reportStackSelection(host: string, selection: Selection, cold: boolean, requested: GuestStackSettings): void {
  if (selection.slice === null) return;
  console.log(JSON.stringify({ host, stackSelection: selection, cold, requested }));
}

export function reportStackCompletion(browsers: readonly string[], engines: readonly string[], selection: Selection): void {
  if (selection.slice === null) return;
  for (const browser of browsers) {
    for (const engine of engines) console.log(JSON.stringify({ host: `${browser}/${engine}`, stackPartComplete: selection.slice }));
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a stack report object");
  return Object.fromEntries(Object.entries(value));
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Mismatched ${label}`);
}

function passingRow(row: Record<string, unknown>): void {
  if (typeof row.mode !== "string" || typeof row.at_max !== "string" || !acceptedStackOutcome(row.mode, row.at_max)) throw new Error("Failed stack row");
  if (!Array.isArray(row.failures) || row.failures.length !== 0) throw new Error(`Failed stack row ${row.mode}`);
  if (row.beyond !== undefined && (typeof row.beyond !== "string" || !acceptedStackOutcome(row.mode, row.beyond))) throw new Error(`Failed boundary ${row.mode}`);
  if ((row.capacity === undefined) !== (row.beyond === undefined)) throw new Error(`Incomplete boundary ${row.mode}`);
  if (row.capacity !== undefined && (typeof row.capacity !== "number" || !Number.isSafeInteger(row.capacity) || row.capacity < 0)) throw new Error(`Invalid capacity ${row.mode}`);
}

/** One file per successful invocation, for a single browser/engine and settings tuple. */
function readPart(transcript: string, host: string) {
  const records = transcript.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => object(JSON.parse(line)));
  const headers = records.filter(row => "stackSelection" in row);
  if (headers.length !== 1) throw new Error("Expected one stack selection per file");
  const header = headers[0]!;
  equal(header.host, host, "host");
  const raw = object(header.stackSelection);
  if (typeof raw.slice !== "string") throw new Error("Missing explicit stack slice");
  const selection = stackSelection(raw.slice, true);
  equal(raw, selection, "selection");
  if (typeof header.cold !== "boolean") throw new Error("Missing cold setting");
  const requested = object(header.requested);
  for (const key of ["budget", "parserReserve"]) {
    if (requested[key] !== null && typeof requested[key] !== "string") throw new Error(`Missing requested ${key}`);
  }
  const rows = records.filter(row => "mode" in row);
  equal(rows.map(row => row.mode), selection.modes, "mode coverage or order");
  for (const row of rows) { equal(row.host, host, "row host"); passingRow(row); }
  const completions = records.filter(row => "stackPartComplete" in row);
  equal(completions, [{ host, stackPartComplete: selection.slice }], "part completion");
  const expectedFixtures = selection.fixtures.map(fixture => `ok ${host} ${fixture}`);
  const fixtures = transcript.split(/\r?\n/).filter(line => line.startsWith("ok "));
  equal(fixtures, expectedFixtures, "overflow fixtures");
  if (records.at(-1) !== completions[0]) throw new Error("Part completion must follow all rows");
  return { selection, configuration: { cold: header.cold, requested } };
}

export function completeStackParts(transcripts: readonly string[], host: string) {
  if (!transcripts.length) throw new Error("No stack part reports");
  const parts = transcripts.map(transcript => readPart(transcript, host));
  const first = parts[0]!;
  const covered = new Set<number>();
  parts.sort((a, b) => a.selection.first - b.selection.first);
  for (const part of parts) {
    equal(part.selection.count, first.selection.count, "part count");
    equal(part.configuration, first.configuration, "stack settings");
    for (let index = part.selection.first; index <= part.selection.last; index++) {
      if (covered.has(index)) throw new Error(`Duplicate stack part ${index}`);
      covered.add(index);
    }
  }
  if (covered.size !== first.selection.count) throw new Error("Missing stack parts");
  const modes = parts.flatMap(part => part.selection.modes);
  equal(modes, stackModeSlice(0, 1), "full mode coverage");
  return { host, ...first.configuration, parts: covered.size, modes: modes.length, fixtures: overflowFixtures, complete: true };
}

if (import.meta.main) {
  const [host, ...files] = process.argv.slice(2);
  if (!host || !files.length) throw new Error("Usage: bun scripts/stack-parts.ts BROWSER/ENGINE part.jsonl ...");
  console.log(JSON.stringify(completeStackParts(files.map(file => readFileSync(file, "utf8")), host)));
}
