// Recursion probe for scripts/measure-stack.py and web/tests/browser-stack.mjs.
// `bun run stack-depth.js <mode> <n>` nests one recursive path n levels deep and prints
// "completed" or "caught <error name>", then "continued"; a wasm trap prints neither.
// `chainCapacity <n>` also prints "capacities <JSON>": the deepest nesting each parser chain completes.
// `chainWorker <n>` prints "ownership <JSON>": the same capacities for a parent around a Worker child.
// Every run first prints "settings <JSON>": the stack budget and parser reserve in its environment.
const mode = process.argv[2];
const n = +process.argv[3];
const nest = (open, close) => open.repeat(n) + close.repeat(n);
function deepObject() { let o = {}; for (let i = 0; i < n; i++) o = { child: o }; return o; }
function deepArray() { let a = []; for (let i = 0; i < n; i++) a = [a]; return a; }
const actions = {
  plain() { let d = 0; const f = () => (++d === n ? 0 : 1 + f()); f(); },
  getter() { let d = 0; const o = { get v() { return ++d === n ? 0 : 1 + o.v; } }; void o.v; },
  // The same getter read through a key the compiler cannot see, so JSC calls it from C++
  // (docs/stack-limits.md): `getter` no longer measures that reentry there.
  computedgetter() { let d = 0; const key = ['v'][0]; const o = { get v() { return ++d === n ? 0 : 1 + o[key]; } }; void o[key]; },
  proxy() { let d = 0; const p = new Proxy({}, { get() { return ++d === n ? 0 : 1 + p.v; } }); void p.v; },
  json() { JSON.stringify(deepObject(), (k, v) => v); },
  jsonplain() { JSON.stringify(deepObject()); },
  jsonparse() { JSON.parse(nest('[', ']')); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  parse() { (0, eval)(nest('[', ']')); },
  proxychain() { let p = { v: 1 }; for (let i = 0; i < n; i++) p = new Proxy(p, {}); void p.v; },
  bound() { let f = function () { return 1; }; for (let i = 0; i < n; i++) f = f.bind(null); f(); },
  join() { String(deepArray()); },
  flat() { deepArray().flat(Infinity); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  block() { (0, eval)(nest('{', '}')); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  arrow() { (0, eval)('(() => '.repeat(n) + '0' + ')'.repeat(n)); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  unary() { (0, eval)('!'.repeat(n) + '0'); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  power() { (0, eval)('1**'.repeat(n) + '1'); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  ternary() { (0, eval)('0?0:'.repeat(n) + '0'); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  statement() { (0, eval)('if(0)'.repeat(n) + ';'); },
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  awaitchain() { (0, eval)('(async function () { ' + 'await '.repeat(n) + '0; })'); },
  regexpnc() { new RegExp(nest('(?:', ')')).exec('a'); },
  lookahead() { new RegExp('(?=a'.repeat(n) + ')'.repeat(n)).exec('a'); },
  reviver() { JSON.parse(nest('[', ']'), (k, v) => v); },
  isarray() { let p = []; for (let i = 0; i < n; i++) p = new Proxy(p, {}); Array.isArray(p); },
  tostring() { let d = 0; const o = { toString() { return ++d === n ? '' : `${o}`; } }; String(o); },
};
// The console recursion control (upstream console-constructor-exception.test.ts): every level
// swallows the overflow and touches console.Console, so this completes unless the host traps.
actions.console = () => {
  let d = 0;
  const f = () => { if (++d === n) return; try { f(); } catch { try { void console.Console; } catch {} } };
  f();
};
// Nested CommonJS loads: n generated modules that each require the next, written under
// STACK_DEPTH_DIR (or the temp directory) and removed again. With STACK_DEPTH_LEAF the last
// one requires that specifier, so a real package loads below n loader levels.
actions.require = () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(process.env.STACK_DEPTH_DIR || require('node:os').tmpdir(), 'stack-depth-require-'));
  const leaf = process.env.STACK_DEPTH_LEAF;
  const body = (next) => (next ? `module.exports = require(${JSON.stringify(next)});\n` : 'module.exports = 0;\n');
  try {
    for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, `m${i}.cjs`), body(i < n ? `./m${i + 1}.cjs` : leaf));
    const head = n > 0 ? path.join(dir, 'm1.cjs') : leaf;
    if (head) require(head);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
// The names walk of Ajv 8.17.1's code generator (lib/compile/codegen/index.ts, MIT), reduced to
// its recursion: n nested `if` nodes, each read through `node.names` in a reduce callback and
// through `super.names` in the subclass getter. Eight condition names keep the merges small.
actions.ajvnames = () => {
  const addNames = (names, from) => { for (const name in from) names[name] = (names[name] || 0) + from[name]; return names; };
  class Node { get names() { return {}; } }
  class ParentNode extends Node {
    constructor(nodes = []) { super(); this.nodes = nodes; }
    get names() { return this.nodes.reduce((names, node) => addNames(names, node.names), {}); }
  }
  class BlockNode extends ParentNode {}
  class If extends BlockNode {
    constructor(condition) { super(); this.condition = condition; }
    get names() { const names = super.names; names[this.condition] = (names[this.condition] || 0) + 1; return names; }
  }
  const root = new ParentNode();
  let parent = root;
  for (let i = 0; i < n; i++) { const next = new If(`c${i % 8}`); parent.nodes.push(next); parent = next; }
  const total = Object.values(root.names).reduce((sum, count) => sum + count, 0);
  if (total !== n) throw new Error(`ajvnames counted ${total} of ${n} conditions`);
};
// The real package: STACK_DEPTH_AJV_CODEGEN names ajv/dist/compile/codegen/index.js of an installed
// Ajv 8, and the walk is the one `CodeGen.optimize` starts. Not part of the default sweep.
actions.ajv = () => {
  const { CodeGen, ValueScope, _ } = require(process.env.STACK_DEPTH_AJV_CODEGEN);
  const gen = new CodeGen(new ValueScope({ scope: {} }), {});
  for (let i = 0; i < n; i++) gen.if(_`c${i}`);
  void gen._root.names;
};
// Parser chains, one source shape per recursion in an engine's parser (docs/stack-limits.md). Each
// is a function body. "Compile" only constructs the function, which syntax-checks the body; "Call"
// also runs it, which parses the body in full and generates its code. "16" adds one character
// outside Latin-1, so the engine reads a 16-bit source.
const chains = {
  Assign: (depth) => 'var o = {};\n' + 'o.a = '.repeat(depth) + '0;',
  Conditional: (depth) => 'var x = 0;\nreturn ' + 'x ? 0 : '.repeat(depth) + '0;',
  Block: (depth) => '{'.repeat(depth) + '}'.repeat(depth),
  Call: (depth) => 'var f = function (v) { return v; };\nreturn ' + 'f('.repeat(depth) + '0' + ')'.repeat(depth) + ';',
  Function: (depth) => 'return ' + '(function () { return '.repeat(depth) + '0' + '; })'.repeat(depth) + ';',
};
const chainModes = {};
function addChainMode(kind, pass, width) {
  chainModes[`chain${kind}${pass}${width}`] = (depth = n) => {
    const compiled = new Function((width === '16' ? '/* ☃ */' : '') + chains[kind](depth));
    if (pass === 'Call') compiled();
  };
}
for (const kind of Object.keys(chains)) {
  for (const pass of ['Compile', 'Call']) ['8', '16'].forEach((width) => addChainMode(kind, pass, width));
}
Object.assign(actions, chainModes);
function chainCompletes(attempt, depth) {
  try { attempt(depth); return true; }
  catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError || error.name === 'InternalError') return false;
    throw error;
  }
}
function chainCapacity(attempt) {
  if (chainCompletes(attempt, n)) return n;
  let low = 0;
  let high = n;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (chainCompletes(attempt, middle)) low = middle;
    else high = middle;
  }
  return low;
}
// Every chain's capacity from one guest: the parser's refusal is catchable, so the search runs in
// process and prints one JSON line before the usual result. n is the deepest nesting tried.
function chainCapacities() {
  const capacities = {};
  for (const [name, attempt] of Object.entries(chainModes)) capacities[name] = chainCapacity(attempt);
  return capacities;
}
// Leave the loader's synchronous calls before comparing capacities across contexts.
actions.chainCapacity = async () => { await Promise.resolve(); console.log('capacities', JSON.stringify(chainCapacities())); };
// A parent and a Worker of this file in one run: the parent's capacities before the child starts
// and after it exits, around the child's own `chainCapacity` output. STACK_DEPTH_WORKER_ENV is a
// JSON object merged into the child's copy of the environment; a null value removes that key.
function workerEnvironment() {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(JSON.parse(process.env.STACK_DEPTH_WORKER_ENV || '{}'))) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  delete env.STACK_DEPTH_WORKER_ENV;
  return env;
}
actions.chainWorker = async () => {
  const { Worker } = require('node:worker_threads');
  await Promise.resolve();
  const before = chainCapacities();
  const worker = new Worker(__filename, { argv: ['chainCapacity', String(n)], env: workerEnvironment(), stdout: true });
  let output = '';
  worker.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { worker.on('error', reject); worker.on('exit', resolve); });
  // A terminal trims the spaces that end a wrapped row, so the child's transcript travels encoded.
  console.log('ownership', JSON.stringify({ before, child: { code, output: encodeURIComponent(output) }, after: chainCapacities() }));
};
actions.promise = async () => { let d = 0; const f = () => (++d === n ? 0 : 1 + f()); await Promise.resolve().then(f); };
actions.async = async () => { let d = 0; const f = async () => { if (++d < n) await f(); }; await f(); };
(async () => {
  // What this guest was given, so a measurement can record the settings that were in effect.
  const { BUN_WASM_STACK_KIB: budget = null, BUN_WASM_JSC_PARSER_RESERVE: parserReserve = null } = process.env;
  console.log('settings', JSON.stringify({ budget, parserReserve }));
  try { await actions[mode](); console.log('completed', mode, n); }
  catch (error) { console.log('caught', mode, error.name, n, error.message); }
  console.log('continued');
})();
