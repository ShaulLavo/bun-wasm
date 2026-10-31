import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import vm from "node:vm";
const source = readFileSync("/rejection/index.ts", "utf8").replace('import { AsyncLocalStorage } from "node:async_hooks";', "");
const code = new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(source);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const wrapper = `(async function (AsyncLocalStorage) { ${code}\n})`;
const routes = {
  constructor: () => AsyncFunction("AsyncLocalStorage", code),
  // oxlint-disable-next-line no-eval -- Exercise direct eval of the actual rejection fixture.
  eval: () => eval(wrapper),
  vm: () => vm.runInThisContext(wrapper, { filename: "prepared-rejection-vm.js" }),
};
const route = process.argv[2];
if (route !== "constructor" && route !== "eval" && route !== "vm") throw new Error("expected constructor, eval or vm route");
await routes[route]()(AsyncLocalStorage);
