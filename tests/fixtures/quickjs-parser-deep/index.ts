// QuickJS parses nested statements in a loop over heap records (docs/stack-limits.md), so the
// compiler's stack no longer limits statement nesting. The children run with the 32 and 36 KiB
// budgets browsers off V8 pass. Compiling a deep body is separate from calling it: a nested
// switch, iterator or catch keeps a value slot per level at run time, so those bodies are only
// compiled here and run at modest depth in stack-statement-nesting.
//
// The strict expectations apply where QuickJS's own parser compiles the source. Other engines
// keep their own limits, so there each case only has to compile or refuse with a catchable
// error and continue. A wasm trap prints nothing and fails the fixture on every engine.
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
const strict = quickjsParser();
const recordLimit = 10000;
type Shape = { name: string; open: string; inner: string; close: string; perLevel: number; wrapper?: [string, string, number]; asynchronous?: boolean; depth?: number };

// perLevel is how many statement records one repeated level keeps suspended: a statement that
// contains a statement holds one, and a braced body adds one for its block. A label directly on
// a loop shares the loop's record. "@" becomes the level number where names must differ.
const shapes: Shape[] = [
  { name: "block", open: "{", inner: ";", close: "}", perLevel: 1 },
  { name: "if", open: "if(x)", inner: ";", close: "", perLevel: 1 },
  { name: "braced if", open: "if(x){", inner: ";", close: "}", perLevel: 2 },
  { name: "else chain", open: "if(x);else ", inner: ";", close: "", perLevel: 1 },
  { name: "if else blocks", open: "if(x){}else{", inner: ";", close: "}", perLevel: 2 },
  { name: "while", open: "while(x){", inner: ";", close: "}", perLevel: 2 },
  { name: "do", open: "do{", inner: ";", close: "}while(x);", perLevel: 2 },
  { name: "for", open: "for(;;){", inner: ";", close: "}", perLevel: 2 },
  { name: "for let", open: "for(let i=0;i<1;i++)", inner: ";", close: "", perLevel: 1 },
  { name: "for in", open: "for(k in o){", inner: ";", close: "}", perLevel: 2 },
  { name: "for of", open: "for(v of o){", inner: ";", close: "}", perLevel: 2 },
  { name: "for await", open: "for await(v of o){", inner: ";", close: "}", perLevel: 2, asynchronous: true },
  { name: "labelled statement", open: "l@:", inner: ";", close: "", perLevel: 1 },
  { name: "labelled block", open: "l@:{", inner: ";", close: "}", perLevel: 2 },
  { name: "labelled loop", open: "l@:while(x)", inner: ";", close: "", perLevel: 1 },
  { name: "switch", open: "switch(x){case 1:", inner: ";", close: "}", perLevel: 1 },
  { name: "switch default block", open: "switch(x){default:{", inner: ";", close: "}}", perLevel: 2 },
  { name: "try finally", open: "try{", inner: ";", close: "}finally{}", perLevel: 2 },
  { name: "try catch", open: "try{", inner: ";", close: "}catch(e){}", perLevel: 2 },
  { name: "catch body", open: "try{}catch(e){", inner: ";", close: "}", perLevel: 2 },
  { name: "finally body", open: "try{}finally{", inner: ";", close: "}", perLevel: 2 },
  // Every name inside a `with` compiles to one lookup per enclosing `with`, so the bytecode
  // grows with the square of the depth. That is a memory limit of the form, not of the parser.
  { name: "with", open: "with(o){", inner: ";", close: "}", perLevel: 2, depth: 300 },
  { name: "using", open: "{using r=o;", inner: ";", close: "}", perLevel: 1 },
  { name: "await using", open: "{await using r=o;", inner: ";", close: "}", perLevel: 1, asynchronous: true },
  { name: "block in loop", open: "{", inner: ";", close: "}", perLevel: 1, wrapper: ["while(x){", "}", 2] },
];

function body(shape: Shape, depth: number): string {
  const [before, after] = shape.wrapper ?? ["", ""];
  let open = "";
  for (let i = 0; i < depth; i++) open += shape.open.replace("@", String(i));
  return before + open + shape.inner + shape.close.repeat(depth) + after;
}

const AsyncFunction = (async function () {}).constructor as FunctionConstructor;
type Outcome = "compiled" | "refused";

// Compiles without calling. Anything but a compile or a catchable error escapes and fails.
function compile(source: string, asynchronous = false): Outcome {
  try {
    new (asynchronous ? AsyncFunction : Function)("x", "o", source);
    return "compiled";
  } catch (error) {
    if (strict && !(error instanceof RangeError)) throw error;
    return "refused";
  }
}

function recover(): void {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  if ((0, eval)("21 * 2") !== 42) throw new Error("compiler did not recover");
}

function expectOutcome(what: string, outcome: Outcome, expected: Outcome): void {
  recover();
  if (strict && outcome !== expected) throw new Error(`${what}: ${outcome}, expected ${expected}`);
}

// About 4,900 levels of every statement family, compiled and never called.
function deepCompilation(): void {
  for (const shape of shapes) {
    const wrapperRecords = shape.wrapper?.[2] ?? 0;
    const depth = shape.depth ?? Math.min(4900, Math.floor((recordLimit - 200 - wrapperRecords) / shape.perLevel));
    expectOutcome(`${shape.name} at ${depth} levels`, compile(body(shape, depth), shape.asynchronous), "compiled");
    console.log(shape.name, "settled");
  }
}

// Blocks and ifs keep no run-time state per level, so these also run to the innermost statement.
function executeNested(source: string): string {
  try { return String(new Function("x", "o", source)(1, [])); }
  catch (error) {
    if (strict) throw error;
    return "refused";
  }
}

function deepExecution(): void {
  for (const [name, open, close] of [["block", "{", "}"], ["braced if", "if(x){", "}"], ["if", "if(x)", ""]] as const) {
    const result = executeNested(`${open.repeat(4900)}o.push("innermost");${close.repeat(4900)}return o.join();`);
    recover();
    if (strict && result !== "innermost") throw new Error(`${name} ran to ${result}`);
    console.log(name, "run settled");
  }
}

// The limit counts suspended records, so each shape reaches it at a different depth.
function recordBoundaries(): void {
  for (const shape of shapes.filter(candidate => candidate.depth === undefined)) {
    const wrapperRecords = shape.wrapper?.[2] ?? 0;
    const accepted = Math.floor((recordLimit - wrapperRecords) / shape.perLevel);
    expectOutcome(`${shape.name} one below the limit`, compile(body(shape, accepted - 1), shape.asynchronous), "compiled");
    expectOutcome(`${shape.name} at the limit`, compile(body(shape, accepted), shape.asynchronous), "compiled");
    expectOutcome(`${shape.name} past the limit`, compile(body(shape, accepted + 1), shape.asynchronous), "refused");
  }
  console.log("record boundaries settled");
  // Records of an enclosing function stay suspended while a nested function body is parsed.
  const reentry = (inner: number) => `${"{".repeat(6000)}(function(){${"{".repeat(inner)};${"}".repeat(inner)}});${"}".repeat(6000)}`;
  expectOutcome("function reentry below the limit", compile(reentry(3999)), "compiled");
  expectOutcome("function reentry at the limit", compile(reentry(4000)), "compiled");
  expectOutcome("function reentry past the limit", compile(reentry(4001)), "refused");
  // A function in a loop header is parsed while the loop's own record is suspended.
  const header = (inner: number) => `${"{".repeat(5000)}for(var f=function(){${"if(x)".repeat(inner)};};;){}${"}".repeat(5000)}`;
  expectOutcome("header function at the limit", compile(header(4999)), "compiled");
  expectOutcome("header function past the limit", compile(header(5000)), "refused");
  console.log("function reentry settled");
}

// Nesting far past any limit still refuses with a catchable error.
function refusal(): void {
  for (const [name, open, inner, close] of [["block", "{", "", "}"], ["statement", "if(0)", ";", ""]] as const) {
    expectOutcome(`${name} at depth 200000`, compile(open.repeat(200000) + inner + close.repeat(200000)), "refused");
    console.log(name, "refusal settled");
  }
}

// A literal and a destructuring assignment start alike, so QuickJS looks ahead and then restores
// its position one frame deeper than where it reads on. When that restore ran out of stack, the
// literal was parsed from a stale token and the overflow became `SyntaxError: invalid property
// name`. Each literal is parsed from several stack depths so the overflow lands on different
// tokens. This runs only on QuickJS's parser: other engines do not share the defect, and JSC
// traps on literals this deep.
function literalAttempt(literal: string, remaining: number, open: string): void {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  const parse = (depth: number): unknown => (depth === 0 ? (0, eval)(literal) : parse(depth - 1));
  let caught: unknown;
  try { parse(remaining); } catch (error) { caught = error; }
  if (!(caught instanceof RangeError)) throw new Error(`literal ${open} from depth ${remaining}: ${String(caught)}`);
  recover();
}

function literalOverflow(): void {
  const delimiters: [string, string][] = strict ? [["({a:", "})"], ["[", "]"]] : [];
  for (const [open, close] of delimiters) {
    const literal = open.repeat(200000) + "0" + close.repeat(200000);
    for (let remaining = 0; remaining < 16; remaining++) literalAttempt(literal, remaining, open);
  }
  console.log("literal overflow settled");
}

if (process.argv[2] === "compile") {
  deepCompilation();
  deepExecution();
  recordBoundaries();
  refusal();
  literalOverflow();
  recover();
  console.log("continued");
} else {
  for (const budget of ["32", "36"]) {
    const child = spawnSync(process.execPath, [__filename, "compile"], { env: { ...process.env, BUN_WASM_STACK_KIB: budget }, encoding: "utf8" });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(`deep statement child at ${budget} KiB exited ${child.status}`);
  }
}
