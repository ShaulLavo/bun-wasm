// Statement semantics the iterative parser must keep. scripts/check-quickjs-parser-stack.ts strips
// the types and runs this on the bare QuickJS engine. quickjs-parser-stack.expected.txt holds
// what the upstream recursive parser printed for it before the change.
declare function print(...values: unknown[]): void;

function show(label: string, source: string): void {
  let result: string;
  // oxlint-disable-next-line no-eval -- Completion values and early errors are only observable through eval.
  try { result = String((0, eval)(source)); } catch (error) { result = `${(error as Error).name}: ${(error as Error).message}`; }
  print(label, "=>", result);
}

function nest(open: (level: number) => string, inner: string, close: string, count: number): string {
  let source = "";
  for (let i = 0; i < count; i++) source += open(i);
  return source + inner + close.repeat(count);
}

// Completion values of every statement kind.
show("block", "1; { 2; }");
show("empty block", "1; { }");
show("if taken", "1; if (true) 2;");
show("if skipped", "1; if (false) 2;");
show("if else", "1; if (false) 2; else 3;");
show("else if chain", "if (false) 1; else if (false) 2; else if (true) 3; else 4;");
show("while", "var i = 0; 1; while (i < 3) { i++; }");
show("while break", "1; while (true) { 2; break; }");
show("do", "var j = 0; do { j++; } while (j < 3);");
show("for", "1; for (var k = 0; k < 2; k++) { k * 10; }");
show("for empty", "1; for (;false;) 2;");
show("for in", "1; for (var key in { a: 1, b: 2 }) key;");
show("for of", "1; for (var item of [5, 6]) item;");
show("labelled", "1; out: { 2; break out; }");
show("switch", "1; switch (2) { case 1: 10; case 2: 20; case 3: 30; break; default: 40; }");
show("switch default middle", "switch (9) { case 1: 10; default: 40; case 3: 30; }");
show("switch empty", "1; switch (2) { }");
show("with", "1; with ({ v: 7 }) v;");
show("try", "1; try { 2; } catch (e) { 3; }");
show("try throw", "1; try { throw 2; } catch (e) { e * 2; }");
show("try finally", "try { 1; } finally { 2; }");
show("finally break", "out: { try { 3; break out; } finally { 4; } }");
show("finally in loop", "var r = []; for (var n = 0; n < 3; n++) { try { if (n === 1) continue; n; } finally { r.push(n); } } r.join();");
show("nested finally value", "try { try { 1; } finally { 2; } } finally { 3; }");

// Labels, break and continue across finally and nested loops.
show("labels across finally", `var log = []; outer: for (let i = 0; i < 4; i++) { try { if (i === 1) continue outer; if (i === 3) break outer; log.push("body" + i); } finally { log.push("finally" + i); } log.push("after" + i); } log.join();`);
show("label on do", "var c = 0; a: do { c++; if (c < 3) continue a; break a; } while (true); c;");
show("nested labels", "var s = ''; a: for (var x = 0; x < 3; x++) { b: for (var y = 0; y < 3; y++) { if (y === 1) continue a; if (x === 2) break a; s += x + '' + y + ' '; } } s;");
show("label then block then loop", "var t = 0; a: { b: for (;;) { t++; if (t > 2) break a; continue b; } } t;");
show("duplicate label", "a: a: ;");
show("undefined label", "a: { break b; }");
show("continue non loop", "a: { continue a; }");

// Iterator closing on abrupt exits.
const iterator = `var log = []; var it = { [Symbol.iterator]() { return { next() { log.push("next"); return { done: false, value: 1 }; }, return() { log.push("return"); return {}; } }; } };`;
show("iterator break", `${iterator} for (const v of it) { log.push("body"); break; } log.join();`);
show("iterator throw", `${iterator} try { for (const v of it) { log.push("body"); throw new Error("x"); } } catch (e) { log.push("caught"); } log.join();`);
show("iterator labelled continue", `${iterator} outer: for (var i = 0; i < 2; i++) { for (const v of it) { log.push("body" + i); continue outer; } } log.join();`);
show("iterator return in function", `${iterator} (function () { for (const v of it) { for (const w of it) { return 1; } } })(); log.join();`);
show("iterator break through try", `${iterator} for (const v of it) { try { break; } finally { log.push("finally"); } } log.join();`);
show("destructuring for of", "var out = []; for (const [a, { b = 5 }] of [[1, {}], [2, { b: 3 }]]) out.push(a + b); out.join();");
show("for in initializer", "var seen = ''; for (var q = 9 in { a: 1 }) seen += q; seen;");

// Explicit resource management: disposal order against finally and loop control.
const resource = `var log = []; function res(name) { return { [Symbol.dispose]() { log.push("dispose " + name); } }; }`;
show("using block", `${resource} { using a = res("a"); using b = res("b"); log.push("body"); } log.join();`);
show("using with finally", `${resource} try { using a = res("a"); log.push("body"); } finally { log.push("finally"); } log.join();`);
show("using break", `${resource} for (var i = 0; i < 2; i++) { using a = res("a" + i); if (i === 0) continue; log.push("body" + i); break; } log.join();`);
show("using for of", `${resource} for (using r of [res("x"), res("y")]) { log.push("body"); } log.join();`);
show("using for head", `${resource} for (using r = res("h"), n = [0]; n[0] < 2; n[0]++) { log.push("body" + n[0]); } log.join();`);
show("using throw", `${resource} try { { using a = res("a"); throw new Error("boom"); } } catch (e) { log.push(e.message); } log.join();`);
show("using in switch case", `${resource} switch (1) { case 1: using a = res("a"); }`);
show("using at script top", `${resource} using a = res("a");`);
show("using single statement", `${resource} if (true) using a = res("a");`);

// Declarations and the contexts that allow them.
show("strict block function", `"use strict"; { function scoped() {} } typeof scoped;`);
show("sloppy block function", "{ function hoisted() {} } typeof hoisted;");
show("sloppy if function", "if (true) function annexIf() { return 1; } annexIf();");
show("strict if function", `"use strict"; if (true) function annexStrict() {}`);
show("sloppy labelled function", "l: function labelled() { return 2; } labelled();");
show("strict labelled function", `"use strict"; l: function labelledStrict() {}`);
show("labelled function in if", "if (true) l: function inner() {}");
show("while function", "while (false) function w() {}");
show("do function", "do function d() {} while (false)");
show("for function", "for (;;) function f() {}");
show("with function", "with ({}) function wf() {}");
show("if class", "if (true) class C {}");
show("if let", "if (true) let x = 1;");
show("if const", "if (true) const y = 1;");
show("label let", "l: let z = 1;");
show("generator in if", "if (true) function* g() {}");
show("async function in if", "if (true) async function af() {}");
show("let in case", "switch (1) { case 1: let a = 1; case 2: a; }");
show("lexical redeclare in block", "{ let a; var a; }");
show("catch parameter redeclare", "try { } catch (e) { let e; }");
show("return outside function", "{ return 1; }");
show("break outside", "{ break; }");
show("missing while", "do { } until (true);");
show("try alone", "try { }");
show("for await outside async", "for await (const x of []) ;");
show("with in strict", `"use strict"; with ({}) ;`);
show("duplicate default", "switch (1) { default: default: }");
show("statement before case", "switch (1) { 1; }");
show("unclosed block", "{ { { ");

// Closures created in loop bodies and headers.
show("per iteration binding", "var fns = []; for (let i = 0; i < 3; i++) fns.push(() => i); fns.map(f => f()).join();");
show("closure in for of", "var fns = []; for (const v of [4, 5]) { fns.push(() => v); } fns.map(f => f()).join();");
show("function in for header", `var log = []; outer: for (const f of [function () { inner: for (;;) { break inner; } return "h"; }]) { log.push(f()); continue outer; } log.join();`);
show("function in while test", "var n = 0; while ((function () { if (n < 2) { n++; return true; } return false; })()) { } n;");
show("function in switch case", "switch ((() => { for (;;) { return 2; } })()) { case (function () { try { return 2; } finally { } })(): 'matched'; }");
show("class static block", "var seen; class K { static { for (const v of [1]) { try { seen = v; } finally { } } } } seen;");

// Source text and positions.
const body = nest(i => `if (ok${i % 2}) {\n`, 'throw new Error("innermost");\n', "}\n", 40);
const expression = `function deep(ok0, ok1) {\n${body}}`;
// oxlint-disable-next-line no-eval -- The compiler under test is the engine's evaluator.
const deep = (0, eval)(`(${expression})`) as (a: boolean, b: boolean) => void;
print("function source kept", deep.toString() === expression);
const constructed = new Function("ok0", "ok1", body);
print("constructor source kept", constructed.toString() === `function anonymous(ok0,ok1\n) {\n${body}\n}`);
try { deep(true, true); } catch (error) { print("eval position", String((error as Error).stack).split("\n")[0]); }
try { constructed(true, true); } catch (error) { print("constructor position", String((error as Error).stack).split("\n")[0]); }
show("syntax error position", nest(() => "{\n", "let let = 1;", "}", 30));
show("syntax error in nested function", "a: for (;;) { b: { try { (function () { c: while (1) { { @ } } })(); } finally { } } }");

// Every statement kind 300 levels deep, compiled and run to its innermost statement.
function run(name: string, source: string, ...args: unknown[]): void {
  let result: string;
  try { result = String(new Function("log", "input", source)([], ...args)); } catch (error) { result = `${(error as Error).name}: ${(error as Error).message}`; }
  print(name, "=>", result);
}
run("deep block", nest(i => `{ let v${i} = ${i};\n`, "log.push(v0 + v299);", "}", 300) + "return log[0];");
run("deep if", nest(() => "if (input) {\n", 'log.push("in");', "}", 300) + "return log.join();", 1);
run("deep else if", nest(i => `if (input === ${i}) return "branch ${i}"; else `, 'return "none";', "", 300), 299);
run("deep while", nest(i => `l${i}: while (true) {\n`, 'log.push("inner"); break l0;', "}", 300) + "return log.length;");
run("deep do", nest(() => "do {\n", "log.push(1);", "} while (false);", 300) + "return log.length;");
run("deep for", nest(i => `for (let i${i} = 0; i${i} < 1; i${i}++) {\n`, "log.push(1);", "}", 300) + "return log.length;");
run("deep for in", nest(i => `for (const k${i} in input) {\n`, "log.push(k0 + k99);", "}", 100) + "return log.join();", { a: 1 });
run("deep for of", nest(i => `for (const v${i} of input) {\n`, "log.push(v0 + v99);", "}", 100) + "return log.join();", [7]);
run("deep label", nest(i => `l${i}: {\n`, 'log.push("in"); break l1; log.push("skipped");', "}", 300) + "return log.join();");
run("deep switch", nest(() => "switch (input) { case 1:\n", 'log.push("case");', "}", 300) + "return log.join();", 1);
run("deep try", nest(() => "try {\n", 'log.push("body");', "", 300) + Array.from({ length: 300 }, (_, i) => `} finally { log.push(${i}); }`).join("\n") + "return [log.length, log[0], log[1], log[300]].join();");
run("deep catch", `try { ${nest(() => "try {\n", 'throw new Error("deep");', "", 300)}${Array.from({ length: 300 }, (_, i) => `} catch (error) { log.push(${i}); throw error; }`).join("\n")} } catch (error) { return [log.length, log[0], log[299], error.message].join(); }`);
run("deep with", nest(() => "with (input) {\n", "log.push(marker);", "}", 100) + "return log.join();", { marker: "scoped" });
run("deep using", `function res(n) { return { [Symbol.dispose]() { log.push(n); } }; }${nest(i => `{ using r${i} = res(${i});\n`, "log.push(-1);", "}", 100)}return [log.length, log[0], log[1], log[100]].join();`);
run("deep mixed", nest(i => ["if (input) {\n", `a${i}: for (;;) {\n`, "try {\n", "switch (1) { default:\n", "{\n"][i % 5]!, 'log.push("core");', "", 0)
  + (() => { let open = ""; let close = ""; for (let i = 0; i < 300; i++) { const kind = i % 5; open += ["if (input) {\n", `a${i}: for (;;) {\n`, "try {\n", "switch (1) { default:\n", "{\n"][kind]!; close = ["}", ` break a${i}; }`, "} finally { }", "}", "}"][kind]! + close; } return `${open}log.push("core");${close}`; })()
  + "return log.join();", 1);

// Asynchronous forms: for await and await using.
async function asynchronous(): Promise<void> {
  const log: string[] = [];
  const AsyncFunction = (async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
  const source = `async function* numbers() { try { yield 1; yield 2; } finally { log.push("generator closed"); } }
    function res(name) { return { async [Symbol.asyncDispose]() { await null; log.push("dispose " + name); } }; }
    outer: for (let i = 0; i < 2; i++) {
      for await (const n of numbers()) {
        await using a = res("a" + i);
        log.push("body " + i + " " + n);
        try { if (i === 0) continue outer; break outer; } finally { log.push("finally " + i); }
      }
    }
    ${nest(i => `{ await using r${i} = res("r${i}");\n`, 'log.push("innermost");', "}", 20)}
    return log.join("|");`;
  print("async", "=>", await new AsyncFunction("log", source)(log));
  try { await new AsyncFunction("log", "for await (using x of [1]) ;")(log); } catch (error) { print("for await using", "=>", (error as Error).name); }
}
asynchronous().catch(error => print("async failed", String(error)));
