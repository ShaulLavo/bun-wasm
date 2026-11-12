// Deep chained assignments through each of the nine assignment forms JSC's code generator emits:
// a resolved name (local or global), a property or a computed key, each with `=`, a compound
// operator and a logical operator; in value, ignored-result and condition positions; 8-bit and
// 16-bit sources; one chain mixing all nine; and chains reached inside still-recursive routes.
// JSC parses such a chain without recursion, so its code generator is what refuses one that is too
// deep (docs/bun-patches/jsc-assignment-chains.md). A refusal must be a catchable RangeError that
// runs no setter, getter or right side, and the same shape must work again afterwards.
// BUNWASM_STACK_EXPECT_CAUGHT=1 requires JSC's refusal: the parser accepts the chain, and its first
// call throws RangeError("Out of memory") while generating code. Engines and settings that load the
// chain must run every setter once. `bun run index.ts capacity` prints each row's deepest loading chain.
const deep = 10000;
const shallow = 40;
const mustRefuse = process.env.BUNWASM_STACK_EXPECT_CAUGHT === "1";

interface Counts { gets: number; sets: number; rhs: number }
interface Harness { o: { p: unknown }; k: string; seed: unknown; rhs(): number; f(value: unknown): unknown }
/** `sets` is how many target setters a loaded chain of `depth` levels runs: local names have none. */
interface Row { name: string; body(depth: number): string; seed: unknown; global: boolean; wide: boolean; sets(depth: number): number }
type Kind = "resolve" | "global" | "dot" | "bracket";
type Form = "simple" | "compound" | "logical";
type Position = "value" | "ignored" | "condition";

const globalName = "__assignmentChainTarget";
const counts: Counts = { gets: 0, sets: 0, rhs: 0 };
let stored: unknown;

function accessor() {
  return {
    get() { counts.gets++; return stored; },
    set(value: unknown) { counts.sets++; stored = value; },
    configurable: true,
  };
}

const operators: Record<Form, string> = { simple: "=", compound: "+=", logical: "||=" };
// Seeds that make every level of the form evaluate its right side.
const seeds: Record<Form, unknown> = { simple: 0, compound: 1, logical: 0 };

function target(kind: Kind): string {
  if (kind === "resolve") return "a";
  if (kind === "global") return globalName;
  return kind === "dot" ? "h.o.p" : "h.o[h.k]";
}

function chain(kind: Kind, form: Form, depth: number): string {
  return `${target(kind)} ${operators[form]} `.repeat(depth) + "h.rhs()";
}

function wrap(position: Position, expression: string, local: boolean): string {
  const declaration = local ? "let a = h.seed;\n" : "";
  if (position === "value") return `${declaration}return ${expression};`;
  if (position === "ignored") return `${declaration}${expression};\nreturn 0;`;
  return `${declaration}if (${expression}) return 1;\nreturn 0;`;
}

const nine: readonly (readonly [Kind, Form])[] = (["resolve", "dot", "bracket"] as const).flatMap(kind =>
  (["simple", "compound", "logical"] as const).map(form => [kind, form] as const));

function mixed(depth: number): string {
  let source = "";
  for (let index = 0; index < depth; index++) {
    const [kind, form] = nine[index % nine.length]!;
    source += `${target(kind)} ${operators[form]} `;
  }
  return `${source}h.rhs()`;
}

function rows(): Row[] {
  const list: Row[] = [];
  for (const [kind, form] of nine.concat([["global", "simple"], ["global", "compound"], ["global", "logical"]])) {
    for (const position of ["value", "ignored", "condition"] as const) {
      for (const wide of [false, true]) {
        const name = `${kind} ${form} ${position}${wide ? " 16" : ""}`;
        const sets = (depth: number) => (kind === "resolve" ? 0 : depth);
        list.push({ name, body: depth => wrap(position, chain(kind, form, depth), kind === "resolve"), seed: seeds[form], global: kind === "global", wide, sets });
      }
    }
  }
  // Every level's form differs from the next. All reads come before any write, so the 0 seed
  // sends every `||=` on to its right side and each property level runs its setter.
  const mixedSets = (depth: number) => Array.from({ length: depth }, (_, index) => nine[index % nine.length]![0]).filter(kind => kind !== "resolve").length;
  list.push({ name: "mixed nine forms", body: depth => wrap("value", mixed(depth), true), seed: 0, global: false, wide: false, sets: mixedSets });
  // A chain inside routes whose parser levels still recurse: call arguments, a parenthesized
  // conditional branch, and an arrow body that is generated only when the arrow is called.
  const all = (depth: number) => depth;
  list.push({ name: "inside nested calls", body: depth => `return ${"h.f(".repeat(8)}${chain("dot", "simple", depth)}${")".repeat(8)};`, seed: 0, global: false, wide: false, sets: all });
  list.push({ name: "inside a conditional", body: depth => `return h.o ? (${chain("bracket", "compound", depth)}) : 0;`, seed: 1, global: false, wide: true, sets: all });
  list.push({ name: "inside a lazy arrow", body: depth => `const lazy = () => ${chain("dot", "logical", depth)};\nreturn lazy();`, seed: 0, global: false, wide: false, sets: all });
  return list;
}

function harness(seed: unknown): Harness {
  stored = seed;
  counts.gets = 0;
  counts.sets = 0;
  counts.rhs = 0;
  const o = Object.defineProperty({}, "p", accessor()) as { p: unknown };
  return { o, k: "p", seed, rhs() { counts.rhs++; return 1; }, f: value => value };
}

type Outcome = { loaded: true; result: unknown } | { loaded: false; error: unknown; compiled: boolean };

function attempt(row: Row, depth: number): Outcome {
  const h = harness(row.seed);
  let compiled = false;
  try {
    // oxlint-disable-next-line no-new-func -- The engine under test parses and generates this body.
    const body = new Function("h", (row.wide ? "/* ☃ */\n" : "") + row.body(depth)) as (h: Harness) => unknown;
    compiled = true;
    return { loaded: true, result: body(h) };
  } catch (error) {
    return { loaded: false, error, compiled };
  }
}

function refusalProblem(outcome: Extract<Outcome, { loaded: false }>): string | null {
  const { error, compiled } = outcome;
  const name = error instanceof Error ? error.name : typeof error;
  if (!(error instanceof RangeError) && !(!mustRefuse && name === "InternalError")) return `threw ${name}: ${String(error)}`;
  if (counts.gets || counts.sets || counts.rhs) return `refused after ${counts.gets} gets, ${counts.sets} sets and ${counts.rhs} right sides`;
  if (!mustRefuse) return null;
  if (!compiled) return "the parser refused a chain it no longer recurses for";
  return (error as Error).message === "Out of memory" ? null : `refused with ${JSON.stringify((error as Error).message)}`;
}

function loadProblem(row: Row, depth: number): string | null {
  if (counts.rhs !== 1) return `ran the right side ${counts.rhs} times`;
  return counts.sets === row.sets(depth) ? null : `ran ${counts.sets} of ${row.sets(depth)} setters`;
}

/** One attempt: loaded with every effect, or refused with none. Throws on anything else. */
function check(row: Row, depth: number): boolean {
  const outcome = attempt(row, depth);
  const problem = outcome.loaded ? loadProblem(row, depth) : refusalProblem(outcome);
  if (problem) throw new Error(`${row.name} at ${depth}: ${problem}`);
  return outcome.loaded;
}

function withGlobal<T>(row: Row, run: () => T): T {
  if (!row.global) return run();
  Object.defineProperty(globalThis, globalName, accessor());
  try { return run(); } finally { delete (globalThis as Record<string, unknown>)[globalName]; }
}

function control(row: Row): void {
  const loaded = withGlobal(row, () => check(row, deep));
  if (mustRefuse && loaded) throw new Error(`${row.name}: ${deep} targets loaded past JSC's guard`);
  // The guest keeps working, and the same shape compiles again.
  withGlobal(row, () => { if (!check(row, shallow)) throw new Error(`${row.name}: ${shallow} targets no longer load`); });
  console.log(`${row.name}: ok`);
}

function capacity(row: Row): number {
  return withGlobal(row, () => {
    if (check(row, deep)) return deep;
    let low = 0;
    let high = deep;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (check(row, middle)) low = middle;
      else high = middle;
    }
    return low;
  });
}

if (process.argv[2] === "capacity") {
  console.log("capacities", JSON.stringify(Object.fromEntries(rows().map(row => [row.name, capacity(row)]))));
} else {
  for (const row of rows()) control(row);
}
console.log("continued");
