// Recursion probe for scripts/measure-stack.py and web/tests/browser-stack.mjs.
// `bun run stack-depth.js <mode> <n>` nests one recursive path n levels deep and prints
// "completed" or "caught <error name>", then "continued"; a wasm trap prints neither.
const mode = process.argv[2];
const n = +process.argv[3];
const nest = (open, close) => open.repeat(n) + close.repeat(n);
function deepObject() { let o = {}; for (let i = 0; i < n; i++) o = { child: o }; return o; }
function deepArray() { let a = []; for (let i = 0; i < n; i++) a = [a]; return a; }
const actions = {
  plain() { let d = 0; const f = () => (++d === n ? 0 : 1 + f()); f(); },
  getter() { let d = 0; const o = { get v() { return ++d === n ? 0 : 1 + o.v; } }; void o.v; },
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
actions.promise = async () => { let d = 0; const f = () => (++d === n ? 0 : 1 + f()); await Promise.resolve().then(f); };
actions.async = async () => { let d = 0; const f = async () => { if (++d < n) await f(); }; await f(); };
(async () => {
  try { await actions[mode](); console.log('completed', mode, n); }
  catch (error) { console.log('caught', mode, error.name, n, error.message); }
  console.log('continued');
})();
