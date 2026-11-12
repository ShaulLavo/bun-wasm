// The parser chains of tests/stack-depth.js: five shapes, two parser passes, two source widths.
export const chainModes = ["Assign", "Conditional", "Block", "Call", "Function"].flatMap(kind =>
  ["Compile", "Call"].flatMap(pass => ["8", "16"].map(width => `chain${kind}${pass}${width}`)));
/**
 * The chains that recurse through exactly one of JSC's two reserved parser functions per level:
 * a conditional branch is a new assignment expression, and a block is a new statement.
 */
export const reserveSiteChains = chainModes.filter(mode => /^chain(?:Conditional|Block)/.test(mode));
/**
 * JSC parses a chain of assignment targets without recursion (docs/bun-patches/jsc-assignment-chains.md),
 * so the syntax-check pass loads every depth tried.
 */
export const iterativeChains = chainModes.filter(mode => /^chainAssignCompile/.test(mode));
/** The full parse of an assignment chain stops in the code generator, so the parser reserve does not move it. */
export const generatorChains = chainModes.filter(mode => /^chainAssignCall/.test(mode));
/** The deepest chain tried: far past any budget's capacity, and small enough to stay a parser test. */
export const chainMaximum = 4096;
const stackModes = [
  "plain", "getter", "computedgetter", "ajvnames", "proxy", "json", "jsonplain", "jsonparse", "reviver", "parse", "block", "arrow", "unary",
  "power", "ternary", "statement", "awaitchain", "regexpnc", "lookahead", "proxychain", "isarray", "bound", "boundcall", "join", "flat", "tostring",
  "async", "promise", "console",
].concat(chainModes);
// Every chain is searched, so each one is also attempted at interior depths, not only far past its guard.
const searched = new Set(["plain", "getter", "computedgetter", "boundcall", "proxy", "json", "parse", "promise"].concat(chainModes));
const syntaxModes = new Set(["parse", "block", "arrow", "unary", "power", "ternary", "statement", "awaitchain", "regexpnc", "lookahead"].concat(chainModes));

function deepestAttempt(mode: string): number {
  // Each bind prefixes the name with "bound ", so deeper chains run out of memory first.
  if (mode === "bound") return 2000;
  // The Ajv walk merges one name set per level, so its depth stays where that work is small.
  return mode.startsWith("chain") || mode === "ajvnames" ? chainMaximum : 200000;
}

export interface GuestStackSettings { readonly budget: string | null; readonly parserReserve: string | null }


function stackEnvironmentValue(key: string, value: string | null): string {
  if (value === null) return "";
  return `${key}='${value.replaceAll("'", "'\\''")}' `;
}

/** Preserve each explicit override literally, including empty strings and whitespace. */
export function stackEnvironmentPrefix(settings: GuestStackSettings): string {
  return stackEnvironmentValue("BUN_WASM_STACK_KIB", settings.budget)
    + stackEnvironmentValue("BUN_WASM_JSC_PARSER_RESERVE", settings.parserReserve);
}

/** The probe's `settings` line: the stack environment its guest was given. Null when it printed none, as after a trap. */
export function guestStackSettings(output: string): GuestStackSettings | null {
  const line = output.split(/\r?\n/).find(entry => entry.startsWith("settings "));
  if (!line) return null;
  const parsed: unknown = JSON.parse(line.slice("settings ".length));
  if (!parsed || typeof parsed !== "object" || !("budget" in parsed) || !("parserReserve" in parsed)) throw new Error("Malformed guest stack settings");
  const { budget, parserReserve } = parsed;
  if ((budget !== null && typeof budget !== "string") || (parserReserve !== null && typeof parserReserve !== "string")) throw new Error("Malformed guest stack settings");
  return { budget, parserReserve };
}

function capacityRecord(parsed: unknown): Record<string, number> {
  if (!parsed || typeof parsed !== "object") throw new Error("Malformed chain capacities");
  const capacities: Record<string, number> = {};
  for (const [mode, value] of Object.entries(parsed)) {
    if (!chainModes.includes(mode) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Malformed chain capacity ${mode}`);
    capacities[mode] = value;
  }
  if (Object.keys(capacities).length !== chainModes.length) throw new Error("Missing chain capacities");
  return capacities;
}

function taggedLine(output: string, tag: string): unknown {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(`${tag} `));
  if (lines.length !== 1) throw new Error(`Expected one ${tag} line, found ${lines.length}`);
  return JSON.parse(lines[0]!.slice(tag.length + 1));
}

/** The `capacities` line a `chainCapacity` run prints: one whole number per parser chain. */
export function chainCapacities(output: string): Record<string, number> {
  return capacityRecord(taggedLine(output, "capacities"));
}

/** What stopped a chain one level past its capacity (null when it never stopped), and whether a shallow one parsed next. */
export interface ChainBoundary { readonly refusal: string | null; readonly recovered: boolean }

/** The `boundaries` line a `chainCapacity` run prints: one refusal and recovery per parser chain. */
export function chainBoundaries(output: string): Record<string, ChainBoundary> {
  const parsed = taggedLine(output, "boundaries");
  if (!parsed || typeof parsed !== "object") throw new Error("Malformed chain boundaries");
  const boundaries: Record<string, ChainBoundary> = {};
  for (const [mode, value] of Object.entries(parsed)) {
    const valid = chainModes.includes(mode) && value && typeof value === "object" && "refusal" in value && "recovered" in value
      && (value.refusal === null || typeof value.refusal === "string") && typeof value.recovered === "boolean";
    if (!valid) throw new Error(`Malformed chain boundary ${mode}`);
    boundaries[mode] = { refusal: value.refusal, recovered: value.recovered };
  }
  if (Object.keys(boundaries).length !== chainModes.length) throw new Error("Missing chain boundaries");
  return boundaries;
}

export interface ChainOwnership {
  readonly before: Record<string, number>;
  readonly child: { readonly settings: GuestStackSettings; readonly capacities: Record<string, number> };
  readonly after: Record<string, number>;
}

/**
 * The `ownership` line a `chainWorker` run prints: the parent's capacities before its Worker child
 * starts and after it exits, and the child's own validated `chainCapacity` transcript.
 */
export function chainOwnership(output: string, depth: number): ChainOwnership {
  const parsed = taggedLine(output, "ownership");
  if (!parsed || typeof parsed !== "object" || !("before" in parsed) || !("after" in parsed) || !("child" in parsed)) throw new Error("Malformed chain ownership");
  const child = parsed.child;
  if (!child || typeof child !== "object" || !("code" in child) || !("output" in child) || typeof child.output !== "string") throw new Error("Malformed chain ownership child");
  // The probe encodes the child's transcript: a terminal trims the spaces that end a wrapped row.
  const transcript = decodeURIComponent(child.output);
  const outcome = stackOutcome({ code: typeof child.code === "number" ? child.code : null, output: transcript }, "chainCapacity", depth);
  const settings = guestStackSettings(transcript);
  if (outcome !== "completed" || !settings) throw new Error(`The Worker child did not complete: ${outcome}\n${transcript}`);
  return { before: capacityRecord(parsed.before), child: { settings, capacities: chainCapacities(transcript) }, after: capacityRecord(parsed.after) };
}

type Failure = { depth: number; outcome: string };
type Row = { host: string; mode: string; at_max: string; capacity?: number; beyond?: string; failures: Failure[] };
type Attempt = (mode: string, depth: number) => Promise<string>;

export function acceptedStackOutcome(mode: string, outcome: string): boolean {
  if (outcome === "completed") return true;
  if (mode === "console") return false;
  if (outcome === "caught:RangeError" || outcome === "caught:InternalError") return true;
  return outcome === "caught:SyntaxError" && syntaxModes.has(mode);
}

export function stackOutcome(
  result: { code: number | null; output: string }, mode: string, depth: number, nativeFirefox = false,
): string {
  if (result.code === null) return "timeout";
  if (result.code !== 0) return "trap";
  const lines = result.output.split(/\r?\n/);
  const outcomes = lines.filter(line => /^(?:completed|caught) /.test(line));
  if (outcomes.length !== 1) return "invalid-output";
  const line = outcomes[0]!;
  if (lines.filter(entry => entry === "continued").length > 1) return "invalid-output";
  if (lines.indexOf("continued") <= lines.indexOf(line)) return "missing-continuation";
  if (line === `completed ${mode} ${depth}`) return "completed";
  const caught = /^caught (\w+) (\w+) (\d+) (.*)$/.exec(line);
  if (!caught || caught[1] !== mode || Number(caught[3]) !== depth) return "invalid-output";
  const outcome = `caught:${caught[2]}`;
  if (caught[2] === "InternalError" && (!nativeFirefox || caught[4] !== "too much recursion")) return `unexpected:${caught[2]}`;
  return acceptedStackOutcome(mode, outcome) ? outcome : `unexpected:${caught[2]}`;
}


/** An explicitly requested tuple must match what the guest actually received. */
export function observeStackOutcome({ result, mode, depth, requested, nativeFirefox = false }: {
  result: Parameters<typeof stackOutcome>[0]; mode: string; depth: number;
  requested: GuestStackSettings; nativeFirefox?: boolean;
}): { outcome: string; settings: GuestStackSettings | null } {
  const settings = guestStackSettings(result.output);
  const outcome = stackOutcome(result, mode, depth, nativeFirefox);
  if (!acceptedStackOutcome(mode, outcome)) return { outcome, settings };
  for (const key of ["budget", "parserReserve"] as const) {
    if (requested[key] !== null && requested[key] !== settings?.[key]) return { outcome: "settings-mismatch", settings };
  }
  return { outcome, settings };
}

async function measurePath(attempt: Attempt, host: string, mode: string): Promise<Row> {
  const failures: Failure[] = [];
  async function trial(depth: number) {
    const outcome = await attempt(mode, depth);
    if (!acceptedStackOutcome(mode, outcome)) failures.push({ depth, outcome });
    return outcome;
  }
  let high = deepestAttempt(mode);
  const row: Row = { host, mode, at_max: await trial(high), failures };
  if (!searched.has(mode) || row.at_max === "completed") return row;
  let low = 0;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await trial(middle)) === "completed") low = middle;
    else high = middle;
  }
  return Object.assign(row, { capacity: low, beyond: await trial(low + 1) });
}

/**
 * Part `index` of `count` consecutive parts of the fixed path order. The parts of one count cover
 * every path exactly once, so a sweep split across several runs cannot leave a path out.
 */
export function stackModeSlice(index: number, count: number): string[] {
  const valid = Number.isSafeInteger(index) && Number.isSafeInteger(count) && count >= 1 && count <= stackModes.length && index >= 0 && index < count;
  if (!valid) throw new Error(`Invalid stack sweep slice: part ${index + 1} of ${count}`);
  const start = (part: number) => Math.floor(part * stackModes.length / count);
  return stackModes.slice(start(index), start(index + 1));
}

export async function measureStackPaths(attempt: Attempt, host: string, report: (row: Row) => void, modes: readonly string[] = stackModes): Promise<boolean> {
  let failed = false;
  for (const mode of modes) {
    const row = await measurePath(attempt, host, mode);
    report(row);
    failed ||= row.failures.length > 0;
  }
  return failed;
}
