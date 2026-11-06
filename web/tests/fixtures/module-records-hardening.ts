// Imports a small ES module and CommonJS graph through createModuleRecords and the real
// loader after replacing the built-ins user code could (array, map, set and promise methods,
// and a thenable Object.prototype). Run in its own process: the replacements would break any
// test runner. Prints the outcome after restoring them.
import { loaderSource } from "../../../scripts/esm-loader-harness.ts";
import { createModuleRecords, type LoaderFactory, type ModuleRecord, type Then } from "../../src/module-records.ts";

// oxlint-disable-next-line no-eval -- Evaluates the loader factory like the engine host does.
const factory = (0, eval)(`(${loaderSource()})`) as LoaderFactory;
const then = Function.prototype.call.bind(Promise.prototype.then) as Then;
const seen: unknown[] = [];
const modules: Record<string, ModuleRecord> = {
  "/main.mjs": {
    r: ["/dep.mjs", "/lib.cjs"], i: [[0, "x"], [1, "y"]], x: [], s: [], e: [], a: true,
    // Module code itself would see the replaced built-ins, so it assigns by index.
    f: function* (api) { api.l({}); yield; const views = (api as unknown as { n: Record<string, unknown>[] }).n; yield; yield null; seen[0] = views[0]!.x; seen[1] = views[1]!.y; } as ModuleRecord["f"],
  },
  "/dep.mjs": { r: [], i: [], x: [], s: [], e: [["x", "x"]], a: false, f: function* (api) { const x = 1; api.l({ x: () => x }); yield; yield; } },
};
const records = createModuleRecords({
  record: key => key in modules ? { format: "esm", record: key } : { format: "cjs" },
  evaluate: (code, _key, done) => { queueMicrotask(() => done(modules[code]!)); },
  handoff: () => { const value = { y: 2 }; return { value, default: value }; },
  keys: value => Object.keys(value as object),
  initMeta() {},
  resolve: specifier => specifier,
  active: () => true,
  track: operation => operation,
}, factory, then);

const saved = {
  map: Array.prototype.map, push: Array.prototype.push, get: Map.prototype.get, set: Map.prototype.set,
  has: Set.prototype.has, add: Set.prototype.add, then: Promise.prototype.then,
};
function restore(): void {
  Object.defineProperties(Array.prototype, { map: { value: saved.map }, push: { value: saved.push } });
  Object.defineProperties(Map.prototype, { get: { value: saved.get }, set: { value: saved.set } });
  Object.defineProperties(Set.prototype, { has: { value: saved.has }, add: { value: saved.add } });
  Object.defineProperty(Promise.prototype, "then", { value: saved.then });
  delete (Object.prototype as Record<string, unknown>).then;
}
const bomb = (name: string) => ({ value: function () { throw new Error(`patched ${name}`); } });
// Returns nothing: a reaction returning Bun's timer object would be resolved as a thenable.
const finish = (outcome: string): void => {
  setTimeout(() => {
    restore();
    console.log(outcome);
  }, 0);
};
// After this module finished evaluating: Bun settles its own module promises with objects,
// which the thenable Object.prototype would capture.
setTimeout(() => {
  Object.defineProperties(Array.prototype, { map: bomb("map"), push: bomb("push") });
  Object.defineProperties(Map.prototype, { get: bomb("get"), set: bomb("set") });
  Object.defineProperties(Set.prototype, { has: bomb("has"), add: bomb("add") });
  Object.defineProperty(Promise.prototype, "then", bomb("then"));
  Object.defineProperty(Object.prototype, "then", { ...bomb("thenable"), configurable: true, writable: true });
  saved.then.call(records.importKey("/main.mjs"),
    namespace => finish(`${String((namespace as Record<symbol, unknown>)[Symbol.toStringTag])} ${seen.join(",")}`),
    error => finish(`error ${(error as Error).message}`));
}, 0);
