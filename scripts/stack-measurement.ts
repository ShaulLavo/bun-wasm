const stackModes = [
  "plain", "getter", "proxy", "json", "jsonplain", "jsonparse", "reviver", "parse", "block", "arrow", "unary",
  "power", "ternary", "statement", "regexpnc", "lookahead", "proxychain", "isarray", "bound", "join", "flat", "tostring",
  "async", "promise", "console",
];
const searched = new Set(["plain", "getter", "proxy", "json", "parse", "promise"]);
const syntaxModes = new Set(["parse", "block", "arrow", "unary", "power", "ternary", "statement", "regexpnc", "lookahead"]);

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
  if (lines.indexOf("continued") <= lines.indexOf(line)) return "missing-continuation";
  if (line === `completed ${mode} ${depth}`) return "completed";
  const caught = /^caught (\w+) (\w+) (\d+) (.*)$/.exec(line);
  if (!caught || caught[1] !== mode || Number(caught[3]) !== depth) return "invalid-output";
  const outcome = `caught:${caught[2]}`;
  if (caught[2] === "InternalError" && (!nativeFirefox || caught[4] !== "too much recursion")) return `unexpected:${caught[2]}`;
  return acceptedStackOutcome(mode, outcome) ? outcome : `unexpected:${caught[2]}`;
}

async function measurePath(attempt: Attempt, host: string, mode: string): Promise<Row> {
  const failures: Failure[] = [];
  async function trial(depth: number) {
    const outcome = await attempt(mode, depth);
    if (!acceptedStackOutcome(mode, outcome)) failures.push({ depth, outcome });
    return outcome;
  }
  // Each bind prefixes the name with "bound ", so deeper chains run out of memory first.
  let high = mode === "bound" ? 2000 : 200000;
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

export async function measureStackPaths(attempt: Attempt, host: string, report: (row: Row) => void): Promise<boolean> {
  let failed = false;
  for (const mode of stackModes) {
    const row = await measurePath(attempt, host, mode);
    report(row);
    failed ||= row.failures.length > 0;
  }
  return failed;
}
