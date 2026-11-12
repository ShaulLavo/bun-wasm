// Blocks and `if` statements keep their meaning while JSC emits a nest of them in one loop instead
// of one native call per level, and `using` blocks open and close their disposal scope from that
// loop (docs/bun-patches/jsc-statement-spine.md). Completion values, folded `break` and `continue`,
// abrupt completion through `finally`, and `using` disposal order and errors must match native Bun
// on every engine. Every body reaches the engine as a string, so Bun's transpiler never rewrites it.
type Log = string[];
type Resource = { [Symbol.dispose]?: () => void; [Symbol.asyncDispose]?: () => Promise<void> };

const indirectEval = eval;
// oxlint-disable-next-line no-new-func -- The code generator under test compiles each generated body.
const compile = (params: string[], body: string) => new Function(...params, body);
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : `thrown ${String(error)}`;
}

function show(label: string, run: () => unknown): void {
  try {
    console.log(`${label}: ${JSON.stringify(run())}`);
  } catch (error) {
    // Engines word their syntax errors differently; the class is what must match.
    console.log(`${label}: ${error instanceof Error ? error.name : `thrown ${String(error)}`}`);
  }
}

const repeat = (count: number, level: (index: number) => string) => Array.from({ length: count }, (_, index) => level(index)).join("");
const blocks = (count: number, inner: string) => `${"{".repeat(count)}${inner}${"}".repeat(count)}`;
const ifs = (count: number, inner: string) => `${repeat(count, () => "if (t) {")}${inner}${"}".repeat(count)}`;
const mixed = (count: number, inner: string) => `${repeat(count, i => [`L${i}: {`, "if (t) {", "{"][i % 3])}${inner}${"}".repeat(count)}`;

// Completion values: direct eval, indirect eval and function code all reach the same emitters.
const completionCases: [string, string][] = [
  ["value at the bottom", blocks(30, "1;")],
  ["empty innermost block", `2; ${blocks(30, "")}`],
  ["declaration-only block", `3; ${blocks(30, "let a = 1; const b = 2;")}`],
  ["break at the bottom", `do { 4; ${blocks(30, "break;")} } while (0)`],
  ["continue at the bottom", `for (var i = 0; i < 2; i++) { 5 + i; ${blocks(20, "continue;")} }`],
  ["labelled break out of a nest", `A: { ${blocks(20, "6; break A;")} 7; }`],
  ["mixed block, label and if nest", `var t = true; ${mixed(30, "8;")}`],
  ["mixed nest with break at the bottom", `var t = true; X: { 9; ${mixed(30, "break X;")} 10; }`],
  ["if without else after a value", "11; if (0) { 12; }"],
  ["empty then branch", "13; if (1) { }"],
  ["value in an else branch", `if (0) { 14; } else { ${blocks(10, "15;")} }`],
  ["folded break", "while (true) { 16; if (1) break; }"],
  ["folded break with else", "while (true) { 17; if (1) break; else 18; }"],
  ["folded continue then a deep else", `for (var i = 0; i < 3; i++) { if (i < 2) { continue; } else { ${blocks(10, "19 + i;")} } }`],
  ["else-if chain", `var k = 5; ${repeat(9, i => `if (k === ${i}) { ${i}; } else `)}{ 20; }`],
];
for (const [label, source] of completionCases) {
  show(`direct eval, ${label}`, () => eval(source));
  show(`indirect eval, ${label}`, () => indirectEval(source));
}
show("function code, value at the bottom", () => compile(["t"], `${ifs(30, "return 21;")} return 0;`)(true));

// Folded break and continue: `if (c) break;` jumps straight to the loop's target.
const loops: [string, string][] = [
  ["folded break", "for (let i = 0; i < 9; i++) { if (i === 3) break; n++; }"],
  ["folded break in a block", "for (let i = 0; i < 9; i++) { if (i === 3) { break; } n++; }"],
  ["folded break with else", "for (let i = 0; i < 9; i++) { if (i === 3) break; else n++; }"],
  ["folded continue", "for (let i = 0; i < 9; i++) { if (i % 2) continue; n += i; }"],
  ["folded continue with else", "for (let i = 0; i < 9; i++) { if (i % 2) { continue; } else { n += i; } }"],
  ["folded continue under outer records", `for (let i = 0; i < 9; i++) { ${blocks(12, "if (i % 3) { continue; } n += i;")} }`],
  ["folded then before a deep else", `for (let i = 0; i < 9; i++) { if (i === 5) { break; } else { ${ifs(12, "n++;")} } }`],
  ["labelled continue across blocks", `outer: for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) { ${blocks(8, "if (j === 1) continue outer; n++;")} } }`],
];
for (const [label, source] of loops) show(label, () => compile(["t"], `let n = 0; ${source} return n;`)(true));

// Abrupt completion through finally under a spine of blocks and ifs.
show("return through two finally blocks", () => compile(["t"], `const log = []; function f() { try { ${ifs(10, `{ try { return "r"; } finally { log.push("inner"); } }`)} } finally { log.push("outer"); } } return [f(), log];`)(true));
show("throw through finally", () => compile(["t"], `const log = []; try { ${blocks(10, `try { throw new Error("x"); } finally { log.push("f"); }`)} } catch (e) { log.push(e.message); } return log;`)(true));
show("tail position return under a spine", () => compile(["t"], `"use strict"; function f(n) { ${ifs(8, "{ if (n) { return f(n - 1); } }")} return "done"; } return f(500);`)(true));

// `using` blocks: acquisition and disposal order, abrupt completion, disposal errors.
function resources(log: Log) {
  return {
    res(name: string, fail = false): Resource {
      log.push(`acquire ${name}`);
      return { [Symbol.dispose]() { log.push(`dispose ${name}`); if (fail) throw new Error(`dispose ${name} failed`); } };
    },
    ares(name: string, fail = false): Resource {
      log.push(`acquire ${name}`);
      return {
        [Symbol.asyncDispose]() {
          log.push(`dispose ${name}`);
          return fail ? Promise.reject(new Error(`dispose ${name} failed`)) : Promise.resolve();
        },
      };
    },
  };
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  while (current instanceof SuppressedError) {
    parts.push(`suppressed(${errorName(current.error)})`);
    current = current.suppressed;
  }
  parts.push(errorName(current));
  return parts.join(" <- ");
}

function usingRow(label: string, body: string): void {
  const log: Log = [];
  const { res, ares } = resources(log);
  let result: unknown;
  try {
    result = compile(["res", "ares", "log", "t"], body)(res, ares, log, true);
  } catch (error) {
    result = errorChain(error);
  }
  console.log(`using, ${label}: ${JSON.stringify(result)} | ${log.join(", ")}`);
}

const nest = (count: number, inner: string) => `${repeat(count, i => `{ using r${i} = res("r${i}");`)} ${inner} ${"}".repeat(count)}`;
usingRow("three nested blocks", '{ using a = res("a"); { using b = res("b"), c = res("c"); { using d = res("d"); log.push("body"); } } } return "ok";');
usingRow("throw from the innermost", `try { ${nest(4, 'throw new Error("x");')} } catch (e) { log.push("caught " + e.message); }`);
usingRow("return computed before disposal", `${nest(4, 'return (log.push("ret"), "v");')}`);
usingRow("break and continue", 'for (let i = 0; i < 3; i++) { using a = res("a" + i); { using b = res("b" + i); if (i === 0) continue; if (i === 1) { log.push("brk"); break; } } }');
usingRow("labelled break across levels", 'outer: for (let i = 0; i < 2; i++) { using a = res("a"); inner: { using b = res("b"); { using c = res("c"); if (i === 0) continue outer; break outer; } } }');
usingRow("return from try-finally inside using", `function f() { ${nest(3, 'try { return "t"; } finally { log.push("finally"); }')} } return f();`);
usingRow("generator ended early", 'function* g() { using a = res("a"); { using b = res("b"); yield 1; yield 2; } } const it = g(); it.next(); return it.return(9);');
usingRow("disposer throws after a normal body", '{ using a = res("a"); { using b = res("b", true); log.push("body"); } }');
usingRow("disposer throws after a throwing body", '{ using a = res("a"); { using b = res("b", true); throw new Error("body"); } }');
usingRow("every level throws", `${repeat(5, i => `{ using r${i} = res("r${i}", true);`)} throw new Error("body"); ${"}".repeat(5)}`);
usingRow("null resource", '{ using a = null, b = undefined, c = res("c"); log.push("body"); }');
usingRow("folded break in a using block", 'for (let i = 0; i < 4; i++) { using a = res("a" + i); if (i === 1) break; }');
usingRow("folded continue in a plain block", 'for (let i = 0; i < 3; i++) { using a = res("a" + i); { if (i === 1) continue; else log.push("e" + i); } }');
usingRow("alternating if and using block", `${repeat(6, i => (i % 2 ? `{ using r${i} = res("r${i}");` : "if (t) {"))} log.push("body"); ${"}".repeat(6)}`);
usingRow("using in then and else", 'for (const c of [true, false]) { if (c) { using a = res("then"); } else { using b = res("else"); } }');
usingRow("else-if chain of using blocks", 'for (const k of [0, 1, 2]) { if (k === 0) { using a = res("k0"); } else if (k === 1) { using b = res("k1"); } else { using c = res("k2"); } }');
usingRow("using in try, catch and finally", 'try { using a = res("try"); throw new Error("x"); } catch { using b = res("catch"); } finally { using c = res("finally"); }');
usingRow("for-of and for with using", 'for (using x of [res("x0"), res("x1")]) { using y = res("y"); } for (using z = res("z"); ; ) { using w = res("w"); break; }');
usingRow("deep spine", nest(30, 'log.push("body");'));
show("using in a block through direct eval", () => {
  const log: Log = [];
  const { res } = resources(log);
  void res;
  return [eval('{ using a = res("a"); 5; }'), log];
});
show("using at the top level of eval", () => indirectEval("using a = null;"));
show("using in a top-level block of eval", () => indirectEval("{ using a = null; 6; }"));
show("using directly in a switch case", () => compile([], "switch (1) { case 1: using a = null; }"));
show("using in a block in a switch case", () => compile([], "switch (1) { case 1: { using a = null; } } return 7;")());
show("using in a switch case under blocks", () => compile([], blocks(30, "switch (1) { case 1: using a = null; }")));
show("using in a block in a case under blocks", () => compile([], `${blocks(30, "switch (1) { case 1: { using a = null; } }")} return 8;`)());

// Long runs of labels: a block's stored answers must not walk a label chain at parse time.
const labels = (count: number) => repeat(count, i => `l${i}: `);
show("long labels, called", () => compile([], `{ ${labels(300)} ; } return 9;`)());
show("long labels, later syntax error", () => compile([], `{ ${labels(300)} ; } return 9; )`));
show("long labels in eval", () => indirectEval(`{ ${labels(300)} 10; }`));

async function asyncRows(): Promise<void> {
  const rows: [string, string][] = [
    ["await using order", '{ await using a = ares("a"); { using b = res("b"); await using c = ares("c"); log.push("body"); } }'],
    ["await using null and sync after async", '{ await using a = null; using b = res("b"); await using c = ares("c"); log.push("body"); }'],
    ["async disposer rejects", '{ await using a = ares("a"); { await using b = ares("b", true); log.push("body"); } }'],
    ["async throw through every level", `${repeat(4, i => `{ await using r${i} = ares("r${i}", true);`)} throw new Error("body"); ${"}".repeat(4)}`],
    ["async deep spine", `${repeat(20, i => `if (t) { await using r${i} = ares("r${i}");`)} log.push("body"); ${"}".repeat(20)}`],
    ["async disposal ticks", 'Promise.resolve().then(() => log.push("tick 1")).then(() => log.push("tick 2")); { await using a = ares("a"); await using b = ares("b"); } log.push("after");'],
  ];
  for (const [label, body] of rows) {
    const log: Log = [];
    const { res, ares } = resources(log);
    let result: unknown;
    try {
      result = await new AsyncFunction("res", "ares", "log", "t", body)(res, ares, log, true);
    } catch (error) {
      result = errorChain(error);
    }
    console.log(`async using, ${label}: ${JSON.stringify(result)} | ${log.join(", ")}`);
  }
}
await asyncRows();
