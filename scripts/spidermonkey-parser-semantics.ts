// Differential parser semantics for SpiderMonkey's WASI build.
//
// The frame merges in docs/bun-patches/spidermonkey-frontend-frames.md must not change what the
// parser does. This corpus runs the same sources through the standalone smoke in every parser
// instantiation: UTF-8 compiled directly (full parser at the top level, syntax parser for the
// inner function and full parser when it is called) and two-byte strings through eval and
// Function, with ASCII, Latin-1 and non-Latin-1 text before each source so positions are
// computed in every character type. It also records the recursion-counter boundaries of PR 772's
// compile limit. tests/spidermonkey-parser/expected-<tier>.txt hold the output of the library
// before the merges; regenerate them only from such a build:
//   bun scripts/spidermonkey-parser-semantics.ts write <smoke.wasm>
//   bun scripts/spidermonkey-parser-semantics.ts check <smoke.wasm>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Text placed directly before each source: ASCII, Latin-1 and a character outside Latin-1.
const prefixes = [["ascii", ""], ["latin1", "/*é*/"], ["twobyte", "/*☃*/"]] as const;

// Each source is compiled as a script and as a function body, so it avoids top-level `let`,
// `const` and `class` declarations that would persist between runs.
const cases: readonly { name: string; source: string }[] = [
  { name: "braced then and else", source: "var r = [];\nif (r.length === 0) { r.push('then'); } else { r.push('else'); }\nif (r.length === 0) { r.push('no'); } else { r.push('else'); }\nr.join()" },
  { name: "dangling else", source: "var r = 'none';\nif (true) if (false) r = 'inner'; else r = 'dangling';\nr" },
  { name: "else if chain", source: "var x = 3, r;\nif (x === 1) { r = 'a'; } else if (x === 2) r = 'b'; else if (x === 3) { r = 'c'; } else { r = 'd'; }\nr" },
  { name: "unbraced bodies", source: "var n = 0;\nif (n) n = 1; else n = 2;\nif (n === 2)\n  n += 10\nelse\n  n = -1\nn" },
  { name: "empty and nested blocks", source: "{}\n{ { { var deep = 5; } } }\nif (deep) {} else {}\ndeep" },
  { name: "completion value of if", source: "if (true) { 1 } else { 2 }" },
  { name: "completion value of block", source: "{ 1\n2 } 3" },
  { name: "comment and regexp after block", source: "var t = 'x/y';\n{ t += 1 } /* note */ /y/.test(t)" },
  { name: "regexp after if block on next line", source: "var s = 'abc';\nif (s) {}\n/b/.exec(s)[0]" },
  { name: "line comment then regexp", source: "{ }\n// note\n/a+/g.source" },
  { name: "division after parenthesis", source: "var a = 8, g = 2;\n(a) / g / 2" },
  { name: "asi before array literal", source: "var log = [];\nif (log) {}\n[1, 2].length" },
  { name: "asi increment", source: "var x = 1, y = 1;\nx\n++y\n[x, y].join()" },
  { name: "return followed by newline", source: "return\n42" },
  { name: "return in nested blocks", source: "if (true) { { if (1) { return 'inner'; } } }\nreturn 'outer'" },
  { name: "labelled block and break", source: "var r = [];\nouter: { r.push(1); inner: { r.push(2); break outer; } r.push(3); }\nr.join()" },
  { name: "labelled loops", source: "var r = [];\nl1: for (var i = 0; i < 3; i++) { l2: while (true) { if (i === 1) continue l1; r.push(i); break l2; } }\nr.join()" },
  { name: "label on if block", source: "var r = 'start';\nskip: if (true) { break skip; r = 'not reached'; }\nr" },
  { name: "break outside loop", source: "{ if (true) { break; } }" },
  { name: "undefined label", source: "{ { break missing; } }" },
  { name: "duplicate label", source: "a: { a: { } }" },
  { name: "legal block shadowing", source: "{ let v = 1; { let v = 2; { const v = 3; } } var out = typeof v; }\nout" },
  { name: "duplicate let in nested block", source: "{\n  {\n    let dup = 1;\n    let dup = 2;\n  }\n}" },
  { name: "const without initializer", source: "{ if (true) { const c; } }" },
  { name: "let then var conflict", source: "{ let lv = 1; { var lv = 2; } }" },
  { name: "function and let conflict in block", source: "{ function fx() {} let fx = 1; }" },
  { name: "duplicate block functions in sloppy code", source: "(function () { { function dupf() { return 1; } function dupf() { return 2; } } return dupf(); })()" },
  { name: "block use strict is not a directive", source: "{ 'use strict'; var w = 010; }\nw" },
  { name: "if block use strict is not a directive", source: "var o = { k: 9 };\nif (true) { 'use strict'; with (o) { var got = k; } }\ngot" },
  { name: "parenthesized use strict is not a directive", source: "('use strict');\nvar o2 = 07;\no2" },
  { name: "script directive", source: "'use strict';\nwith ({}) {}" },
  { name: "directive after another string", source: "'other';\n'use strict';\nvar implicit = 1; delete implicit" },
  { name: "function directive", source: "(function () { 'use strict'; return this === undefined; })()" },
  { name: "function directive rejects duplicate parameters", source: "(function (a, a) { 'use strict'; })" },
  { name: "sloppy duplicate parameters", source: "(function (a, a) { return a; })(1, 2)" },
  { name: "function directive rejects octal", source: "(function () { 'use strict'; return 010; })" },
  { name: "escaped directive", source: "(function () { 'use\\x20strict'; return this !== undefined; }).call(1)" },
  { name: "annex b if function", source: "(function () { if (true) function ab() { return 'annex'; } return typeof ab + ' ' + ab(); })()" },
  { name: "annex b else function", source: "(function () { if (false) ; else function ab2() { return 2; } return ab2(); })()" },
  { name: "annex b with else", source: "(function () { if (0) function ab3() { return 'a'; } else function ab4() { return 'b'; } return typeof ab3 + ' ' + ab4(); })()" },
  { name: "strict if function", source: "(function () { 'use strict'; if (true) function sf() {} })" },
  { name: "if generator declaration", source: "if (true) function* g() {}" },
  { name: "if async function declaration", source: "if (true) async function af() {}" },
  { name: "if class declaration", source: "if (true) class C {}" },
  { name: "if lexical declaration", source: "if (true) let x = 1;" },
  { name: "while function declaration", source: "while (false) function wf() {}" },
  { name: "labelled function in sloppy code", source: "(function () { lab: function lf() { return 'lab'; } return lf(); })()" },
  { name: "labelled function in strict code", source: "(function () { 'use strict'; lab: function lf() {} })" },
  { name: "block function in strict code", source: "(function () { 'use strict'; { function bf() {} } return typeof bf; })()" },
  { name: "parenthesized assignment target", source: "var p;\n(p) = 4;\n((p)) += 1;\np" },
  { name: "parenthesized object pattern", source: "var a;\n({a}) = { a: 1 };" },
  { name: "parenthesized array pattern", source: "var a;\n([a]) = [1];" },
  { name: "object literal with initializer", source: "({ a = 1 });" },
  { name: "nested parenthesized pattern", source: "var a;\n[({ a })] = [{ a: 1 }];" },
  { name: "parenthesized element target", source: "var a;\n[(a)] = [5];\na" },
  { name: "destructuring assignment", source: "var a, b;\n({ a, b: [b] } = { a: 1, b: [2] });\na + b" },
  { name: "comma assignment target", source: "var a, b;\n(a, b) = 1;" },
  { name: "literal assignment target", source: "(1) = 2;" },
  { name: "parenthesized arrow parameters", source: "var f = ({ a }, [b], c = 3, ...d) => a + b + c + d.length;\nf({ a: 1 }, [2], undefined, 4, 5)" },
  { name: "invalid arrow parameters", source: "var f = (a, (b)) => 1;" },
  { name: "rest in parenthesized expression", source: "(a, ...b);" },
  { name: "optional chain assignment", source: "var o = {};\no?.x = 1;" },
  { name: "new with optional chain", source: "new Date?.x;" },
  { name: "prefix increment of parenthesis", source: "var q = 1;\n++(q);\nq" },
  { name: "prefix increment of object", source: "++({});" },
  { name: "nested parentheses and brackets", source: "var m = [[1, [2, [3]]]];\n((((m[0][1][1][0]))))" },
  { name: "template and call nesting", source: "var t = (s) => s.raw[0];\nt`a${(1 + (2))}b`.length + String([(1), [(2)]])" },
  { name: "ternary and logical chain", source: "var z = 0;\nz ? 1 : z || (z ?? 2) ? 3 : (4, 5)" },
  { name: "unexpected token in deep expression", source: "var r = (1 + (2 * (3 - [4, 5, (6 +)])));" },
  { name: "missing closing brace", source: "if (true) {\n  if (false) {\n    var x = 1;\n  \n" },
  { name: "missing closing parenthesis", source: "var v = (1 + (2;\n" },
  { name: "early error after identifiers", source: "var été = 1, π = 3;\nété + π +" },
  { name: "non-Latin-1 identifiers", source: "var πρ = 2, über = 3;\nπρ * über" },
  { name: "string with non-Latin-1 text", source: "'☃' + 'é'.length + 'x\\u{1F600}'.length" },
  { name: "throw from nested blocks", source: "function deepThrow() {\n  {\n    if (true) {\n      {\n        throw new Error('innermost');\n      }\n    }\n  }\n}\ndeepThrow()" },
  { name: "runtime error position", source: "var o = null;\nif (true) {\n  { o.missing; }\n}" },
  { name: "lazy inner functions", source: "function outer() { function inner(a) { if (a) { return [a, (a + 1)]; } return inner(1); } return inner(0).join(); }\nouter()" },
  { name: "inner function syntax error", source: "function later() {\n  if (true) {\n    return (1 +;\n  }\n}" },
  { name: "switch and try nesting", source: "var r = [];\nswitch (1) { case 1: { try { if (true) { throw 2; } } catch (e) { r.push(e); } finally { r.push('f'); } } }\nr.join()" },
  { name: "with statement block", source: "var out;\nwith ({ k: 'with' }) { if (true) { out = k; } }\nout" },
  { name: "do while asi", source: "var i = 0;\ndo { i++ } while (i < 3) i" },
  { name: "for loops with blocks", source: "var s = 0;\nfor (var i = 0; i < 3; i++) { if (i) { s += i; } }\nfor (var k in { a: 1 }) { s += k.length; }\ns" },
  { name: "object literal methods", source: "var o = { m() { if (this) { return 'm'; } }, get g() { { return 'g'; } }, ['c' + 1]: 1 };\no.m() + o.g + o.c1" },
  { name: "class bodies", source: "var K = class { static s() { if (true) { return 's'; } } #p = 1; get p() { return this.#p; } };\nK.s() + new K().p" },
  { name: "async and generator bodies", source: "var g = function* () { if (true) { yield (1); yield* [2]; } };\nArray.from(g()).join() + typeof (async () => { if (1) { await 0; } })" },
  { name: "html comment in script", source: "var hc = 1;\n<!-- hidden\nhc" },
];

const harness = String.raw`
var __lines = [];
var __utf8Index = 0;
function __show(v) {
  if (typeof v === "function") return "function " + v.name;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}
function __frames(e) {
  var lines = String(e.stack).split("\n"), out = [];
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i] || /^__/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join(" | ");
}
function __describe(threw, v) {
  if (!threw) return "value " + __show(v);
  if (!(v instanceof Error)) return "throw " + __show(v);
  return "throw " + v.name + ": " + v.message + " at " + v.fileName + ":" + v.lineNumber + ":" + v.columnNumber + " stack " + __frames(v);
}
function __record(label, run) {
  var threw = false, value;
  try { value = run(); } catch (e) { threw = true; value = e; }
  __lines.push(label + " " + __describe(threw, value));
}
function __utf8Step(status) {
  var step = __utf8Plan[__utf8Index++];
  var threw = status !== 0, value = threw || !step.call ? __value : undefined;
  if (!threw && step.call) {
    try { value = __value(); } catch (e) { threw = true; value = e; }
  }
  __lines.push(step.label + " " + __describe(threw, value));
}
function __twoByte() {
  for (var c = 0; c < __cases.length; c++) {
    for (var p = 0; p < __prefixes.length; p++) {
      var label = __cases[c].name + " | " + __prefixes[p][0] + " | ";
      var source = __prefixes[p][1] + __cases[c].source;
      __record(label + "eval", function () { return (0, eval)(source); });
      __record(label + "eval lazy", function () { return (0, eval)("(function () {\n" + source + "\n})")(); });
      __record(label + "Function", function () { return Function(source)(); });
    }
  }
}
function __nest(open, close, n) {
  var s = "if (false) {";
  for (var i = 0; i < n; i++) s += open.split("#").join(i);
  return s + "1;" + close.repeat(n) + "}";
}
function __accepts(source) {
  try { (0, eval)(source); return "accepted"; } catch (e) { return e.name + ": " + e.message; }
}
function __boundary(name, open, close, lazy) {
  var build = function (n) { var s = __nest(open, close, n); return lazy ? "(function () {" + s + "})" : s; };
  var lo = 1, hi = 6000;
  if (__accepts(build(lo)) !== "accepted") return __lines.push("boundary " + name + " none");
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1;
    if (__accepts(build(mid)) === "accepted") lo = mid; else hi = mid;
  }
  __lines.push("boundary " + name + (lazy ? " lazy" : " full") + " accepts " + lo + ": " + __accepts(build(lo)) +
    "; " + (lo + 1) + ": " + __accepts(build(lo + 1)) + "; then " + (0, eval)("6 * 7"));
}
function __boundaries() {
  var shapes = [["block", "{", "}"], ["braced if", "if (ok) {", "}"], ["braced else", "if (ok) {} else {", "}"],
    ["label", "l#: ", ""], ["nested function", "function f#() {", "}"]];
  for (var i = 0; i < shapes.length; i++) {
    __boundary(shapes[i][0], shapes[i][1], shapes[i][2], false);
    __boundary(shapes[i][0], shapes[i][1], shapes[i][2], true);
  }
}
function __finish() {
  __twoByte();
  __boundaries();
  return __lines.join("\n");
}
`;

const utf8Separator = "\n//@@utf8\n";

// The smoke's BUNSM_PARSER_CORPUS mode evaluates the first chunk, compiles every later chunk as
// UTF-8 and reports it through __utf8Step, then prints __finish().
function corpusPayload(): string {
  const plan: { label: string; call: boolean }[] = [];
  const chunks: string[] = [];
  for (const { name, source } of cases) {
    for (const [prefixName, prefix] of prefixes) {
      plan.push({ label: `${name} | ${prefixName} | utf8 script`, call: false });
      chunks.push(prefix + source);
      plan.push({ label: `${name} | ${prefixName} | utf8 lazy`, call: true });
      chunks.push(`(function () {\n${prefix}${source}\n})`);
    }
  }
  const data = `var __cases = ${JSON.stringify(cases)};\nvar __prefixes = ${JSON.stringify(prefixes)};\nvar __utf8Plan = ${JSON.stringify(plan)};\n`;
  for (const chunk of chunks) assert(!chunk.includes(utf8Separator), "corpus source contains the chunk separator");
  return [harness + data].concat(chunks).join(utf8Separator);
}

export function runCorpus(smoke: string, tier: (typeof tiers)[number]): string {
  const payload = corpusPayload();
  const output = execFileSync("timeout", ["--kill-after=5s", "300s", "wasmtime", "run", "-W", "max-wasm-stack=16777216",
    "--env", `BUNSM_PARSER_CORPUS=${payload}`, smoke, tier], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const marker = `ok init tier=${tier}\n`;
  assert(output.startsWith(marker), `unexpected smoke output: ${output.slice(0, 200)}`);
  return output.slice(marker.length);
}

export const tiers = ["interp", "pbl"] as const;

// Runtime error messages differ between the tiers, so each keeps its own baseline.
export const expectedPath = (tier: (typeof tiers)[number]) => resolve(import.meta.dir, `../tests/spidermonkey-parser/expected-${tier}.txt`);

function main(): void {
  const [command, smoke] = process.argv.slice(2);
  assert((command === "write" || command === "check") && smoke, "usage: spidermonkey-parser-semantics.ts write|check <smoke.wasm>");
  for (const tier of tiers) {
    const output = runCorpus(smoke, tier);
    if (command === "write") writeFileSync(expectedPath(tier), output);
    else assert.equal(output, readFileSync(expectedPath(tier), "utf8"), `${tier} parser results differ from the recorded baseline`);
    console.log(`${command} ${tier} ${smoke}: ${output.split("\n").length} lines`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
