// A bundled library can be a single function with thousands of local variables: TypeScript's
// compiler wraps its whole source in one whose frame has 5,278 of them. That storage is data,
// not call depth, so calling such a function must fit the 32 and 36 KiB QuickJS stack budgets
// browsers off V8 pass (docs/stack-limits.md). Where QuickJS's own parser compiles the source,
// the children run with those budgets; other engines keep the budget they were started with
// and only have to produce the same output.
const { spawnSync }: typeof import("node:child_process") = require("node:child_process");

// process.versions is shared by the engines. Recognise measured parser errors and fail
// closed if that identity changes, rather than silently exempting a QuickJS regression.
function quickjsParser(): boolean {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  try { (0, eval)("let let = 1"); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (error.message === "'let' is not a valid lexical identifier") return true;
    if (error.message === "Unexpected keyword 'let'. Cannot use 'let' as an identifier name for a LexicalDeclaration." ||
        error.message === "let is disallowed as a lexically bound name") return false;
    throw new Error("Unrecognized parser fingerprint", { cause: error });
  }
  throw new Error("Invalid lexical declaration was accepted");
}

const locals = 5300;
type Library = { first(): number; last(): number; total(): number; bump(): void; nested(depth: number): number };

// One function whose every local is captured by an inner function, like a bundled library.
function librarySource(): string {
  const names = Array.from({ length: locals }, (_, i) => `v${i}`);
  return `${names.map((name, i) => `var ${name} = ${i};`).join("\n")}
function total() { return ${names.join(" + ")}; }
function nested(depth) { return depth === 0 ? total() : nested(depth - 1); }
return { first() { return v0; }, last() { return v${locals - 1}; }, total, nested, bump() { v0++; v${locals - 1}++; } };`;
}

function unbounded(): number { return 1 + unbounded(); }

function main(): void {
  const create = new Function(librarySource()) as () => Library;
  const library = create();
  console.log("large frame", library.first(), library.last(), library.total());
  library.bump();
  console.log("captured locals outlive the frame", library.first(), library.last(), library.total());
  // Each call needs its own storage, also when made from inside other calls.
  const others = Array.from({ length: 8 }, () => create());
  others[3]!.bump();
  console.log("separate frames", others.map(other => other.first()).join(), library.nested(20));
  const inside = (depth: number): number => (depth === 0 ? create().total() : inside(depth - 1));
  console.log("large frame under calls", inside(20));
  let caught = "";
  try { unbounded(); } catch (error) { caught = (error as Error).name; }
  console.log("unbounded recursion", caught);
  console.log("continued", create().total());
}

if (process.argv[2] === "run") {
  main();
} else {
  const budgets = quickjsParser() ? ["32", "36"] : [undefined, undefined];
  for (const budget of budgets) {
    const env = budget ? { ...process.env, BUN_WASM_STACK_KIB: budget } : process.env;
    const child = spawnSync(process.execPath, [__filename, "run"], { env, encoding: "utf8" });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(`frame storage child exited ${child.status}`);
  }
}
