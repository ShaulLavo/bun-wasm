// Ordinary functions calling ordinary functions is how most JavaScript nests: a parser's
// recursive descent, a tree walk, a chain of small helpers. On QuickJS those calls run inside
// one interpreter activation and take no native stack, so they must go far deeper than the
// 32 and 36 KiB stack budgets browsers off V8 pass could ever hold natively
// (docs/stack-limits.md), and unbounded recursion must still end in a RangeError the program
// can catch. Where QuickJS's own parser compiles the source, the children run with those
// budgets and a depth no native budget of that size reaches; other engines keep the budget
// they were started with, run a modest depth, and only have to produce the same output.
const { spawnSync }: typeof import("node:child_process") = require("node:child_process");

// process.versions is shared by the engines. Recognise measured parser errors and fail
// closed if that identity changes, rather than silently exempting a QuickJS regression.
function quickjsParser(): boolean {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  try { (0, eval)("let let = 1"); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (error.message === "'let' is not a valid lexical identifier") return true;
    if (error.message === "Unexpected keyword 'let'. Cannot use 'let' as an identifier name for a LexicalDeclaration." ||
        error.message === "let is disallowed as a lexically bound name" || error.message === "a lexical declaration can't define a 'let' binding") return false;
    throw new Error("Unrecognized parser fingerprint", { cause: error });
  }
  throw new Error("Invalid lexical declaration was accepted");
}

function direct(n: number): number { return n === 0 ? 0 : 1 + direct(n - 1); }
function even(n: number): number { return n === 0 ? 0 : 1 + odd(n - 1); }
function odd(n: number): number { return 1 + even(n - 1); }
const walker = {
  step(n: number): number { return n === 0 ? 0 : 1 + this.step(n - 1); },
  last(n: number, total: number): number { return n === 0 ? total : this.last(n - 1, total + 1); },
};
let remaining = 0;
function countdown(): number { return remaining-- === 0 ? 0 : 1 + countdown(); }
function wide(n: number, a: number, b: number, c: number, d: number): number { return n === 0 ? a + b + c + d : 1 + wide(n - 1, a, b, c, d); }
function sparse(n: number, a?: number, b?: number): number { return n === 0 ? (a ?? 0) + (b ?? 0) : 1 + sparse(n - 1); }
function last(n: number, total: number): number { return n === 0 ? total : last(n - 1, total + 1); }
function guarded(n: number, log: { unwound: number }): number {
  try {
    if (n === 0) throw new RangeError("bottom");
    return 1 + guarded(n - 1, log);
  } finally { log.unwound++; }
}
function unbounded(): number { return 1 + unbounded(); }
function throughNative(n: number): number { return [n].map(next => throughNative(next + 1))[0]!; }

function caught(action: () => unknown): string {
  try { action(); } catch (error) { return (error as Error).name; }
  return "returned";
}

function main(depth: number): void {
  console.log("direct", direct(depth) === depth);
  console.log("mutual", even(depth * 2) === depth * 2);
  console.log("method", walker.step(depth) === depth);
  remaining = depth;
  console.log("no arguments", countdown() === depth);
  console.log("many arguments", wide(depth, 1, 2, 3, 4) === depth + 10);
  console.log("fewer arguments than parameters", sparse(depth) === depth);
  console.log("tail positions", last(depth, 0) === depth, walker.last(depth, 0) === depth);
  const log = { unwound: 0 };
  console.log("exception through frames", caught(() => guarded(depth, log)), log.unwound === depth + 1);
  console.log("unbounded recursion", caught(unbounded));
  console.log("after the refusal", direct(depth) === depth);
  console.log("recursion through a native function", caught(() => throughNative(0)));
  console.log("continued", walker.step(depth) === depth);
}

if (process.argv[2] === "run") {
  main(Number(process.argv[3]));
} else {
  const quickjs = quickjsParser();
  for (const budget of quickjs ? ["32", "36"] : [undefined, undefined]) {
    const env = budget ? { ...process.env, BUN_WASM_STACK_KIB: budget } : process.env;
    const child = spawnSync(process.execPath, [__filename, "run", quickjs ? "5000" : "200"], { env, encoding: "utf8" });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(`inline calls child exited ${child.status}`);
  }
}
