// JSC parses nests of blocks and `if` statements on parser-owned records and refuses the 10,001st
// open record of one parse with the parser's RangeError (docs/bun-patches/jsc-statement-records.md).
// Each row builds a nest whose record count is known exactly, in 8-bit and 16-bit sources, and
// tries it at the last accepted count and the first refused count. A first-statement marker shows
// whether any of the nest's code ran.
//
// Every engine prints the same lines: a row is `ok` when each attempt either ran with the right
// result, or threw a RangeError with the marker unset, and a shallow nest of the same shape ran
// afterwards. BUNWASM_STATEMENT_RECORDS_EXACT=1, set only by the JSC embedding gate, also requires
// JSC's exact boundary: the last counted record accepted and run, the next one refused in the
// stated phase with "Maximum call stack size exceeded." and nothing run, and recovery. The
// checker's negative controls (a removed cap, a cap moved either way, the wrong error or phase,
// code run before a refusal, no recovery) run on every engine and must all be rejected.
const indirectEval = eval;
const exact = process.env.BUNWASM_STATEMENT_RECORDS_EXACT === "1";
const cap = 10000;
const parserRefusal = "RangeError: Maximum call stack size exceeded.";
const repeat = (count: number, text: (index: number) => string) => Array.from({ length: count }, (_, index) => text(index)).join("");
// A non-Latin-1 character in a comment makes the engine read a 16-bit source.
const widen = (source: string, wide: boolean) => (wide ? `/* ☃ */${source}` : source);

/** `build` parses what can be parsed without running it; `run` parses the rest and runs it. */
type Phase = "build" | "run";
interface Shape {
  name: string;
  /** Records a nest of `levels` levels opens in the parse that `refusedIn` names. */
  records(levels: number): number;
  build(levels: number, wide: boolean): () => unknown;
  /** The phase whose parse counts `records(levels)`: refusal of the first refused count happens there. */
  refusedIn: Phase;
  expected: unknown;
}

const marker = "globalThis.__recordCapMark()";
const blocks = (levels: number, inner: string) => `${"{".repeat(levels)}${inner}${"}".repeat(levels)}`;
const bareIfs = (levels: number, inner: string) => `${"if (t) ".repeat(levels)}${inner}`;
// One block or one bare `if` per level: either opens one record.
const mixed = (levels: number, inner: string) => `${repeat(levels, i => (i % 2 ? "if (t) " : "{"))}${inner}${"}".repeat(Math.ceil(levels / 2))}`;
// oxlint-disable-next-line no-new-func -- The parser under test compiles each generated body.
const construct = (body: string) => new Function("t", body) as (t: boolean) => unknown;
const directEval = (source: string) => eval(source);

const shapes: Shape[] = [
  // Eval code, indirect and direct: the eval's one parse opens one record per level.
  { name: "program blocks", records: n => n, refusedIn: "run", expected: 1, build: (n, wide) => () => indirectEval(widen(`${marker}; ${blocks(n, "1;")}`, wide)) },
  { name: "program bare ifs", records: n => n, refusedIn: "run", expected: 2, build: (n, wide) => () => indirectEval(widen(`${marker}; var t = true; ${bareIfs(n, "2;")}`, wide)) },
  { name: "program mixed", records: n => n, refusedIn: "run", expected: 3, build: (n, wide) => () => indirectEval(widen(`${marker}; var t = true; ${mixed(n, "3;")}`, wide)) },
  { name: "direct eval blocks", records: n => n, refusedIn: "run", expected: 4, build: (n, wide) => () => directEval(widen(`${marker}; ${blocks(n, "4;")}`, wide)) },
  // A function body: construction parses the nest, one record per level. The first call parses the
  // body again as one block statement, a record of its own, so the call counts one more.
  { name: "function blocks", records: n => n + 1, refusedIn: "run", expected: 5, build: (n, wide) => { const f = construct(widen(`${marker}; ${blocks(n, "")} return 5;`, wide)); return () => f(true); } },
  { name: "function bare ifs", records: n => n + 1, refusedIn: "run", expected: 6, build: (n, wide) => { const f = construct(widen(`${marker}; ${bareIfs(n, "return 6;")} return 0;`, wide)); return () => f(true); } },
  // An arrow body in eval code: the eval parses the nest, and the arrow's call reparses its body
  // as a block, one more record.
  { name: "arrow blocks", records: n => n + 1, refusedIn: "run", expected: 7, build: (n, wide) => { const f = indirectEval(widen(`(() => { ${marker}; ${blocks(n, "")} return 7; })`, wide)) as () => unknown; return () => f(); } },
];

interface Attempt { ran: boolean; result: unknown; error: string | null; phase: Phase | null }

function attempt(shape: Shape, levels: number, wide: boolean): Attempt {
  let ran = false;
  (globalThis as { __recordCapMark?: () => void }).__recordCapMark = () => { ran = true; };
  let phase: Phase = "build";
  try {
    const call = shape.build(levels, wide);
    phase = "run";
    const result = call();
    return { ran, result, error: null, phase: null };
  } catch (error) {
    return { ran, result: undefined, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), phase };
  }
}

/** The portable rule for one attempt: it ran with the right result, or it was refused before running. */
function portableOk(shape: Shape, outcome: Attempt): boolean {
  if (outcome.error === null) return outcome.ran && outcome.result === shape.expected;
  return outcome.error.startsWith("RangeError") && !outcome.ran;
}

/**
 * One row's attempts: the last accepted count, the first refused count, a count refused already
 * while building (function and arrow rows only), and a shallow nest afterwards.
 */
interface Boundary { accepted: Attempt; refused: Attempt; refusedBuilding: Attempt | null; recovered: Attempt }

const ranOk = (shape: Shape, outcome: Attempt) => outcome.error === null && outcome.ran && outcome.result === shape.expected;

/** JSC's exact contract for one row, or the reason it is broken. */
function exactViolation(shape: Shape, boundary: Boundary): string | null {
  const { accepted, refused, refusedBuilding, recovered } = boundary;
  if (!ranOk(shape, accepted)) return `the last accepted count did not run correctly: ${JSON.stringify(accepted)}`;
  if (refused.error === null) return "the first refused count was accepted: the cap is missing or moved up";
  if (refused.error !== parserRefusal) return `refused with ${refused.error}, not the parser's record refusal`;
  if (refused.phase !== shape.refusedIn) return `refused while ${refused.phase === "build" ? "building" : "running"}, not where the counted parse runs`;
  if (refused.ran) return "ran the nest before refusing it";
  if (refusedBuilding && (refusedBuilding.error !== parserRefusal || refusedBuilding.phase !== "build" || refusedBuilding.ran)) {
    return `one level more was not refused while building: ${JSON.stringify(refusedBuilding)}`;
  }
  if (!ranOk(shape, recovered)) return "a shallow nest failed after the refusal";
  return null;
}

let failures = 0;
for (const shape of shapes) {
  // The level count that opens exactly `cap` records in the counted parse.
  const levels = cap - shape.records(0);
  for (const wide of [false, true]) {
    const label = `${shape.name}${wide ? ", 16-bit" : ""}`;
    const boundary: Boundary = {
      accepted: attempt(shape, levels, wide),
      refused: attempt(shape, levels + 1, wide),
      refusedBuilding: shape.records(0) > 0 ? attempt(shape, levels + 2, wide) : null,
      recovered: attempt(shape, 3, wide),
    };
    const attempts = [boundary.accepted, boundary.refused, boundary.refusedBuilding, boundary.recovered].filter(entry => entry !== null);
    const portable = attempts.every(entry => portableOk(shape, entry)) && ranOk(shape, boundary.recovered);
    const violation = exact ? exactViolation(shape, boundary) : null;
    if (!portable || violation) {
      failures++;
      console.error(`${label}: ${violation ?? "broke the portable rule"} ${JSON.stringify(boundary)}`);
    }
    console.log(`record cap, ${label}: ${portable && !violation ? "ok" : "FAILED"}`);
  }
}

// The checker must reject each broken contract: what a guest with a removed or moved cap, another
// error or phase, a nest run before its refusal, or no recovery would produce.
const sample = shapes[4]!;
const ran = (): Attempt => ({ ran: true, result: sample.expected, error: null, phase: null });
const refusal = (error = parserRefusal, phase: Phase = "run", wasRun = false): Attempt => ({ ran: wasRun, result: undefined, error, phase });
const intact: Boundary = { accepted: ran(), refused: refusal(), refusedBuilding: refusal(parserRefusal, "build"), recovered: ran() };
const broken: [string, Boundary][] = [
  ["cap removed", { ...intact, refused: ran(), refusedBuilding: ran() }],
  ["cap moved up", { ...intact, refused: ran() }],
  ["cap moved down", { ...intact, accepted: refusal() }],
  ["function body block not counted", { ...intact, refused: refusal(parserRefusal, "build") }],
  ["build pass not counted", { ...intact, refusedBuilding: refusal() }],
  ["wrong error class", { ...intact, refused: refusal(`SyntaxError: Maximum call stack size exceeded.`) }],
  ["generator refusal instead of the record cap", { ...intact, refused: refusal("RangeError: Out of memory") }],
  ["ran before refusing", { ...intact, refused: refusal(parserRefusal, "run", true) }],
  ["no recovery", { ...intact, recovered: refusal() }],
];
const rejected = broken.filter(([, boundary]) => exactViolation(sample, boundary) !== null).length;
const intactAccepted = exactViolation(sample, intact) === null;
console.log(`negative controls: ${rejected} of ${broken.length} broken contracts rejected, intact contract ${intactAccepted ? "accepted" : "REJECTED"}`);
if (rejected !== broken.length || !intactAccepted) failures++;
if (failures) process.exit(1);
