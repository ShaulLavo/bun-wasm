// Deep `await using` nests on JSC's statement records (docs/bun-patches/jsc-statement-records.md):
// 300 nested blocks, each with one `await using`, in 8-bit and 16-bit sources. Each completion runs
// against the flat equivalent (the same 300 declarations in one block), and the two must acquire
// and dispose identically: normal order, a throw, a return, a labelled break out of the nest, and
// every disposer rejecting (a SuppressedError chain walked without recursion). Then a nest past the
// parser's record limit must be refused before acquiring anything, and a shallow nest still runs.
//
// The depth is bounded on purpose. Compiling a nest of N `await using` levels costs JSC time that
// grows much faster than N (generatorification saves every live register at every await, and a nest
// keeps every level's registers live): native Bun needs about 75 seconds at 1,000 levels. This
// fixture does not claim anything about deeper async nests.
type Log = string[];
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const depth = 300;
const modes = ["order", "throw", "return", "label", "fail"] as const;
type Mode = (typeof modes)[number];
const repeat = (count: number, text: (index: number) => string) => Array.from({ length: count }, (_, index) => text(index)).join("");
const widen = (source: string, wide: boolean) => (wide ? `/* ☃ */${source}` : source);

const tail = 'log.push("body"); if (mode === "throw" || mode === "fail") throw new Error("body"); if (mode === "return") return "returned"; if (mode === "label") break out;';
const nested = (count: number) => `out: { ${repeat(count, i => `{ await using r${i} = res("r${i}");`)} ${tail} ${"}".repeat(count)} } return "fell through";`;
const flat = (count: number) => `out: { { ${repeat(count, i => `await using r${i} = res("r${i}");`)} ${tail} } } return "fell through";`;

function resources(log: Log, fail: boolean) {
  return (name: string) => {
    log.push(name);
    return {
      [Symbol.asyncDispose]() {
        log.push(`~${name}`);
        return fail ? Promise.reject(new Error(name)) : Promise.resolve();
      },
    };
  };
}

/** A thrown value as a short string: SuppressedError chains are walked in a loop, never printed. */
function describe(error: unknown): string {
  let suppressed = 0;
  let current = error;
  while (current instanceof SuppressedError) {
    suppressed++;
    current = current.suppressed;
  }
  const last = current instanceof Error ? `${current.name}: ${current.message}` : String(current);
  return suppressed ? `${suppressed} suppressed errors over ${last}` : last;
}

async function run(fn: (...args: unknown[]) => Promise<unknown>, mode: Mode): Promise<{ outcome: string; log: Log }> {
  const log: Log = [];
  try {
    return { outcome: `returned ${JSON.stringify(await fn(resources(log, mode === "fail"), log, mode))}`, log };
  } catch (error) {
    return { outcome: `threw ${describe(error)}`, log };
  }
}

function disposalShape(log: Log): string {
  const acquired = log.filter(entry => !entry.startsWith("~") && entry !== "body");
  const disposed = log.filter(entry => entry.startsWith("~")).map(entry => entry.slice(1));
  const reversed = disposed.length === acquired.length && disposed.every((name, index) => name === acquired[acquired.length - 1 - index]);
  return `${acquired.length} acquired, ${disposed.length} disposed${reversed ? " in reverse" : " OUT OF ORDER"}`;
}

for (const wide of [false, true]) {
  const width = wide ? ", 16-bit" : "";
  const nestedFn = new AsyncFunction("res", "log", "mode", widen(nested(depth), wide));
  const flatFn = new AsyncFunction("res", "log", "mode", widen(flat(depth), wide));
  for (const mode of modes) {
    const deep = await run(nestedFn, mode);
    const level = await run(flatFn, mode);
    const same = deep.outcome === level.outcome && JSON.stringify(deep.log) === JSON.stringify(level.log);
    console.log(`await using ${mode}${width}: ${deep.outcome}; ${disposalShape(deep.log)}; ${same ? "same as flat" : `DIFFERS from flat (${level.outcome})`}`);
  }
}

// Past the parser's record limit: refused before anything is acquired, then a shallow nest runs.
for (const wide of [false, true]) {
  const width = wide ? ", 16-bit" : "";
  const log: Log = [];
  let outcome: string;
  try {
    await new AsyncFunction("res", "log", "mode", widen(nested(10001), wide))(resources(log, false), log, "order");
    outcome = log.length === 2 * 10001 + 1 ? "ran in full" : "ran partly";
  } catch (error) {
    outcome = error instanceof RangeError && log.length === 0 ? "refused before acquiring anything" : `unexpected ${describe(error)} after ${log.length} log entries`;
  }
  const shallow = await run(new AsyncFunction("res", "log", "mode", widen(nested(3), wide)), "order");
  const recovered = shallow.outcome === 'returned "fell through"' && disposalShape(shallow.log) === "3 acquired, 3 disposed in reverse";
  // Engines without JSC's record limit may run the nest instead; either is accepted, nothing else.
  // BUNWASM_STATEMENT_RECORDS_EXACT=1, set by the JSC embedding gate, requires the refusal.
  const exact = process.env.BUNWASM_STATEMENT_RECORDS_EXACT === "1";
  const accepted = outcome === "refused before acquiring anything" || (!exact && outcome === "ran in full");
  console.log(`await using past the record limit${width}: ${accepted ? "refused or ran in full" : outcome}; shallow nest afterwards ${recovered ? "ran" : "FAILED"}`);
  if (!accepted || !recovered) process.exitCode = 1;
}
