// AsyncLocalStorage across `await` in code compiled at run time. Next.js's
// development server runs every server module through a direct eval
// (webpack's `eval-source-map` devtool), with its sourceURL comment.
import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";

type Probe = (get: () => unknown, tick: () => Promise<void>) => Promise<unknown>;

const als = new AsyncLocalStorage<string>();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
const get = () => als.getStore();
async function* numbers() {
  yield 1;
  await tick();
  yield 2;
}

const direct: () => Promise<string> = eval(`(async function direct() {
  await tick();
  const first = get()
  await tick()
  return \`\${first} \${await Promise.resolve(get())}\`;
})
//# sourceURL=webpack-internal:///./direct.js`);

const loops: () => Promise<string> = eval(`(async () => {
  const seen = [];
  outer: for await (const n of numbers()) {
    seen.push(n + ":" + get());
    if (n === 1) continue outer;
  }
  for await (const n of numbers()) seen.push(n + ":" + get());
  seen.push("after:" + get());
  return seen.join(" ");
})`);

const nested: () => Promise<unknown> = eval(`(async () => {
  await tick();
  return eval("(async () => { await tick(); return get(); })()");
})`);

// A string built at run time may hold a lone surrogate; the hooks keep it.
const lone: () => Promise<string> = eval(
  "(async () => { await tick(); return get() + ' ' + '" + String.fromCharCode(0xd800) + "'.charCodeAt(0); })",
);

const AsyncFunction = (async () => {}).constructor as FunctionConstructor;
const probe = (value: unknown) => value as Probe;

const cases: Record<string, () => Promise<unknown>> = {
  "direct eval": () => direct(),
  "for await in eval": () => loops(),
  "eval in eval": () => nested(),
  "lone surrogate": () => lone(),
  "Function": () => probe(new Function("get", "tick", "return (async () => { await tick(); return get(); })()"))(get, tick),
  "AsyncFunction": () => probe(new AsyncFunction("get", "tick", "await tick(); return get();"))(get, tick),
  "vm.runInThisContext": () => probe(vm.runInThisContext("(async (get, tick) => { await tick(); return get(); })"))(get, tick),
  "vm.runInNewContext": () => vm.runInNewContext("(async () => { await tick(); return get(); })()", { get, tick }),
};

for (const [name, run] of Object.entries(cases)) {
  const result = await als.run(name, run).catch(String);
  console.log(`${name}: ${result}`);
}
console.log(`outside: ${get()}`);
