// Node's process warnings as Bun has them: the default 'warning' listener and its stderr
// format, emitWarning's options and argument errors, the read-only flag aliases,
// NODE_NO_WARNINGS, --disable-warning (also through BUN_OPTIONS) and the trace flags.
import { spawnSync } from "node:child_process";

function run(name: string, flags: string[], source: string, extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Object.assign({}, process.env, extraEnv))) {
    if (value !== undefined && !["NODE_NO_WARNINGS", "BUN_OPTIONS", "NODE_REDIRECT_WARNINGS"].includes(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) if (value !== undefined) env[key] = value;
  const child = spawnSync(process.execPath, flags.concat(["-e", source]), { env, encoding: "utf8" });
  // The pid and the program name in the trace hint vary by run and launcher.
  const stderr = child.stderr.replace(/\(node:\d+\)/g, "(node:PID)").replace(/\(Use `[^`]*? --trace-warnings/g, "(Use `PROGRAM --trace-warnings");
  console.log(`--- ${name} (exit ${child.status})`);
  if (child.stdout) console.log(`stdout: ${JSON.stringify(child.stdout)}`);
  console.log(`stderr: ${JSON.stringify(stderr)}`);
}

run("default listener", [], `const [onWarning, ...rest] = process.listeners("warning");
console.log(process.listenerCount("warning"), onWarning.name, rest.length);
process.on("warning", () => process.stderr.write("user-listener\\n"));
process.emitWarning("shown");
process.emitWarning("second");`);

run("removeAllListeners before the first warning", [], `process.removeAllListeners("warning");
process.emitWarning("hidden");`);

run("removeListener by reference", [], `process.removeListener("warning", process.listeners("warning")[0]);
console.log(process.listenerCount("warning"));
process.emitWarning("hidden");`);

run("bare emit", [], `process.emit("warning", new Error("bare"));`);

run("options object", [], `process.emitWarning("msg", { type: "CustomWarning", code: "C1", detail: "more detail" });
process.on("warning", w => console.log(w.name, w.code, w.detail, Object.keys(w).length, Object.getOwnPropertyDescriptor(w, "code").enumerable));`);

run("type and code arguments", [], `process.emitWarning("two", "OtherWarning", "C2");
process.emitWarning(new Error("error instance"));`);

run("argument errors", [], `for (const args of [[1], ["x", 5], ["x", "T", 5], ["x", null]]) {
  try { process.emitWarning(...args); } catch (e) { console.log(e.code, e.message); }
}`);

for (const [flag, property] of [
  ["--no-deprecation", "noDeprecation"],
  ["--throw-deprecation", "throwDeprecation"],
  ["--trace-deprecation", "traceDeprecation"],
  ["--trace-warnings", "traceProcessWarnings"],
  ["--pending-deprecation", "pendingDeprecation"],
  ["--no-warnings", "noProcessWarnings"],
]) {
  run(`${flag} alias`, [flag], `const d = Object.getOwnPropertyDescriptor(process, ${JSON.stringify(property)});
let threw = false;
try { process[${JSON.stringify(property)}] = false; } catch { threw = true; }
console.log(JSON.stringify({ d, after: process[${JSON.stringify(property)}], threw }));`);
}

run("unflagged aliases", [], `console.log(["throwDeprecation", "traceDeprecation", "traceProcessWarnings", "pendingDeprecation", "noProcessWarnings"].map(k => Object.hasOwn(process, k)).join(","));`);

run("--no-deprecation hides deprecations only", ["--no-deprecation"], `process.emitWarning("dep", "DeprecationWarning");
process.emitWarning("other");`);

run("--no-warnings keeps user listeners", ["--no-warnings"], `console.log(process.listenerCount("warning"));
process.on("warning", w => console.log("user:" + w.message));
process.emitWarning("quiet");`);

run("NODE_NO_WARNINGS=1", [], `console.log(process.listenerCount("warning")); process.emitWarning("foo");`, { NODE_NO_WARNINGS: "1" });
run("NODE_NO_WARNINGS=true", [], `console.log(process.listenerCount("warning")); process.emitWarning("foo");`, { NODE_NO_WARNINGS: "true" });

run("--disable-warning", ["--disable-warning=TESTCODE", "--disable-warning=OtherWarning"], `process.on("warning", w => console.log("listener:" + (w.code || w.name)));
process.emitWarning("hi", { code: "TESTCODE" });
process.emitWarning("by name", "OtherWarning");
process.emitWarning("shown", "ThirdWarning");`);

const twoDeprecations = `process.emitWarning("one", { type: "DeprecationWarning", code: "DEP1" });
process.emitWarning("two", { type: "DeprecationWarning", code: "DEP2" });`;
run("BUN_OPTIONS --disable-warning", [], twoDeprecations, { BUN_OPTIONS: "--disable-warning=DEP2" });
run("BUN_OPTIONS --disable-warning in a worker", [], `new (require("node:worker_threads").Worker)(${JSON.stringify(twoDeprecations)}, { eval: true });`, { BUN_OPTIONS: "--disable-warning=DEP2" });

run("worker default listener", [], `const { Worker } = require("node:worker_threads");
new Worker(${JSON.stringify(`const { parentPort } = require("node:worker_threads");
const before = process.listenerCount("warning");
process.removeAllListeners("warning");
process.emitWarning("hidden-in-worker");
setImmediate(() => parentPort.postMessage(before + ":" + process.listenerCount("warning")));`)}, { eval: true }).on("message", m => console.log(m));`);

const stackReads = `let hits = 0;
const err = new Error("hello");
err.name = "Warning";
Object.defineProperty(err, "stack", { get() { hits++; return "Warning: hello\\n    at fake"; } });
process.on("warning", () => process.nextTick(() => console.log("hits:" + hits)));
process.emitWarning(err);`;
run("stack untouched without tracing", [], stackReads);
run("--trace-warnings prints the stack", ["--trace-warnings"], stackReads);
run("traceDeprecation set at runtime", [], `process.traceDeprecation = true;
const warning = new Error("traced");
warning.name = "DeprecationWarning";
Object.defineProperty(warning, "stack", { value: "DeprecationWarning: traced\\n    at fixed" });
process.emitWarning(warning);
process.emitWarning("other type is not traced");`);
