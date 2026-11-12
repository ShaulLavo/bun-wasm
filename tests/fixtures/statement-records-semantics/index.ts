// JSC parses a nest of blocks and `if` statements in one parseStatement activation instead of one
// native call per level (docs/bun-patches/jsc-statement-records.md). Every statement form a block
// or a branch can start with, function declarations as branches, dangling `else`, `else if` chains,
// `using` placement, closures and the end of a statement list must match native Bun on every
// engine. Deep rows follow one outcome rule: a nest either runs with the right effects, or is
// refused with a RangeError before any of its code runs and a shallow nest of the same shape still
// runs afterwards. Either prints `ok`. Every body reaches the engine as a string.
const indirectEval = eval;
// oxlint-disable-next-line no-new-func -- The parser under test compiles each generated body.
const compile = (params: string[], body: string) => new Function(...params, body);
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const r = (count: number, text: (index: number) => string) => Array.from({ length: count }, (_, index) => text(index)).join("");
const blocks = (count: number, inner: string) => `${"{".repeat(count)}${inner}${"}".repeat(count)}`;
const ifs = (count: number, inner: string) => `${r(count, () => "if (t) {")}${inner}${"}".repeat(count)}`;

function show(label: string, run: () => unknown): void {
  try {
    console.log(`${label}: ${JSON.stringify(run())}`);
  } catch (error) {
    console.log(`${label}: ${error instanceof Error ? error.name : `thrown ${String(error)}`}`);
  }
}

// Each list item form as the first item of a nested block, at depth 1 and under 9 blocks.
const firstItems: [string, string][] = [
  ["const", "const v = 1; return v;"],
  ["let declaration", "let v = 2; return v;"],
  ["sloppy let as a name", "var let = 3; let; return let;"],
  ["class", "class C { m() { return 4; } } return new C().m();"],
  ["function", "function g() { return 5; } return g();"],
  ["async function", "async function g() { return 6; } return typeof g;"],
  ["escaped keyword name", "var l\\u0065t = 7; return l\\u0065t;"],
  ["identifier", "v = 8; return v;"],
  ["label", "L: { break L; } return 9;"],
  ["using", "using u = null; return 10;"],
  ["expression statement", "1 + 1; return 11;"],
  ["string, not a directive", '"use strict"; with ({}) {} return 12;'],
];
for (const [label, item] of firstItems) {
  for (const depth of [1, 9]) show(`first item ${label}, depth ${depth}`, () => compile(["t"], `var v; ${blocks(depth, item)}`)(true));
}
show("yield as the first item",() => Array.from(compile([], `return (function* () { ${blocks(9, "yield 13; yield 14;")} })();`)() as Iterable<unknown>));

// Function declarations as branches: sloppy code accepts them (Annex B), strict code does not.
show("function declaration as then branch, sloppy", () => compile([], "if (true) function f() { return 15; } return f();")());
show("function declaration as else branch, sloppy", () => compile([], "if (false) ; else function f() { return 16; } return f();")());
show("function declaration as branch under a label", () => compile([], "L: if (true) function f() { return 17; } return typeof f;")());
show("function declaration as then branch, strict", () => compile([], '"use strict"; if (true) function f() {}'));
show("function declaration as nested branch, sloppy", () => compile(["t"], `${ifs(9, "if (t) function f() { return 18; }")} return f();`)(true));

// Dangling else binds to the innermost `if`.
for (const depth of [1, 2, 9]) {
  show(`dangling else, depth ${depth}`, () => compile(["t"], `var x = []; ${r(depth, i => `if (t) x.push(${i}); if (${i % 2 ? "t" : "!t"}) `)} x.push("then"); else x.push("else"); return x;`)(true));
}

// `else if` chains, with and without a final else.
const chain = (links: number, hit: number, final: boolean) => `var k = ${hit}; ${r(links, i => `if (k === ${i}) { return ${i}; } ${i < links - 1 || final ? "else " : ""}`)}${final ? "{ return -1; }" : ""} return -2;`;
for (const links of [1, 8, 9, 2000]) {
  show(`else-if chain of ${links}, last link`, () => compile([], chain(links, links - 1, false))());
  show(`else-if chain of ${links}, final else`, () => compile([], chain(links, links, true))());
  show(`else-if chain of ${links}, no match`, () => compile([], chain(links, links, false))());
}

// `using` placement under deep nests.
show("using directly in a switch case under 300 blocks", () => compile([], blocks(300, "switch (1) { case 1: using a = null; }")));
show("using in a block in a case under 300 blocks", () => compile([], `${blocks(300, "switch (1) { case 1: { using a = null; } }")} return 19;`)());
show("using at the top level of eval", () => indirectEval("using a = null;"));
show("using in a block of eval under 300 blocks", () => indirectEval(blocks(300, "using a = null; 20;")));

// Closures capture block-scoped bindings at depth 300.
show("closures at depth 300", () => {
  const body = `const fs = []; ${r(300, i => `{ let v${i} = ${i}; fs.push(() => v${i});`)} ${"}".repeat(300)} return fs[0]() + fs[299]() + fs.length;`;
  return compile([], body)();
});

// The end of a statement list: `}`, `case`, `default` and end of input.
show("list ended by case and default", () => compile(["t"], "var x = []; switch (1) { case 1: if (t) { x.push(1); } case 2: { x.push(2); } default: x.push(3); } return x;")(true));
show("block ended by end of input", () => compile([], "{ { }"));
show("if without a branch", () => compile([], "if (1)"));
show("else without a branch", () => compile([], "if (1) ; else"));
show("syntax error at depth 1", () => compile([], blocks(1, "1 +;")));
show("syntax error at depth 9", () => compile([], blocks(9, "1 +;")));
show("syntax error at depth 300", () => compile([], blocks(300, "1 +;")));
show("syntax error in a deep if spine", () => compile(["t"], ifs(300, "return )")));
show("syntax error after a deep nest", () => compile([], `${blocks(300, "")} return );`));

// Deep nests under the outcome rule.
function outcome(label: string, run: () => boolean, shallow: () => boolean): void {
  let result: string;
  try {
    result = run() ? "ok" : "wrong effects";
  } catch (error) {
    result = error instanceof RangeError ? (shallow() ? "ok" : "refused, then a shallow nest failed") : `unexpected ${error instanceof Error ? error.name : String(error)}`;
  }
  console.log(`deep ${label}: ${result}`);
}

const deepShapes: [string, (n: number) => string, (n: number, value: unknown) => boolean][] = [
  ["blocks", n => `var x = 0; ${blocks(n, "x = 1;")} return x;`, (_, value) => value === 1],
  ["ifs", n => `var x = 0; ${ifs(n, "x = 1;")} return x;`, (_, value) => value === 1],
  ["ifs with else", n => `var x = 0; ${r(n, () => "if (t) {")} x = 1; ${"} else { x = 2; }".repeat(n)} return x;`, (_, value) => value === 1],
  ["bare ifs", n => `var x = 0; ${"if (t) ".repeat(n)} x = 1; return x;`, (_, value) => value === 1],
  ["else-if chain", n => `var k = ${n - 1}; ${r(n, i => `if (k === ${i}) { return ${i}; } else `)}{ return -1; }`, (n, value) => value === n - 1],
  ["mixed blocks, labels and ifs", n => `var x = 0; ${r(n, i => [`L${i}: {`, "if (t) {", "{"][i % 3])} x = 1; ${"}".repeat(n)} return x;`, (_, value) => value === 1],
  ["block scopes", n => `${r(n, i => `{ let v${i} = ${i};`)} return v0 === undefined; ${"}".repeat(n)}`, (_, value) => value === false],
];
for (const depth of [300, 1000, 4096, 10000]) {
  for (const [label, body, check] of deepShapes) {
    outcome(`${label} ${depth}`, () => check(depth, compile(["t"], body(depth))(true)), () => check(20, compile(["t"], body(20))(true)));
  }
}

// The record bound counts open blocks and `if`s together: 10,001 of them, then a mix.
const mixedRecords = (n: number) => `var x = 0; ${r(n, i => (i % 2 ? "{" : "if (t) {"))} x = 1; ${"}".repeat(n)} return x;`;
outcome("10001 open records", () => compile(["t"], mixedRecords(10001))(true) === 1, () => compile(["t"], mixedRecords(20))(true) === 1);
outcome("10001 records in an arrow body", () => compile(["t"], `return (() => { ${mixedRecords(10001)} })();`)(true) === 1, () => compile(["t"], `return (() => { ${mixedRecords(20)} })();`)(true) === 1);
outcome("10001 records in eval", () => indirectEval(`var t = true; ${r(10001, () => "{")} 1; ${"}".repeat(10001)}`) === 1, () => indirectEval(blocks(20, "1;")) === 1);

// Deep `using` nests: every resource acquired before an exit is disposed once, innermost first.
type Log = string[];
function makeRes(log: Log, fail: boolean) {
  return (name: string) => {
    log.push(name);
    return { [Symbol.dispose]() { log.push(`~${name}`); if (fail) throw new Error(name); } };
  };
}
function disposedInOrder(log: Log, n: number, extra: string[] = []): boolean {
  const acquired = Array.from({ length: n }, (_, i) => `r${i}`);
  const expected = acquired.concat(extra, acquired.toReversed().map(name => `~${name}`));
  return log.length === expected.length && log.every((entry, index) => entry === expected[index]);
}
function chainDepth(error: unknown): number {
  let depth = 0;
  let current = error;
  while (current instanceof SuppressedError) {
    depth++;
    current = current.suppressed;
  }
  return current instanceof Error && current.message === "body" ? depth : -1;
}
const usingNest = (n: number, inner: string) => `${r(n, i => `{ using r${i} = res("r${i}");`)} ${inner} ${"}".repeat(n)}`;
const usingRows: [string, (n: number) => string, boolean, (n: number, log: Log, value: unknown) => boolean][] = [
  ["using order", n => usingNest(n, 'log.push("body");'), false, (n, log) => disposedInOrder(log, n, ["body"])],
  ["using throw", n => `try { ${usingNest(n, 'throw new Error("x");')} } catch (e) { return e.message; }`, false, (n, log, value) => value === "x" && disposedInOrder(log, n)],
  ["using return", n => usingNest(n, 'return "v";'), false, (n, log, value) => value === "v" && disposedInOrder(log, n)],
  ["using labelled break", n => `out: for (;;) { ${usingNest(n, "break out;")} } return "b";`, false, (n, log, value) => value === "b" && disposedInOrder(log, n)],
  ["using every level fails", n => `try { ${usingNest(n, 'throw new Error("body");')} } catch (e) { return e; }`, true, (n, log, value) => chainDepth(value) === n && disposedInOrder(log, n)],
];
for (const depth of [300, 1000, 4096, 10000]) {
  for (const [label, body, fail, check] of usingRows) {
    const run = (n: number, log: Log) => check(n, log, compile(["res", "log"], body(n))(makeRes(log, fail), log));
    const log: Log = [];
    // A refused nest must not have acquired anything.
    outcome(`${label} ${depth}`, () => run(depth, log), () => log.length === 0 && run(20, []));
  }
}

async function asyncRows(): Promise<void> {
  try {
    console.log(`await as the first item: ${JSON.stringify(await new AsyncFunction(blocks(9, "await null; return 21;"))())}`);
  } catch (error) {
    console.log(`await as the first item: ${error instanceof Error ? error.name : String(error)}`);
  }
  try {
    const log: Log = [];
    await new AsyncFunction("res", "log", blocks(9, 'await using a = res("a"); log.push("body");'))(makeRes(log, false), log);
    console.log(`await using as the first item: ${log.join(", ")}`);
  } catch (error) {
    console.log(`await using as the first item: ${error instanceof Error ? error.name : String(error)}`);
  }
  // Deeper `await using` nests are slow to compile in JSC itself (generatorification is
  // quadratic in live registers, and a nest keeps every level's registers live), native Bun included.
  for (const depth of [300]) {
    const log: Log = [];
    let result: string;
    try {
      const body = `${r(depth, i => `{ await using r${i} = res("r${i}");`)} log.push("body"); ${"}".repeat(depth)}`;
      await new AsyncFunction("res", "log", body)(makeRes(log, false), log);
      result = disposedInOrder(log, depth, ["body"]) ? "ok" : "wrong effects";
    } catch (error) {
      result = error instanceof RangeError && log.length === 0 ? "ok" : `unexpected ${error instanceof Error ? error.name : String(error)}`;
    }
    console.log(`deep await using order ${depth}: ${result}`);
  }
}
await asyncRows();
