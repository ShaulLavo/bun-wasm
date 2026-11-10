// Generated code nests statements far deeper than people write them: a compiled schema validator
// opens one `if` block per property. Compiling that must fit the 32 KiB QuickJS stack budget a
// browser off V8 passes (docs/stack-limits.md), and the compiled code must behave the same.
// Where QuickJS's own parser compiles the source, the child runs with that budget. JSC reads the
// same variable and has its own parser limits, so other engines and native Bun keep the budget
// they were started with and only have to produce the same output.
const { spawnSync }: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");

// process.versions is the same on every engine, so the parser is recognised by the wording of
// one of its own early errors.
function quickjsParser(): boolean {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  try { (0, eval)("let let = 1"); } catch (error) { return (error as Error).message === "'let' is not a valid lexical identifier"; }
  return false;
}

const properties = 200;
const levels = 300;
type Validator = (value: unknown) => string;

// One `if (ok) {` per property, each holding the next, like ajv's generated validators.
function validatorBody(count: number): string {
  let open = 'let ok = true;\nif (!value || typeof value !== "object") return "type";\n';
  for (let i = 0; i < count; i++) {
    open += `if (ok) {\nif (value.p${i} !== undefined) {\nconst seen = ok;\nif (typeof value.p${i} !== "number") return "p${i}";\nok = seen;\n} else ok = true;\n`;
  }
  return `${open}${"}".repeat(count)}\nreturn "valid";`;
}

function report(name: string, validate: Validator): void {
  const full: Record<string, unknown> = {};
  for (let i = 0; i < properties; i++) full[`p${i}`] = i;
  const results = [
    validate(full), validate({}), validate(null),
    validate({ ...full, p0: "x" }), validate({ ...full, p100: "x" }), validate({ ...full, p199: "x" }),
  ];
  console.log(name, results.join(" "));
}

function nest(open: (level: number) => string, inner: string, close: string, count = levels): string {
  let source = "";
  for (let i = 0; i < count; i++) source += open(i);
  return source + inner + close.repeat(count);
}

function run(body: string, ...args: unknown[]): unknown {
  return new Function("log", "input", body)([], ...args);
}

function errorName(source: string): string {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  try { (0, eval)(source); return "accepted"; } catch (error) { return (error as Error).name; }
}

async function validators(): Promise<void> {
  const body = validatorBody(properties);
  const expression = `function validate(value) {\n${body}\n}`;
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  const evaluated = (0, eval)(`(${expression})`) as Validator;
  report("eval", evaluated);
  console.log("eval source kept", evaluated.toString() === expression);
  // The constructor's own source text differs between engines, so only its behaviour is shared.
  report("constructor", new Function("value", body) as Validator);
  fs.writeFileSync("validator.cjs", `module.exports = ${expression};\n`);
  report("require", require(path.join(process.cwd(), "validator.cjs")));
  fs.writeFileSync("validator.mjs", `export default ${expression};\n`);
  report("import", (await import(path.join(process.cwd(), "validator.mjs"))).default);
}

function statementKinds(): void {
  console.log("block", run(nest(i => `{ let v${i} = ${i};\n`, "log.push(v0 + v299);", "}") + "return log[0];"));
  const chain = nest(i => `if (input === ${i}) return "branch ${i}"; else `, 'return "none";', "");
  console.log("else if", run(chain, 0), run(chain, 299), run(chain, 300));
  console.log("if", run(nest(() => "if (input) ", 'return "then"; return "skipped";', ""), 1), run(nest(() => "if (input) ", 'return "then"; return "skipped";', ""), 0));
  console.log("while", run(nest(i => `l${i}: while (true) {\n`, 'log.push("inner"); break l0;', "}") + "return log.length;"));
  console.log("do", run(nest(() => "do {\n", "log.push(1);", "} while (false);") + "return log.length;"));
  console.log("for", run(nest(i => `for (let i${i} = 0; i${i} < 2; i${i}++) {\n`, "log.push(1);", "}", 8) + "return log.length;"));
  console.log("for in", run(nest(i => `for (const k${i} in input) {\n`, "log.push(k0 + k39);", "}", 40) + "return log.join();", { a: 1 }));
  console.log("for of", run(nest(i => `for (const v${i} of input) {\n`, "log.push(v0 + v39);", "}", 40) + "return log.join();", [7]));
  console.log("label", run(nest(i => `l${i}: {\n`, 'log.push("in"); break l1; log.push("skipped");', "}") + "return log.join();"));
  console.log("switch", run(nest(() => "switch (input) { case 1:\n", 'log.push("case");', "}", 100) + "return log.join();", 1));
  const tries = nest(i => `try {\n`, 'log.push("body");', "", 100) + Array.from({ length: 100 }, (_, i) => `} finally { log.push(${i}); }`).join("\n");
  console.log("try", run(tries + "return [log.length, log[0], log[1], log[100]].join();"));
  const catches = nest(() => "try {\n", 'throw new Error("deep");', "", 100) + Array.from({ length: 100 }, (_, i) => `} catch (error) { log.push(${i}); throw error; }`).join("\n");
  console.log("catch", run(`try { ${catches} } catch (error) { return [log.length, log[0], log[99], error.message].join(); }`));
  console.log("with", run(nest(() => "with (input) {\n", "log.push(marker);", "}", 40) + "return log.join();", { marker: "scoped" }));
}

function semantics(): void {
  // oxlint-disable-next-line no-eval -- Statement completion values are only observable through eval.
  console.log("finally completion", (0, eval)("try { 1; } finally { 2; }"), (0, eval)("out: { try { 3; break out; } finally { 4; } }"));
  console.log("throw survives finally", run('try { try { throw new Error("kept"); } finally { log.push("finally"); } } catch (error) { return log.concat(error.message).join(); }'));
  console.log("labels across finally", run('outer: for (let i = 0; i < 4; i++) { try { if (i === 1) continue outer; if (i === 3) break outer; log.push("body" + i); } finally { log.push("finally" + i); } log.push("after" + i); } return log.join();'));
  const iterator = 'const it = { [Symbol.iterator]() { return { next() { log.push("next"); return { done: false, value: 1 }; }, return() { log.push("return"); return {}; } }; } };';
  console.log("iterator break", run(`${iterator} for (const v of it) { log.push("body"); break; } return log.join();`));
  console.log("iterator throw", run(`${iterator} try { for (const v of it) { log.push("body"); throw new Error("x"); } } catch { log.push("caught"); } return log.join();`));
  console.log("iterator labelled continue", run(`${iterator} outer: for (let i = 0; i < 2; i++) { for (const v of it) { log.push("body" + i); continue outer; } } return log.join();`));
  console.log("header function", run('outer: for (const f of [function () { inner: for (;;) { break inner; } return "h"; }]) { log.push(f()); continue outer; } return log.join();'));
  console.log("strict block function", errorName('"use strict"; { function scoped() {} } scoped;'));
  // oxlint-disable-next-line no-eval -- Annex B function hoisting is only observable in sloppy script code.
  console.log("sloppy block function", (0, eval)("{ function hoisted() {} } typeof hoisted"));
  console.log("declaration contexts", [
    errorName("if (1) function a() {}"), errorName('"use strict"; if (1) function b() {}'),
    errorName("l: function c() {}"), errorName('"use strict"; l: function d() {}'),
    errorName("while (0) function e() {}"), errorName("if (1) class F {}"), errorName("if (1) const g = 1;"),
    errorName("l: l: ;"), errorName("do function h() {} while (0)"),
  ].join(" "));
}

function positions(): void {
  const lines = Array.from({ length: levels }, () => "{").concat(['throw new Error("innermost");'], Array.from({ length: levels }, () => "}"));
  fs.writeFileSync("deep-throw.cjs", `module.exports = function deepThrow() {\n${lines.join("\n")}\n};\n`);
  try { require(path.join(process.cwd(), "deep-throw.cjs"))(); } catch (error) {
    console.log("error position", (error as Error).message, /deep-throw\.cjs:302:\d+/.test(String((error as Error).stack)));
  }
}

async function main(): Promise<void> {
  await validators();
  statementKinds();
  semantics();
  positions();
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  console.log("continued", (0, eval)("21 * 2"));
}

if (process.argv[2] === "compile") {
  void main();
} else {
  const env = quickjsParser() ? { ...process.env, BUN_WASM_STACK_KIB: "32" } : process.env;
  const child = spawnSync(process.execPath, [__filename, "compile"], { env, encoding: "utf8" });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) throw new Error(`statement nesting child exited ${child.status}`);
}
