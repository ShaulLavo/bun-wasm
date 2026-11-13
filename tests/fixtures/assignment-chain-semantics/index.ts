// Chained assignments (`a = b = c`) keep their meaning while JSC parses a chain without calling
// itself once per target (docs/bun-patches/jsc-assignment-chains.md). Evaluation and setter order,
// every assignment form, the right sides and targets the parser treats specially, and the errors a
// chain can raise must match native Bun on every engine. Chain lengths cross the parser's inline
// record capacity of eight.
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");

type Trace = string[];
type Harness = ReturnType<typeof harness>;

function harness(trace: Trace) {
  const store = new Map<string, unknown>();
  const target = (name: string) => ({
    get p() { trace.push(`get ${name}`); return store.get(name); },
    set p(value: unknown) { trace.push(`set ${name}=${String(value)}`); store.set(name, value); },
  });
  return {
    store,
    b(name: string) { trace.push(`base ${name}`); return target(name); },
    k(name: string) { trace.push(`key ${name}`); return "p"; },
    rhs(value: unknown) { trace.push("rhs"); return value; },
    seed(name: string, value: unknown) { store.set(name, value); },
  };
}

// oxlint-disable-next-line no-new-func -- The parser under test compiles each generated body.
const compile = (body: string, wide: boolean) => new Function("h", (wide ? "/* ☃ */" : "") + body) as (h: Harness) => unknown;

function traced(label: string, body: string, setup: (h: Harness) => void = () => {}, wide = false): void {
  const trace: Trace = [];
  const h = harness(trace);
  setup(h);
  const result = compile(body, wide)(h);
  console.log(`${label}: ${JSON.stringify(result)} | ${trace.join(", ")}`);
}

const levels = (count: number, level: (index: number) => string) => Array.from({ length: count }, (_, index) => level(index)).join("");

// Right to left: every base and key first, then the right side, then each target's setter from the innermost out.
for (const count of [1, 7, 8, 9, 10, 17]) {
  traced(`dot =, ${count}`, `return ${levels(count, i => `h.b("d${i}").p = `)}h.rhs(${count});`);
  traced(`bracket =, ${count}`, `return ${levels(count, i => `h.b("b${i}")[h.k("b${i}")] = `)}h.rhs(${count});`, undefined, count === 9);
  traced(`resolve =, ${count}`, `let ${levels(count, i => `a${i}, `)}last; last = ${levels(count, i => `a${i} = `)}h.rhs(${count}); return [${levels(count, i => `a${i}, `)}last];`);
}
for (const operator of ["+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "^="]) {
  const seed = (h: Harness) => { for (let i = 0; i < 9; i++) h.seed(`c${i}`, i + 2); };
  traced(`dot ${operator}, 9`, `return ${levels(9, i => `h.b("c${i}").p ${operator} `)}h.rhs(3);`, seed);
}
traced("bracket +=, 9", `return ${levels(9, i => `h.b("e${i}")[h.k("e${i}")] += `)}h.rhs("!");`, h => { for (let i = 0; i < 9; i++) h.seed(`e${i}`, `e${i}`); });
traced("resolve +=, 9", `let ${levels(9, i => `a${i} = ${i}, `)}z; z = ${levels(9, i => `a${i} += `)}h.rhs(100); return [${levels(9, i => `a${i}, `)}z];`);
// Logical assignment stops at the first target that keeps its value.
traced("dot ??=, 9, stops at 5", `return ${levels(9, i => `h.b("n${i}").p ??= `)}h.rhs("x");`, h => h.seed("n5", "kept"));
traced("bracket ||=, 9", `return ${levels(9, i => `h.b("o${i}")[h.k("o${i}")] ||= `)}h.rhs("y");`, h => { for (let i = 0; i < 9; i++) h.seed(`o${i}`, 0); });
traced("bracket &&=, 9, stops at 0", `return ${levels(9, i => `h.b("t${i}")[h.k("t${i}")] &&= `)}h.rhs("z");`);
traced("resolve ||=, 9", `let ${levels(9, i => `a${i} = ${i === 4 ? 1 : 0}, `)}z; z = ${levels(9, i => `a${i} ||= `)}h.rhs(5); return [${levels(9, i => `a${i}, `)}z];`);
traced("resolve &&= and ??=", "let a = 1, b = 2, c = null, d; d = a &&= b &&= c ??= h.rhs(4); return [a, b, c, d];");

// All nine assignment forms in one chain, repeated past the inline capacity.
const nine = [
  (i: number) => `r${i} = `, (i: number) => `r${i} += `, (i: number) => `r${i} ||= `,
  (i: number) => `h.b("m${i}").p = `, (i: number) => `h.b("m${i}").p += `, (i: number) => `h.b("m${i}").p ??= `,
  (i: number) => `h.b("m${i}")[h.k("m${i}")] = `, (i: number) => `h.b("m${i}")[h.k("m${i}")] -= `, (i: number) => `h.b("m${i}")[h.k("m${i}")] &&= `,
];
const mixed = levels(18, i => nine[i % 9]!(i));
traced("mixed nine forms, 18", `let ${levels(18, i => `r${i} = 0, `)}z; z = ${mixed}h.rhs(1); return [z, ${levels(18, i => (i % 9 < 3 ? `r${i}, ` : ""))}0];`,
  h => { for (let i = 0; i < 18; i++) h.seed(`m${i}`, i % 9 === 8 ? 1 : 10); });
traced("mixed nine forms, 18, wide", `let ${levels(18, i => `r${i} = 0, `)}z; z = ${mixed}h.rhs(1); return z;`,
  h => { for (let i = 0; i < 18; i++) h.seed(`m${i}`, i % 9 === 8 ? 1 : 10); }, true);

// A level whose subscript holds its own chain: two activations share the suspended-level records.
traced("nested chain in a subscript", `let a, b, c, ${levels(10, i => `k${i}, `)}z; z = a = b = h.b("outer")[(${levels(10, i => `k${i} = `)}"p")] = c = h.rhs(3); return [z, a, b, c, k0, k9];`);
traced("nested chain in a call argument", "let a, b, c, d; const f = (v) => v * 2; a = b = f(c = d = h.rhs(4)); return [a, b, c, d];");

// Speculative parses inside the right side of a running chain: the arrow candidate and the
// destructuring retry each parse a nested chain, restore and parse again. Together the two chains
// hold more records than the inline capacity.
const outer = levels(6, i => `h.b("s${i}").p = `);
const inner = levels(6, i => `q${i} = `);
for (const wide of [false, true]) {
  traced(`arrow default under a chain${wide ? ", wide" : ""}`, `let ${levels(6, i => `q${i}, `)}z; z = ${outer}((p = ${inner}h.rhs(2)) => [p, q0, q5])(); return [z, q0, q5];`, undefined, wide);
  traced(`destructuring default under a chain${wide ? ", wide" : ""}`, `let ${levels(6, i => `q${i}, `)}z; z = ${outer}[${inner}h.rhs(3)] = []; return [z, q0, q5];`, undefined, wide);
}

// Right sides that only the top of an assignment level parses: arrows, yield and destructuring.
traced("arrow right side", "let x, y; x = y = (v) => v + 1; return [x(1), x === y];");
traced("async arrow right side", "let x, y; x = y = async v => v; return [typeof x, x === y];");
traced("arrow with chained defaults", "let x; x = (a = b = 1, c = d = 2) => [a, b, c, d]; return x();");
traced("arrow body chain", "let x, y, z; x = (v) => y = z = v * 3; return [x(2), y, z];");
traced("yield right side", "function* g() { let a, b, c; a = b = yield 1; c = yield a = 2; return [a, b, c]; } const it = g(); it.next(); it.next(5); return it.next(6).value;");
traced("yield star right side", "function* inner() { return 9; } function* g() { let a, b; a = b = yield* inner(); return [a, b]; } return g().next().value;");
traced("destructuring in a chain", "let a, b, c, d; a = [b, c] = d = [1, 2]; return [a === d, b, c];");
traced("object pattern in a chain", "let a, b, x; ({ x } = a = b = { x: 5 }); return [x, a === b];");
traced("pattern then chain", "let a, b, c; [a] = b = c = [7]; return [a, b === c];");
traced("conditional right side", "let a, b, c = 0; a = b = c ? 1 : c = 2; return [a, b, c];");
traced("comma after chain", "let a, b, c; return (a = b = 1, c = a + b, [a, b, c]);");
traced("strict chain", "'use strict'; let a, b, c; a = b = c = 3; return [a, b, c];");
traced("asi after chain", "let a, b, c, d; a = b = 1\nc = d = 2\nreturn [a, b, c, d];");
traced("asi before increment", "let a, b, c = 1; a = b = c\n++c\nreturn [a, b, c];");
traced("condition context", "let a, b, n = 0; if (a = b = h.rhs(1)) n++; while (a = b = a - 1) n += 10; return [a, b, n];");
traced("unused result", "let a, b; a = b = h.rhs(2); a = b = h.b(\"u\").p = 4; return [a, b];");

function syntaxError(label: string, body: string): void {
  try { compile(body, false); console.log(`${label}: accepted`); }
  catch (error) { console.log(`${label}: ${(error as Error).name}`); }
}

// A level can reach its operator loop twice: after an arrow or a bare yield, `=` is not a target.
syntaxError("arrow then =", "let a; a = () => {} = 1;");
syntaxError("bare yield then =", "function* g() { let a; a = yield\n= 1; }");
// The same second operator at a level inside the chain, which meets it after its right side came back.
syntaxError("arrow then = inside a chain", "let a, b, c; a = b = c = () => {} = 1;");
syntaxError("bare yield then = inside a chain", "function* g() { let a, b, c; a = b = c = yield\n= 1; }");
// A speculative parse that fails both ways while an outer chain waits for it.
syntaxError("failed arrow default under a chain", `let ${levels(6, i => `q${i}, `)}z; z = ${outer}(p = ${inner}) => 0;`);
syntaxError("failed parenthesized rest under a chain", `let ${levels(6, i => `q${i}, `)}z; z = ${outer}(p = ${inner}1, ...rest);`);
syntaxError("failed destructuring default under a chain", `let ${levels(6, i => `q${i}, `)}z; z = ${outer}[${inner}] = [];`);
syntaxError("literal target", "let a; a = 1 = 2;");
syntaxError("operator target", "let a, b, c; a = b + c = 1;");
syntaxError("new.target target", "function f() { let a; a = new.target = 1; }");
syntaxError("missing right side", "let a, b; a = b = ;");
syntaxError("missing right side in arrow defaults", "let x; x = (a = b = ) => 1;");
syntaxError("missing right side in a subscript", "let a, b, c, d; const o = {}; a = b = o[(c = d = )] = 1;");
syntaxError("compound to a literal", "let a; a += 1 += 2;");
syntaxError("logical to a call", "let a; const f = () => 0; a ||= f() ||= 1;");
for (const count of [1, 9, 200]) {
  const chain = levels(count, i => `a${i} = `);
  syntaxError(`strict eval after ${count}`, `'use strict'; let ${levels(count, i => `a${i}, `)}z; z = ${chain}eval = 1;`);
  syntaxError(`strict arguments after ${count}`, `'use strict'; let ${levels(count, i => `a${i}, `)}z; z = ${chain}arguments = 1;`);
  syntaxError(`missing right side after ${count}`, `let ${levels(count, i => `a${i}, `)}z; z = ${chain};`);
  syntaxError(`sloppy eval after ${count}`, `function f() { let ${levels(count, i => `a${i}, `)}z; z = ${chain}eval = eval; }`);
}

// The same chain in module code, with a top-level await right side.
fs.writeFileSync(path.join(process.cwd(), "chain-module.mjs"),
  "let a, b, c;\na = b = c = await Promise.resolve(8);\nexport const values = [a, b, c];\nexport let d, e;\nd = e = (x => x + 1)(c);\n");
const loaded = (await import(path.join(process.cwd(), "chain-module.mjs"))) as { values: number[]; d: number; e: number };
console.log(`module chain: ${JSON.stringify([loaded.values, loaded.d, loaded.e])}`);
// oxlint-disable-next-line no-eval -- Script code through the runtime's evaluator.
console.log(`script chain: ${JSON.stringify((0, eval)("var sa, sb; sa = sb = [1, 2].length; [sa, sb]"))}`);

// JSC gives an error it raises inside a chain the line and column of the failing target. Other
// engines report positions differently or not at all, so positions are compared only where JSC
// parses: native Bun recorded these (line, column) pairs.
function jscParser(): boolean {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  try { (0, eval)("let let = 1"); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (error.message === "Unexpected keyword 'let'. Cannot use 'let' as an identifier name for a LexicalDeclaration.") return true;
    if (error.message === "'let' is not a valid lexical identifier" || error.message === "let is disallowed as a lexically bound name" || error.message === "a lexical declaration can't define a 'let' binding") return false;
    throw new Error("Unrecognized parser fingerprint", { cause: error });
  }
  throw new Error("Invalid lexical declaration was accepted");
}

// The level at `depth` is a frozen object for a strict write, or null for a compound read.
function failurePosition(depth: number, count: number, form: "set" | "get"): string {
  const operator = form === "set" ? "=" : "+=";
  const body = `'use strict';\nreturn (\n${levels(count, i => `  h.o${i}.p ${operator}\n`)}  0);`;
  const h: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) h[`o${i}`] = i !== depth - 1 ? { p: 1 } : form === "set" ? Object.freeze({ p: 1 }) : null;
  try { compile(body, false)(h as Harness); } catch (error) {
    const { name, line, column } = error as Error & { line?: number; column?: number };
    return `${name} ${line}:${column}`;
  }
  return "completed";
}

const positions = [1, 9, 200].flatMap(depth => (["set", "get"] as const).map(form => `${form} ${depth} ${failurePosition(depth, 200, form)}`));
const nativePositions = ["set 1 TypeError 5:7", "get 1 TypeError 5:7", "set 9 TypeError 13:7", "get 9 TypeError 13:7", "set 200 TypeError 204:9", "get 200 TypeError 204:9"];
if (jscParser() && positions.join() !== nativePositions.join()) throw new Error(`JSC chain error positions moved: ${positions.join(", ")}`);
console.log(`error positions: ${positions.length} checked`);

// A caught failure leaves the parser ready for the next parse.
syntaxError("failure before reuse", `let ${levels(40, i => `a${i}, `)}z; z = ${levels(40, i => `a${i} = `)}= 1;`);
traced("reuse after failure", `let ${levels(40, i => `a${i}, `)}z; z = ${levels(40, i => `a${i} = `)}h.rhs(40); return [z, a0, a39];`);
