// AsyncLocalStorage across `await` in code compiled at run time. Next.js's
// development server runs every server module through a direct eval
// (webpack's `eval-source-map` devtool), with its sourceURL comment.
import { AsyncLocalStorage } from "node:async_hooks";
import Module from "node:module";
import vm from "node:vm";

type Compiled = Module & { _compile(code: string, filename: string): void };
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

const AsyncFunction = (async () => {}).constructor as FunctionConstructor;
const compiled = new Module("/compiled.js") as Compiled;
compiled._compile("module.exports = async (get, tick) => { await tick(); return get(); };", "/compiled.js");
const probe = (value: unknown) => value as Probe;

const cases: Record<string, () => Promise<unknown>> = {
  "direct eval": () => direct(),
  "for await in eval": () => loops(),
  "Function": () => probe(new Function("get", "tick", "return (async () => { await tick(); return get(); })()"))(get, tick),
  "AsyncFunction": () => probe(new AsyncFunction("get", "tick", "await tick(); return get();"))(get, tick),
  "vm.runInThisContext": () => probe(vm.runInThisContext("(async (get, tick) => { await tick(); return get(); })"))(get, tick),
  "vm.runInNewContext": () => vm.runInNewContext("(async () => { await tick(); return get(); })()", { get, tick }),
  "Module#_compile": () => probe(compiled.exports)(get, tick),
};

for (const [name, run] of Object.entries(cases)) {
  const result = await als.run(name, run).catch(String);
  console.log(`${name}: ${result}`);
}
console.log(`outside: ${get()}`);
